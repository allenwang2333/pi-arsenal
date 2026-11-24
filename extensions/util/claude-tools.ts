/**
 * Claude Code-style tool calls.
 *
 *   ⏺ Bash(git status)
 *     ⎿  On branch main
 *        Your branch is up to date with 'origin/main'.
 *        … +3 lines (ctrl+o to expand)
 *
 * The dot is dim while a call runs, then green or red. Bash, read, write,
 * hashline edit, grep, find, and ls get Claude's titles and summaries. Other
 * tools keep their own call and result rows inside the same frame. MCP tools
 * show `MCP server/tool`, a one-line result summary, and all output on
 * expand. Tools that draw their own frame (`renderShell: "self"`) are left
 * alone.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import {
	getLanguageFromPath,
	highlightCode,
	keyText,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
	type ToolRenderers,
	type ToolRenderResultOptions,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Args = Record<string, unknown> | undefined;
type Status = "running" | "success" | "error";
export type Label = { title: string; detail: string };
/** Produces body rows that fit `width`. */
export type Body = (width: number) => string[];

// Claude Code draws ⏺ on macOS and ● elsewhere.
export const BULLET = process.platform === "darwin" ? "⏺" : "●";
export const BODY_FIRST = "  ⎿  ";
export const BODY_REST = "     ";
// Claude Code keeps three output lines above the fold.
const FOLD_LINES = 3;
const WRITE_PREVIEW_LINES = 10;
// The header a codemode result puts above its output; the body drops it.
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const NESTED_ARGS_CHARS = 80;
const EMPTY_RESULTS = new Set(["No matches found", "No files found matching pattern", "(empty directory)"]);
const SEARCH_SUMMARY: Record<string, { verb: string; noun: string }> = {
	grep: { verb: "Found", noun: "line" },
	find: { verb: "Found", noun: "file" },
	ls: { verb: "Listed", noun: "path" },
};

/** Truncates with Claude's single-character ellipsis. */
export function fit(text: string, width: number): string {
	return truncateToWidth(text, width, "…");
}

export function clean(text: string): string {
	return stripTerminalSequences(text).replace(/\r/g, "").replace(/\t/g, "   ");
}

function str(value: unknown): string {
	return typeof value === "string" ? clean(value) : "";
}

function count(theme: Theme, n: number, noun: string): string {
	return `${theme.bold(String(n))} ${noun}${n === 1 ? "" : "s"}`;
}

export function expandHint(theme: Theme): string {
	return theme.fg("dim", `(${keyText("app.tools.expand") || "ctrl+o"} to expand)`);
}

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const fromCwd = relative(cwd, path);
	if (fromCwd === "") return ".";
	if (fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd)) return fromCwd;
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function pathArg(args: Args, cwd: string): string {
	const path = str(args?.path ?? args?.file_path);
	return path ? displayPath(path, cwd) : "";
}

function lineRange(args: Args): string {
	const offset = typeof args?.offset === "number" ? args.offset : undefined;
	const limit = typeof args?.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

/** Claude's `key: "value"` list, as used for Search and MCP tools. */
function argList(args: Args, cwd: string, keys?: string[]): string {
	if (!args || typeof args !== "object") return "";
	const entries = keys ? keys.map((key) => [key, args[key]] as const) : Object.entries(args);
	return entries
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => {
			const shown =
				typeof value === "string" ? (key === "path" ? displayPath(clean(value), cwd) : clean(value)) : value;
			return `${key}: ${JSON.stringify(shown) ?? String(shown)}`;
		})
		.join(", ");
}

export function getSkillInfo(rawPath: string): { name: string } | null {
	if (!rawPath) return null;
	const normalized = rawPath.replace(/\\/g, "/");
	const base = basename(normalized);
	if (base.toLowerCase() === "skill.md") {
		const parentDir = basename(dirname(normalized));
		return { name: parentDir };
	}
	const parts = normalized.split("/");
	const skillsIndex = parts.lastIndexOf("skills");
	if (skillsIndex !== -1 && skillsIndex === parts.length - 2 && base.endsWith(".md")) {
		return { name: basename(base, ".md") };
	}
	return null;
}

