/**
 * Claude Code-style rows for Pi transcript messages that are not tool calls.
 *
 *   ⏺ Skill(pi-warehouse)                                  /skill:name
 *     ⎿  Successfully loaded skill (ctrl+o to expand)
 *
 *   ! git status                                           !cmd and !!cmd
 *     ⎿  On branch main
 *
 *   ✻ Conversation compacted from 123,456 tokens (ctrl+o to expand)
 *   ✻ Branch summary (ctrl+o to expand)
 *
 * Pi has no hooks for these components, so each patch replaces the
 * `updateDisplay` method that builds them. Pi calls it from the constructor,
 * setExpanded, setOutputPad, invalidate, and (for `!` commands) on new output.
 */

import {
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	SkillInvocationMessageComponent,
	truncateTail,
	type ExtensionAPI,
	type MessageRenderer,
	type ParsedSkillBlock,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	MouseRegion,
	Spacer,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
	BODY_FIRST,
	BODY_REST,
	BULLET,
	clean,
	expandHint,
	fit,
	type Label,
	renderLabel,
	textBody,
	trimBlank,
} from "./claude-tools.ts";

const BASH_PROMPT = "! ";
const PROMPT_WIDTH = 2;
const ORIGINAL = Symbol.for("pi-warehouse.claude-messages.update-display");

/** A row drawn by `draw`, cached per width. A changed message builds a new row. */
class Row implements Component {
	private readonly draw: (width: number) => string[];
	private cache: { width: number; lines: string[] } | undefined;

