/**
 * Hashline editing — edit files by line hash instead of text find-and-replace.
 *
 * Registered as "edit", overriding the built-in find-and-replace edit tool
 * so the agent always edits by line hash.
 *
 * action=view prints every line with a short hash that is unique per line
 * position and remembers the exact file content for this session.
 * action=replace then swaps lines or regions referenced by those hashes.
 *
 * Safety properties:
 * - Hashes are salted with the line position, so identical-looking lines
 *   still get distinct hashes.
 * - Replace verifies the file still matches the last view before touching
 *   it; if anything changed it fails with a clear error instead of editing
 *   the wrong line.
 * - All edits in one call are resolved against the viewed content and
 *   applied in a single write.
 *
 * Region edits replace everything strictly between two boundary lines
 * (both boundaries are kept). Adjacent boundaries insert newText between
 * them (a lone "\n" in newText is one blank line). An empty newText
 * deletes the block. Omitting startHash/endHash means the top/bottom of
 * the file.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import {
	defineTool,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";

const HASH_LENGTH = 12;
const DEFAULT_VIEW_LIMIT = 2000;

type Snapshot = {
	/** Raw file content (BOM stripped), used to detect changes since the last view. */
	content: string;
	/** File content split into lines without the trailing newline entry. */
	lines: string[];
	/** Detected line separator: "\n" or "\r\n". */
	lineEnding: string;
	hasTrailingNewline: boolean;
	/** Short fingerprint of the content, shown in views and error messages. */
	fileHash: string;
	/** Line hash -> 0-based line index. */
	hashToIndex: Map<string, number>;
};

type EditInput = {
	hash?: string;
	startHash?: string;
	endHash?: string;
	newText: string;
};

type ResolvedEdit = {
	/** First replaced line index, inclusive (0-based). */
	start: number;
	/** One past the last replaced line (exclusive). */
	end: number;
	replacement: string[];
};

type EditToolDetails = {
	lines?: number;
	shown?: number;
	editsApplied?: number;
	linesBefore?: number;
	linesAfter?: number;
};

const editSchema = Type.Object({
	hash: Type.Optional(
		Type.String({
			description:
				"Single-line mode. The 12-character hex hash of one line from a previous view (hash only, without the line number or │). Replaces that line with newText (which may span multiple lines). Do not set startHash or endHash in the same entry.",
		}),
	),
	startHash: Type.Optional(
		Type.String({
			description:
				"Region mode. The 12-character hex hash of the boundary line just above a region to change. Everything strictly below this line and above the endHash line is replaced with newText. The boundary line itself is kept. Omit to start at the top of the file. Do not set hash in the same entry.",
		}),
	),
	endHash: Type.Optional(
		Type.String({
			description:
				"Region mode. The 12-character hex hash of the boundary line just below a region to change. The boundary line itself is kept. Omit to end at the bottom of the file. Do not set hash in the same entry.",
		}),
	),
	newText: Type.String({
		description:
			"Replacement text; may span multiple lines. Empty string deletes the region. When the region is empty (adjacent boundary lines) newText is inserted between them; a lone newline is one blank line.",
	}),
});

const schema = Type.Object({
	action: StringEnum(["view", "replace"] as const, {
		description: "view a file to get per-line hashes, or replace lines by those hashes",
	}),
	path: Type.String({ description: "Path to the file (relative or absolute)" }),
	offset: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-indexed line number to start showing from (view only)" }),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, description: `Maximum lines to show (view only, default ${DEFAULT_VIEW_LIMIT})` }),
	),
	fileHash: Type.Optional(
		Type.String({
			description:
				"Fingerprint returned by a previous view call. When given, replace refuses to apply unless the file still matches it.",
		}),
	),
	edits: Type.Optional(
		Type.Array(editSchema, {
			description:
				"Edits to apply (replace only). Each entry uses exactly one mode: hash (replace one line) OR startHash/endHash (replace a region); never both. Every hash must come from a previous view of this path. Edits are resolved against the viewed content, not against each other, and must not overlap.",
		}),
	),
});

function lineHash(index: number, content: string): string {
	return createHash("sha256").update(`${index}:${content}`).digest("hex").slice(0, HASH_LENGTH);
}

function fileHashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH);
}

function buildSnapshot(content: string): Snapshot {
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
	const split = content.split(/\r?\n/);
	const hasTrailingNewline = content.endsWith("\n");
	// A trailing newline yields one empty trailing element; drop it so it
	// never appears as an editable line (it is restored implicitly on write).
	// Fully empty content has no lines at all.
	const lines = content === "" ? [] : hasTrailingNewline ? split.slice(0, -1) : split;
	const hashToIndex = new Map<string, number>();
	lines.forEach((line, index) => hashToIndex.set(lineHash(index, line), index));
	return { content, lines, lineEnding, hasTrailingNewline, fileHash: fileHashOf(content), hashToIndex };
}