export function isMcpTool(toolName: string): boolean {
	return (
		toolName.startsWith("mcp__") ||
		toolName === "read_mcp_resource" ||
		toolName === "list_mcp_resources" ||
		toolName === "list_mcp_resource_templates"
	);
}

/** `MCP server/tool`, so MCP calls are easy to tell apart from built-in tools. */
export function formatMcpToolName(toolName: string): string {
	if (toolName.startsWith("mcp__")) {
		const withoutPrefix = toolName.slice(5);
		const delim = withoutPrefix.indexOf("__");
		if (delim !== -1) {
			const server = withoutPrefix.slice(0, delim);
			let tool = withoutPrefix.slice(delim + 2);
			// Servers often repeat their name in tool names, such as notion/notion-search.
			for (const sep of ["-", "_"]) {
				if (tool.startsWith(server + sep) && tool.length > server.length + 1) tool = tool.slice(server.length + 1);
			}
			return `MCP ${server}/${tool}`;
		}
	}
	if (toolName === "read_mcp_resource") return "MCP read_resource";
	if (toolName === "list_mcp_resources") return "MCP list_resources";
	if (toolName === "list_mcp_resource_templates") return "MCP list_resource_templates";
	return `MCP ${toolName}`;
}

function claudeLabel(toolName: string, args: Args, cwd: string): Label | undefined {
	const rawPath = str(args?.path ?? args?.file_path);
	const skillInfo =
		toolName === "read" || (toolName === "edit" && args?.action === "view")
			? getSkillInfo(rawPath)
			: null;
	if (skillInfo) {
		return { title: "Skill", detail: skillInfo.name };
	}
	if (isMcpTool(toolName)) {
		return { title: formatMcpToolName(toolName), detail: argList(args, cwd) };
	}
	switch (toolName) {
		case "bash":
			return { title: "Bash", detail: str(args?.command) };
		case "read":
			return { title: "Read", detail: pathArg(args, cwd) + lineRange(args) };
		case "edit":
			// Hashline edit only. Pi's built-in edit draws its diff in its own call row.
			if (args?.action === "view") return { title: "Read", detail: pathArg(args, cwd) };
			if (args?.action === "replace") return { title: "Edit", detail: pathArg(args, cwd) };
			return undefined;
		case "write":
			return { title: "Write", detail: pathArg(args, cwd) };
		case "grep":
			return { title: "Search", detail: argList(args, cwd, ["pattern", "path", "glob"]) };
		case "find":
			return { title: "Search", detail: argList(args, cwd, ["pattern", "path"]) };
		case "ls":
			return { title: "List", detail: pathArg(args, cwd) || "." };
		case "codemode":
			return { title: "Codemode", detail: scriptSummary(str(args?.code)) };
		default:
			return undefined;
	}
}

function genericLabel(toolName: string, args: Args, cwd: string): Label {
	const title = toolName
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join("");
	return { title: title || toolName, detail: argList(args, cwd) };
}

/** The `Title(detail)` label a tool call row shows, for rows drawn outside this renderer. */
export function toolLabel(toolName: string, args: Args, cwd: string): Label {
	return claudeLabel(toolName, args, cwd) ?? genericLabel(toolName, args, cwd);
}

function statusOf(context: RenderContext): Status {
	if (context.isError) return "error";
	return context.isPartial ? "running" : "success";
}

function isBlank(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

export function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start]!)) start++;
	while (end > start && isBlank(lines[end - 1]!)) end--;
	return lines.slice(start, end);
}

function textOf(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const block of result.content) if (block.type === "text") parts.push(block.text);
	return clean(parts.join("\n"));
}

/** Output lines without the trailing `[...]` notice Pi's tools append. */
function outputLines(output: string): string[] {
	const body = output.trimEnd().replace(/\n\n\[[^\n]*\]$/, "").trimEnd();
	return body ? body.split("\n") : [];
}

interface NestedCall {
	name?: string;
	args?: string;
	status?: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}

interface CodemodeDetails {
	calls?: NestedCall[];
	fullOutputPath?: string;
}

/** The first script line that does work; blanks and `//` comments stay off the call row. */
function scriptSummary(code: string): string {
	return (
		code
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "" && !line.startsWith("//")) ?? ""
	);
}