	constructor(draw: (width: number) => string[]) {
		this.draw = draw;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines = this.draw(width);
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

function withBody(theme: Theme, head: string[], body: string[], indent = ""): string[] {
	return [...head, ...body.map((row, index) => indent + (index === 0 ? theme.fg("dim", BODY_FIRST) : BODY_REST) + row)];
}

function markdownRows(theme: Theme, markdownTheme: MarkdownTheme, text: string, width: number): string[] {
	const markdown = new Markdown(text, 0, 0, markdownTheme, { color: (line) => theme.fg("toolOutput", line) });
	return trimBlank(markdown.render(width));
}

/** Fields of Pi's Box-based messages and their Box. They are private in the type declarations. */
type BoxMessage = {
	expanded: boolean;
	markdownTheme: MarkdownTheme;
	paddingY: number;
	clear(): void;
	addChild(component: Component): void;
	setBgFn(bgFn?: (text: string) => string): void;
	setExpanded(expanded: boolean): void;
};
type SkillFields = BoxMessage & { skillBlock: ParsedSkillBlock };
type CompactionFields = BoxMessage & { message: { tokensBefore: number; summary: string } };
type BranchFields = BoxMessage & { message: { summary: string } };
type BashFields = {
	command: string;
	outputLines: string[];
	status: "running" | "complete" | "error" | "cancelled";
	exitCode: number | undefined;
	truncationResult: { truncated?: boolean } | undefined;
	fullOutputPath: string | undefined;
	expanded: boolean;
	colorKey: ThemeColor;
	outputPad: number;
	clear(): void;
	addChild(component: Component): void;
};

type DisplayPrototype = { updateDisplay(): void; [ORIGINAL]?: () => void };

/** Replaces the class's `updateDisplay`. Returns the undo. */
function patchDisplay<T>(cls: { prototype: unknown }, updateDisplay: (this: T) => void): () => void {
	const proto = cls.prototype as DisplayPrototype;
	// Keep Pi's method, not a patch left by an earlier runtime.
	if (!Object.hasOwn(proto, ORIGINAL)) proto[ORIGINAL] = proto.updateDisplay;
	const original = proto[ORIGINAL]!;
	const patched = updateDisplay as unknown as () => void;
	proto.updateDisplay = patched;
	return () => {
		// After a reload the new runtime patches again. Leave its patch in place.
		if (proto.updateDisplay === patched) proto.updateDisplay = original;
	};
}

/** Draws a Box-based message as a flat row. The Box keeps outputPad as its left padding. */
function patchBoxMessage<T extends BoxMessage>(cls: { prototype: unknown }, row: (message: T) => Component): () => void {
	return patchDisplay<T>(cls, function (this: T) {
		this.clear();
		this.setBgFn(undefined);
		this.paddingY = 0;
		this.addChild(
			new MouseRegion(row(this), (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	});
}

function skillRow(theme: Theme, skill: SkillFields): Component {
	const { skillBlock, markdownTheme, expanded } = skill;
	return new Row((width) => {
		const label = renderLabel(theme, { title: "Skill", detail: clean(skillBlock.name) }, false, Math.max(1, width - 2));
		const head = label.map((row, index) => (index === 0 ? `${theme.fg("success", BULLET)} ` : "  ") + row);
		const bodyWidth = Math.max(1, width - BODY_FIRST.length);
		const status = "Successfully loaded skill";
		const body = [fit(expanded ? status : `${status} ${expandHint(theme)}`, bodyWidth)];
		if (expanded) body.push(...markdownRows(theme, markdownTheme, skillBlock.content, bodyWidth));
		return withBody(theme, head, body);
	});
}

type CustomMessage = Parameters<MessageRenderer>[0];

function detailField(message: CustomMessage, name: string): string {
	const value = (message.details as Record<string, unknown> | undefined)?.[name];
	return typeof value === "string" ? clean(value).replace(/\n/g, " ") : "";
}

/**
 * A custom message collapsed like a Claude skill row. Expanded, its text follows the status line.
 * Collapsed, an optional preview stays visible under the status line.
 */
function collapsedMessage(
	message: CustomMessage, expanded: boolean, outputPad: number, theme: Theme, label: Label, status: string, preview = "",
): Component {
	const text = typeof message.content === "string" ? message.content
		: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	return new Row((width) => {
		const indent = " ".repeat(Math.max(0, outputPad));
		const inner = width - indent.length;
		if (inner < 1) return [];
		const head = renderLabel(theme, label, expanded, Math.max(1, inner - 2))
			.map((line, index) => indent + (index === 0 ? `${theme.fg("success", BULLET)} ` : "  ") + line);
		const bodyWidth = Math.max(1, inner - BODY_FIRST.length);
		const body = [fit(expanded ? status : `${status} ${expandHint(theme)}`, bodyWidth)];
		if (expanded) body.push(...textBody(theme, clean(text), "toolOutput", true, "head")(bodyWidth));
		else if (preview) body.push(...textBody(theme, clean(preview), "toolOutput", true, "head")(bodyWidth));
		return withBody(theme, head, body, indent).map((line) => fit(line, width));
	});
}

/** Keep the workflow request in model context, but collapse it like a Claude skill row. */
export const renderWorkflowMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	const detail = [detailField(message, "workflowId"), detailField(message, "stepId")].filter(Boolean).join(" / ");
	const stepTitle = detailField(message, "stepTitle");
	const status = stepTitle ? `${stepTitle} selected` : "Workflow step selected";
	return collapsedMessage(message, expanded, outputPad, theme, { title: "Workflow", detail }, status);
};

/** The dynamic workflow report stays in model context. Collapsed, only its summary and conclusion show. */
export const renderDynamicWorkflowMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
	const label = { title: "DynamicWorkflow", detail: detailField(message, "skill") };
	const conclusion = (message.details as { conclusion?: unknown } | undefined)?.conclusion;
	return collapsedMessage(message, expanded, outputPad, theme, label, detailField(message, "summary") || "Report",
		typeof conclusion === "string" ? conclusion : "");
};

/** Claude's dim `✻` notice. Expanded, the summary follows under `⎿`. */
function summaryRow(theme: Theme, message: BoxMessage, title: string, summary: string): Component {
	const { markdownTheme, expanded } = message;
	return new Row((width) => {
		const notice = theme.fg("dim", `✻ ${title}`);
		if (!expanded) return [fit(`${notice} ${expandHint(theme)}`, width)];
		const bodyWidth = Math.max(1, width - BODY_FIRST.length);
		return withBody(theme, [fit(notice, width)], markdownRows(theme, markdownTheme, summary, bodyWidth));
	});
}

/** Claude's bash-mode input on the user message background, with output under `⎿`. */
export function renderBashExecution(theme: Theme, bash: BashFields, width: number): string[] {
	const indent = " ".repeat(Math.max(0, bash.outputPad));
	const inner = width - indent.length;
	// One column of right padding, as in user messages.
	const textWidth = inner - PROMPT_WIDTH - 1;
	if (textWidth < 1) return [];
	const command = clean(bash.command)
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, textWidth))
		.map((line) => fit(line, textWidth));
	const head = command.map((line, index) => {
		const prompt = index === 0 ? theme.fg(bash.colorKey, BASH_PROMPT) : " ".repeat(PROMPT_WIDTH);
		const fill = " ".repeat(Math.max(0, textWidth - visibleWidth(line)) + 1);
		return theme.bg("userMessageBg", indent + prompt + theme.fg("userMessageText", line) + fill);
	});

	// Pi keeps the same tail of the output that the model sees.
	const output = truncateTail(bash.outputLines.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const text = clean(output.content).replace(/^(?:[ \t]*\n)+/, "").trimEnd();
	const bodyWidth = Math.max(1, inner - BODY_FIRST.length);
	const body = text
		? textBody(
				theme,
				text,
				bash.status === "error" ? "error" : "toolOutput",
				bash.expanded,
				bash.status === "complete" ? "head" : "tail",
			)(bodyWidth)
		: [theme.fg("dim", bash.status === "running" ? "Running…" : "(No content)")];
	const notes: string[] = [];
	if (bash.status === "error") notes.push(theme.fg("error", `Exit code ${bash.exitCode}`));
	if (bash.status === "cancelled") notes.push(theme.fg("warning", "Interrupted"));
	if ((bash.truncationResult?.truncated || output.truncated) && bash.fullOutputPath) {
		notes.push(theme.fg("dim", `Full output: ${bash.fullOutputPath}`));
	}
	body.push(...notes.map((note) => fit(note, bodyWidth)));
	return withBody(theme, head, body, indent);
}

/** Patches Pi's skill, `!` command, compaction, and branch summary rows. Returns the undo. */
export function patchClaudeMessages(theme: Theme): () => void {
	const undo = [
		patchBoxMessage<SkillFields>(SkillInvocationMessageComponent, (skill) =>
			skillRow(theme, skill),
		),
		patchBoxMessage<CompactionFields>(CompactionSummaryMessageComponent, (compaction) =>
			summaryRow(
				theme,
				compaction,
				`Conversation compacted from ${compaction.message.tokensBefore.toLocaleString()} tokens`,
				compaction.message.summary,
			),
		),
		patchBoxMessage<BranchFields>(BranchSummaryMessageComponent, (branch) =>
			summaryRow(theme, branch, "Branch summary", branch.message.summary),
		),
		patchDisplay<BashFields>(BashExecutionComponent, function (this: BashFields) {
			// Replaces Pi's bordered frame. Pi's own spacer stays above the row.
			this.clear();
			this.addChild(new Spacer(1));
			this.addChild(new Row((width) => renderBashExecution(theme, this, width)));
		}),
	];
	return () => {
		for (const restore of undo) restore();
	};
}

export function installClaudeMessages(pi: ExtensionAPI): void {
	let unpatch: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unpatch?.();
		unpatch = patchClaudeMessages(ctx.ui.theme);
	});
	pi.on("session_shutdown", () => {
		unpatch?.();
		unpatch = undefined;
	});
}