/** Convert newText into the lines that replace the region, in the file's line ending. */
function toReplacementLines(newText: string, lineEnding: string): string[] {
	if (newText === "") return [];
	const normalized = newText.replace(/\r\n?/g, "\n").split("\n").join(lineEnding);
	const parts = normalized.split(lineEnding);
	// A trailing newline in newText must not add an extra blank line.
	if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

/** Accept both the edits[] array and a single edit object (prepareArguments is pi-only; SDK callers may skip it). */
function normalizeEdits(edits: unknown): EditInput[] {
	if (edits === undefined || edits === null) return [];
	if (Array.isArray(edits)) return edits as EditInput[];
	return [edits as EditInput];
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function readStrippedBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function unknownHashError(hash: string): Error {
	return new Error(
		`Unknown line hash "${hash}". It may come from an older view of this file. ` +
			`Call edit with action=view again to refresh the hashes.`,
	);
}

export default function (pi: ExtensionAPI) {
	const snapshots = new Map<string, Snapshot>();

	async function viewFile(absolutePath: string, params: { path: string; offset?: number; limit?: number }) {
		let content: string;
		try {
			content = readStrippedBom(await readFile(absolutePath, "utf8"));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			throw new Error(
				`edit cannot view ${params.path}: ${code ?? (error as Error).message}`,
			);
		}

		const snapshot = buildSnapshot(content);
		snapshots.set(absolutePath, snapshot);

		const offset = params.offset ?? 1;
		const limit = params.limit ?? DEFAULT_VIEW_LIMIT;
		const startIdx = Math.min(Math.max(offset - 1, 0), snapshot.lines.length);
		const endIdx = Math.min(startIdx + limit, snapshot.lines.length);

		const width = String(Math.max(startIdx + (endIdx - startIdx), 1)).length;
		const rows: string[] = [];
		for (let i = startIdx; i < endIdx; i++) {
			rows.push(
				`${String(i + 1).padStart(width)} │ ${lineHash(i, snapshot.lines[i])} │ ${snapshot.lines[i]}`,
			);
		}

		const binaryNote = content.includes("\u0000") ? " [contains NUL bytes]" : "";
		const header = `hashline view of ${params.path} — ${snapshot.lines.length} lines, file hash ${snapshot.fileHash}${binaryNote}`;
		const lines: string[] = [header, ...rows];
		const remaining = snapshot.lines.length - endIdx;
		if (remaining > 0) {
			lines.push(`… ${remaining} more lines below (use offset ${endIdx + 1} to continue)`);
		}
		if (snapshot.lines.length === 0) {
			lines.push("File is empty. Use write, or edit replace with an edit that has no hashes (whole-file region).");
		}

		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			details: {
				path: absolutePath,
				lines: snapshot.lines.length,
				shown: endIdx - startIdx,
				offset: startIdx + 1,
				fileHash: snapshot.fileHash,
				lineEnding: snapshot.lineEnding,
				hasTrailingNewline: snapshot.hasTrailingNewline,
			},
		};
	}

	function resolveEdit(snapshot: Snapshot, edit: EditInput): ResolvedEdit {
		const hasLine = edit.hash !== undefined;
		const hasRegion = edit.startHash !== undefined || edit.endHash !== undefined;
		if (hasLine && hasRegion) {
			throw new Error(
				"Each edit entry must use either hash (single line) or startHash/endHash (region), not both. " +
					"To replace one line, send only hash. To replace several lines, send only startHash/endHash " +
					"(the boundary lines just outside the region).",
			);
		}
		const replacement = toReplacementLines(edit.newText, snapshot.lineEnding);

		if (hasLine) {
			const index = snapshot.hashToIndex.get(edit.hash!);
			if (index === undefined) throw unknownHashError(edit.hash!);
			return { start: index, end: index + 1, replacement };
		}

		if (!hasRegion) {
			// No anchors: replace the whole file.
			return { start: 0, end: snapshot.lines.length, replacement };
		}

		const startIdx = edit.startHash !== undefined
			? (() => {
					const index = snapshot.hashToIndex.get(edit.startHash!);
					if (index === undefined) throw unknownHashError(edit.startHash!);
					return index;
				})()
			: -1;
		const endIdx = edit.endHash !== undefined
			? (() => {
					const index = snapshot.hashToIndex.get(edit.endHash!);
					if (index === undefined) throw unknownHashError(edit.endHash!);
					return index;
				})()
			: snapshot.lines.length;
		if (startIdx >= endIdx) {
			throw new Error(
				`Invalid region: the startHash line (${startIdx + 1}) must be above the endHash line (${endIdx + 1}).`,
			);
		}
		return { start: startIdx + 1, end: endIdx, replacement };
	}

	function describeEdit(edit: ResolvedEdit): string {
		const first = edit.start + 1;
		const last = edit.end;
		const removed = edit.end - edit.start;
		const added = edit.replacement.length;
		if (removed === 0) {
			const where = first === 1 ? "at top" : `after line ${first - 1}`;
			return `  ${where}: inserted ${added} line${added === 1 ? "" : "s"}`;
		}
		if (added === 0) {
			return `  lines ${first}–${last}: deleted ${removed} line${removed === 1 ? "" : "s"}`;
		}
		if (removed === 1 && added === 1) return `  line ${first}: replaced`;
		return `  lines ${first}–${last}: replaced ${removed} line${removed === 1 ? "" : "s"} with ${added} line${added === 1 ? "" : "s"}`;
	}

	async function replaceFile(
		absolutePath: string,
		params: { path: string; fileHash?: string; edits?: EditInput[] },
	) {
		const snapshot = snapshots.get(absolutePath);
		if (!snapshot) {
			throw new Error(
				`edit has no view of ${params.path}. Call edit with action=view on this file first — line hashes are only valid from a view.`,
			);
		}
		if (params.fileHash && params.fileHash !== snapshot.fileHash) {
			throw new Error(
				`fileHash ${params.fileHash} does not match the last view of ${params.path} (file hash ${snapshot.fileHash}). Call action=view again to refresh.`,
			);
		}

		const current = readStrippedBom(await readFile(absolutePath, "utf8"));
		if (current !== snapshot.content) {
			throw new Error(
				`Refusing to edit ${params.path}: the file changed since the last view ` +
					`(viewed file hash ${snapshot.fileHash}, current file hash ${fileHashOf(current)}). ` +
					`Call edit with action=view again to refresh the line hashes.`,
			);
		}

		const resolved = (params.edits ?? []).map((edit) => resolveEdit(snapshot, edit));
		resolved.sort((a, b) => b.start - a.start);
		for (let i = 1; i < resolved.length; i++) {
			if (resolved[i].end > resolved[i - 1].start) {
				throw new Error(
					`edit edits overlap around line ${resolved[i].end}. ` +
						`Each edits[] entry is resolved against the viewed content; keep them disjoint or merge them into one region.`,
				);
			}
		}

		const newLines = [...snapshot.lines];
		for (const edit of resolved) {
			newLines.splice(edit.start, edit.end - edit.start, ...edit.replacement);
		}
		const newContent =
			newLines.join(snapshot.lineEnding) + (snapshot.hasTrailingNewline ? snapshot.lineEnding : "");

		await withFileMutationQueue(absolutePath, async () => {
			await writeFile(absolutePath, newContent, "utf8");
		});

		const next = buildSnapshot(newContent);
		snapshots.set(absolutePath, next);

		const descriptions = [...resolved].sort((a, b) => a.start - b.start).map(describeEdit);
		const firstChangedLine = resolved.length > 0 ? Math.min(...resolved.map((edit) => edit.start)) + 1 : undefined;
		return {
			content: [
				{
					type: "text" as const,
					text: `Applied ${resolved.length} edit${resolved.length === 1 ? "" : "s"} to ${params.path} (${snapshot.lines.length} → ${next.lines.length} lines)\n${descriptions.join("\n")}`,
				},
			],
			details: {
				path: absolutePath,
				editsApplied: resolved.length,
				linesBefore: snapshot.lines.length,
				linesAfter: next.lines.length,
				firstChangedLine,
				fileHash: next.fileHash,
			},
		};
	}

	const prepareArguments = (args: unknown): Static<typeof schema> => {
		const input = args as Record<string, unknown>;
		if (!input || typeof input !== "object") return args as Static<typeof schema>;

		// Migrate models still using the built-in find-and-replace edit shape.
		if ("oldText" in input || "newText" in input) {
			throw new Error(
				"edit no longer does find-and-replace. Call edit with action=view first to get line hashes, then edit with action=replace and edits[] referencing those hashes.",
			);
		}
		// Some models use file_path instead of path.
		if (typeof input.path !== "string" && typeof input.file_path === "string") {
			input.path = input.file_path;
		}
		// Some models send a single edit object instead of a one-element edits array.
		if (input.edits && typeof input.edits === "object" && !Array.isArray(input.edits)) {
			input.edits = [input.edits];
		}
		return args as Static<typeof schema>;
	};

	const execute = async (
		_toolCallId: string,
		params: Static<typeof schema>,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: { cwd: string },
	) => {
		const absolutePath = resolve(ctx.cwd, stripAtPrefix(params.path));
		if (params.action === "view") {
			return viewFile(absolutePath, params);
		}

		const edits = normalizeEdits(params.edits);
		if (edits.length === 0) {
			throw new Error("edit replace requires edits[] with at least one edit.");
		}
		return replaceFile(absolutePath, {
			path: params.path,
			fileHash: params.fileHash,
			edits,
		});
	};

	// Override Pi's exact-text edit tool with hashline editing. Its renderer is
	// custom because Pi's built-in edit renderer expects a diff-shaped result.
	pi.registerTool(
		defineTool<typeof schema, EditToolDetails>({
			name: "edit",
			label: "Edit",
			description:
				"Edit files by line hash. action=view prints each line with a short unique hash and remembers the exact file content; action=replace then swaps lines or regions referenced by those hashes. This tool replaces the old find-and-replace edit: hashes are salted with the line position so identical lines still differ, and replace refuses to run when the file changed since the last view. Region edits replace everything strictly between two boundary lines (both kept): adjacent boundaries insert newText between them, empty newText deletes the block, and omitted boundaries mean the top/bottom of the file.",
			promptSnippet: "Edit files by line hash: view to get per-line hashes, then replace, insert, or delete lines by hash",
			promptGuidelines: [
				"Use edit action=view to obtain line hashes for a file before calling edit action=replace on it; never invent hashes.",
				"edit replace fails when the file changed since its last view, including changes made by write, bash, or an earlier edit call. After any external change, call edit action=view again to refresh the hashes.",
				"Batch disjoint changes to one file into a single edit replace call with multiple entries in edits[]; the entries must not overlap.",
				"In each edits[] entry, set either hash (one line) or startHash/endHash (region), never both. Pass only the hex hash, not the line number column from the view output.",
				"Use write to create new files or replace whole files; use edit for targeted changes to existing files.",
			],
			parameters: schema,
			// The hashline schema has no oldText/newText diff for Pi's built-in renderer.
			renderShell: "default",
			prepareArguments,
			execute,
			renderCall(args, theme, context) {
				const input = args as { action?: unknown; path?: unknown; file_path?: unknown };
				const action = input.action === "view" || input.action === "replace" ? input.action : undefined;
				const rawPath =
					typeof input.path === "string" && input.path !== ""
						? input.path
						: typeof input.file_path === "string" && input.file_path !== ""
							? input.file_path
							: undefined;
				// Tool-call JSON arrives key by key; path and action are often still
				// missing when the first frame renders. Do not label that "invalid".
				const path =
					rawPath !== undefined
						? stripTerminalSequences(rawPath)
						: context.argsComplete
							? "(missing path)"
							: "…";
				let text = theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", path);
				if (action !== undefined) text += theme.fg("dim", ` (${action})`);
				return new Text(text, 0, 0);
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

				const output = stripTerminalSequences(
					result.content
						.filter((content) => content.type === "text")
						.map((content) => content.text ?? "")
						.join("\n"),
				);

				if (context.isError) {
					const error = output || "Edit failed";
					return new Text(error.split("\n").map((line) => theme.fg("error", line)).join("\n"), 0, 0);
				}

				const details = result.details as EditToolDetails | undefined;
				const isView = context.args?.action === "view" || details?.shown !== undefined;
				let summary: string;
				if (isView) {
					const shown = details?.shown ?? details?.lines ?? (output ? output.split("\n").length : 0);
					const total = details?.lines;
					summary = theme.fg("success", `Viewed ${shown} line${shown === 1 ? "" : "s"}`);
					if (total !== undefined && total !== shown) summary += theme.fg("dim", ` of ${total}`);
				} else {
					const editsApplied = details?.editsApplied;
					summary = theme.fg(
						"success",
						editsApplied === undefined
							? "Applied changes"
							: `Applied ${editsApplied} edit${editsApplied === 1 ? "" : "s"}`,
					);
					if (details?.linesBefore !== undefined && details?.linesAfter !== undefined) {
						summary += theme.fg("dim", ` (${details.linesBefore} → ${details.linesAfter} lines)`);
					}
				}

				if (!expanded || !output) return new Text(summary, 0, 0);
				const styledOutput = output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
				return new Text(`${summary}\n${styledOutput}`, 0, 0);
			},
		}),
	);
}