function scriptLines(code: string): string[] {
	const source = code.replace(/\r/g, "").replace(/\t/g, "   ").trimEnd();
	return source ? highlightCode(source, "javascript") : [];
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Cents for larger amounts, two significant digits for the fractions of a cent model calls cost. */
function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function callStatusIcon(status: NestedCall["status"], theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "…");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
		default:
			return theme.fg("success", "✓");
	}
}

/** `✓ bash git status --porcelain 12ms`, plus the error text when expanded. */
function nestedCallRows(call: NestedCall, theme: Theme, expanded: boolean): string[] {
	const args = call.args ?? "";
	const shown = !expanded && args.length > NESTED_ARGS_CHARS ? `${args.slice(0, NESTED_ARGS_CHARS - 3)}...` : args;
	let row = `${callStatusIcon(call.status, theme)} ${theme.fg("toolTitle", call.name ?? "tool")}`;
	if (shown) row += ` ${theme.fg("muted", shown)}`;
	const duration = formatDuration(call.durationMs);
	if (duration) row += ` ${theme.fg("dim", duration)}`;
	if (call.cost) row += ` ${theme.fg("dim", formatCost(call.cost))}`;
	if (!expanded || !call.error) return [row];
	return [row, ...call.error.split("\n").map((line) => theme.fg("error", `  ${line}`))];
}

/** The script's text output, without the header the tool puts above it. */
function scriptOutput(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && !SCRIPT_HEADER.test(block.text)) parts.push(block.text);
	}
	return clean(parts.join("\n")).trim();
}

/** Nested calls, then the script output, folded like Bash output and without a timer row. */
function codemodeBody(theme: Theme, result: AgentToolResult<unknown>, status: Status, expanded: boolean): Body {
	const details = result.details as CodemodeDetails | undefined;
	const calls = details?.calls ?? [];
	const output = scriptOutput(result);
	const color = status === "error" ? "error" : "toolOutput";
	return (width) => {
		const rows = calls.flatMap((call) => nestedCallRows(call, theme, expanded).map((row) => fit(row, width)));
		if (output) {
			for (const line of output.split("\n")) rows.push(...wrapTextWithAnsi(theme.fg(color, line), width));
		}
		if (rows.length === 0) {
			return [fit(theme.fg("dim", status === "running" ? "Running…" : "(No content)"), width)];
		}
		const priced = calls.filter((call) => call.cost);
		if (priced.length > 1) {
			const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
			rows.push(fit(theme.fg("dim", `Model calls: ${formatCost(total)}`), width));
		}
		const folded = fold(theme, rows, width, expanded, status === "success" ? "head" : "tail");
		if (expanded || !details?.fullOutputPath) return folded;
		// The folded preview hides the truncation notice at the end, so name the file here.
		return [...folded, fit(theme.fg("dim", `Full output: ${details.fullOutputPath}`), width)];
	};
}

function fold(theme: Theme, lines: string[], width: number, expanded: boolean, keep: "head" | "tail"): string[] {
	const hidden = lines.length - FOLD_LINES;
	// Claude shows a fourth line rather than "+1 lines".
	if (expanded || hidden <= 1) return lines;
	const hint = fit(`${theme.fg("dim", `… +${hidden} lines`)} ${expandHint(theme)}`, width);
	return keep === "head" ? [...lines.slice(0, FOLD_LINES), hint] : [hint, ...lines.slice(-FOLD_LINES)];
}

export function textBody(theme: Theme, text: string, color: ThemeColor, expanded: boolean, keep: "head" | "tail"): Body {
	return (width) => {
		const lines = text
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, width))
			.map((line) => theme.fg(color, line));
		return fold(theme, lines, width, expanded, keep);
	};
}

function lineBody(lines: string[]): Body {
	return (width) => lines.map((line) => fit(line, width));
}

function bashBody(theme: Theme, output: string, status: Status, expanded: boolean): Body {
	if (!output) return lineBody([theme.fg("dim", status === "running" ? "Running…" : "(No content)")]);
	// Finished output reads from the top. Running and failed output keep the tail.
	const color = status === "error" ? "error" : "toolOutput";
	return textBody(theme, output, color, expanded, status === "success" ? "head" : "tail");
}
function skillBody(theme: Theme, output: string, status: Status, expanded: boolean): Body {
	if (!output) return lineBody([theme.fg("dim", status === "running" ? "Loading…" : "(No content)")]);
	const cleanOutput = stripFrontmatter(output).trim() || output.trim();
	const color = status === "error" ? "error" : "toolOutput";
	return textBody(theme, cleanOutput, color, expanded, status === "success" ? "head" : "tail");
}
/** `Returned 2 results` for `{"results": [...]}`, else an item or line count. */
function mcpSummary(theme: Theme, result: AgentToolResult<unknown>, output: string): string {
	if (!output && result.content.some((block) => block.type === "image")) return "Returned image";
	try {
		const value: unknown = JSON.parse(output);
		if (Array.isArray(value)) return `Returned ${count(theme, value.length, "item")}`;
		if (value && typeof value === "object") {
			const list = Object.entries(value).find(([, item]) => Array.isArray(item));
			if (list) {
				const [key, items] = list as [string, unknown[]];
				const noun = items.length === 1 && key.length > 1 && key.endsWith("s") ? key.slice(0, -1) : key;
				return `Returned ${theme.bold(String(items.length))} ${noun}`;
			}
			return `Returned ${count(theme, Object.keys(value).length, "field")}`;
		}
	} catch {
		// Not JSON: count lines instead.
	}
	return `Returned ${count(theme, outputLines(output).length, "line")}`;
}

function mcpBody(
	theme: Theme,
	result: AgentToolResult<unknown>,
	output: string,
	status: Status,
	expanded: boolean,
	fullOutputPath?: string,
): Body {
	if (status === "running") {
		return output ? textBody(theme, output, "toolOutput", expanded, "tail") : lineBody([theme.fg("dim", "Running…")]);
	}
	if (status === "error") return textBody(theme, output || "(No content)", "error", expanded, "tail");
	if (!output && !result.content.some((block) => block.type === "image")) {
		return lineBody([theme.fg("dim", "(No content)")]);
	}
	const summary = mcpSummary(theme, result, output);
	if (!expanded) return lineBody([`${summary} ${expandHint(theme)}`]);
	// Expanded shows every output line, like Bash and Read.
	const rest = output ? textBody(theme, output, "toolOutput", true, "head") : () => [];
	return (width) => [
		fit(summary, width),
		...rest(width),
		...(fullOutputPath ? wrapTextWithAnsi(theme.fg("dim", `Full output: ${fullOutputPath}`), width) : []),
	];
}
function readSummary(theme: Theme, result: AgentToolResult<unknown>, output: string): string {
	if (result.content.some((block) => block.type === "image")) return "Read image";
	return `Read ${count(theme, outputLines(output).length, "line")}`;
}

function searchBody(theme: Theme, toolName: string, output: string, expanded: boolean): Body {
	const lines = outputLines(output);
	if (lines.length === 0 || (lines.length === 1 && EMPTY_RESULTS.has(lines[0]!))) {
		return lineBody([theme.fg("toolOutput", lines[0] ?? "No results")]);
	}
	const { verb, noun } = SEARCH_SUMMARY[toolName]!;
	const summary = `${verb} ${count(theme, lines.length, noun)}`;
	if (!expanded) return lineBody([`${summary} ${expandHint(theme)}`]);
	const rest = textBody(theme, output, "toolOutput", true, "head");
	return (width) => [fit(summary, width), ...rest(width)];
}

function writeBody(theme: Theme, args: Args, cwd: string, expanded: boolean): Body {
	const rawPath = str(args?.path ?? args?.file_path);
	const content = typeof args?.content === "string" ? clean(args.content).replace(/\n$/, "") : "";
	const lines = content ? content.split("\n") : [];
	const shown = expanded ? lines : lines.slice(0, WRITE_PREVIEW_LINES);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const preview = lang ? highlightCode(shown.join("\n"), lang) : shown.map((line) => theme.fg("toolOutput", line));
	const rows = [`Wrote ${count(theme, lines.length, "line")} to ${theme.bold(displayPath(rawPath, cwd))}`];
	const thenRun = args?.then_run as { command?: unknown } | undefined;
	if (typeof thenRun?.command === "string") rows.push(theme.fg("dim", `then_run: ${clean(thenRun.command)}`));
	rows.push(...preview);
	const hidden = lines.length - shown.length;
	if (hidden > 0) rows.push(`${theme.fg("dim", `… +${hidden} lines`)} ${expandHint(theme)}`);
	return lineBody(rows);
}

export function renderLabel(theme: Theme, label: Label, expanded: boolean, width: number): string[] {
	const name = theme.fg("toolTitle", theme.bold(label.title));
	if (!label.detail) return [fit(name, width)];
	if (expanded) return wrapTextWithAnsi(name + theme.fg("toolTitle", `(${label.detail})`), width);
	const [first = "", ...rest] = label.detail.split("\n");
	const detail = rest.length > 0 ? `${first} …` : first;
	return [fit(name + theme.fg("toolTitle", `(${detail})`), width)];
}

class ClaudeCall implements Component {
	theme: Theme | undefined;
	status: Status = "running";
	label: Label = { title: "", detail: "" };
	/** The tool's own call row, used when there is no Claude title. */
	inner: Component | undefined;
	/** Rows below the call row, such as an expanded codemode script, indented like the body. */
	extra: Body | undefined;
	expanded = false;
	pad = 1;
	private cache: { width: number; lines: string[] } | undefined;

	set(
		theme: Theme,
		status: Status,
		label: Label,
		inner: Component | undefined,
		expanded: boolean,
		pad: number,
		extra?: Body,
	): void {
		this.theme = theme;
		this.status = status;
		this.label = label;
		this.inner = inner;
		this.expanded = expanded;
		this.extra = extra;
		this.pad = pad;
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const theme = this.theme!;
		const color = this.status === "error" ? "error" : this.status === "success" ? "success" : "dim";
		const head = `${" ".repeat(this.pad)}${theme.fg(color, BULLET)} `;
		const indent = " ".repeat(this.pad + 2);
		const rowWidth = Math.max(1, width - this.pad - 2);
		const inner = this.inner ? trimBlank(this.inner.render(rowWidth)) : [];
		const rows = inner.length > 0 ? inner : renderLabel(theme, this.label, this.expanded, rowWidth);
		const extra = this.extra ? this.extra(rowWidth) : [];
		const lines = [...rows, ...extra].map((row, index) => (index === 0 ? head : indent) + row);
		// A delegated row can change without a new renderCall, so it is not cached.
		if (!this.inner && !this.extra) this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.inner?.invalidate();
	}
}

class ClaudeResult implements Component {
	theme: Theme | undefined;
	body: Body = () => [];
	/** The tool's own result component, when the body delegates to it. */
	inner: Component | undefined;
	pad = 1;
	private cache: { width: number; lines: string[] } | undefined;

	set(theme: Theme, body: Body, inner: Component | undefined, pad: number): void {
		this.theme = theme;
		this.body = body;
		this.inner = inner;
		this.pad = pad;
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const theme = this.theme!;
		const indent = " ".repeat(this.pad);
		const bodyWidth = Math.max(1, width - this.pad - BODY_FIRST.length);
		const lines = this.body(bodyWidth).map(
			(row, index) => indent + (index === 0 ? theme.fg("dim", BODY_FIRST) : BODY_REST) + row,
		);
		// A delegated body can change without a new renderResult call.
		if (!this.inner) this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.inner?.invalidate();
	}
}

function createClaudeRenderers(toolName: string, base: ToolRenderers | undefined, outputPad: () => number): ToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context) {
			const previous = context.lastComponent instanceof ClaudeCall ? context.lastComponent : undefined;
			const component = previous ?? new ClaudeCall();
			const input = args as Args;
			let label = claudeLabel(toolName, input, context.cwd);
			let inner: Component | undefined;
			if (!label && base?.renderCall) {
				// Base renderers expect their own previous component, not this wrapper.
				try {
					inner = base.renderCall(args, theme, { ...context, lastComponent: previous?.inner });
				} catch {
					inner = undefined;
				}
			}
			// Expanded, a codemode script stands below the title instead of the one-line summary.
			let extra: Body | undefined;
			if (label && toolName === "codemode" && context.expanded) {
				const script = scriptLines(str(input?.code));
				if (script.length > 0) {
					label = { title: label.title, detail: "" };
					extra = lineBody(script);
				}
			}
			const shown = label ?? genericLabel(toolName, input, context.cwd);
			component.set(theme, statusOf(context), shown, inner, context.expanded, outputPad(), extra);
			return component;
		},

		renderResult(result, options: ToolRenderResultOptions, theme, context) {
			const previous = context.lastComponent instanceof ClaudeResult ? context.lastComponent : undefined;
			const component = previous ?? new ClaudeResult();
			const status = statusOf(context);
			const output = textOf(result);
			// Counts use the raw text; displayed output drops blank edges.
			const shown = output.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
			const args = context.args as Args;

			const rawPath = str(args?.path ?? args?.file_path);
			const isSkill =
				(toolName === "read" || (toolName === "edit" && args?.action === "view")) &&
				Boolean(getSkillInfo(rawPath));
			const isMcp = isMcpTool(toolName);
			// codemode draws its own body. Only an image, which its renderer turns into text, delegates.
			const hasImages = result.content.some((block) => block.type === "image");

			const delegates =
				!isSkill &&
				!isMcp &&
				!(toolName === "codemode" && !hasImages) &&
				(toolName === "edit" ||
				(toolName === "read" && options.expanded && status !== "error") ||
				(!(toolName in SEARCH_SUMMARY) && !["bash", "read", "write"].includes(toolName)));
			let inner: Component | undefined;
			if (delegates && base?.renderResult) {
				try {
					const forBase =
						toolName === "codemode"
							? {
									...result,
									content: result.content.filter(
										(block) => !(block.type === "text" && SCRIPT_HEADER.test(block.text)),
									),
									details: { ...(result.details as CodemodeDetails | undefined), calls: [] },
								}
							: result;
					// Pi's codemode renderer adds a timer row; a fresh state drops it.
					const baseContext =
						toolName === "codemode"
							? { ...context, lastComponent: previous?.inner, state: {}, durationMs: undefined }
							: { ...context, lastComponent: previous?.inner };
					inner = base.renderResult(forBase, options, theme, baseContext);
				} catch {
					inner = undefined;
				}
			}

			let body: Body;
			if (inner) {
				const own = inner;
				body = (width) => {
					const summary =
						toolName === "codemode"
							? ((result.details as CodemodeDetails | undefined)?.calls ?? []).flatMap((call) =>
									nestedCallRows(call, theme, options.expanded),
								)
							: toolName === "read"
								? [readSummary(theme, result, output)]
								: [];
					return [...summary.map((line) => fit(line, width)), ...trimBlank(own.render(width))];
				};
			} else if (isSkill) {
				body = skillBody(theme, shown, status, options.expanded);
			} else if (isMcp) {
				const fullOutputPath = (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
				body = mcpBody(theme, result, shown, status, options.expanded, fullOutputPath);
			} else if (toolName === "codemode") {
				body = codemodeBody(theme, result, status, options.expanded);
			} else if (toolName === "bash") {
				body = bashBody(theme, shown, status, options.expanded);
			} else if (status === "error") {
				body = textBody(theme, shown, "error", options.expanded, "tail");
			} else if (toolName === "read") {
				body = lineBody([`${readSummary(theme, result, output)} ${expandHint(theme)}`]);
			} else if (toolName in SEARCH_SUMMARY) {
				body = searchBody(theme, toolName, shown, options.expanded);
			} else if (toolName === "write") {
				body = writeBody(theme, args, context.cwd, options.expanded);
			} else {
				body = textBody(theme, shown, "toolOutput", options.expanded, status === "success" ? "head" : "tail");
			}

			component.set(theme, body, inner, outputPad());
			return component;
		},
	};
}

export function installClaudeToolCalls(pi: ExtensionAPI): void {
	// Settings are readable only while this extension runtime is live.
	const outputPad = (): number => {
		try {
			return pi.getSettings().outputPad ?? 1;
		} catch {
			return 1;
		}
	};

	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		// Tools that draw their own frame already control their layout.
		if (base?.renderShell === "self") return base;
		return createClaudeRenderers(toolName, base, outputPad);
	});
}
