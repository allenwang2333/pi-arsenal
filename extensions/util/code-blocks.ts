/**
 * ChatGPT-style code blocks in assistant replies.
 *
 *     ╭────────────────────────────────────╮
 *     │ typescript                      ⿻  │
 *     │ const answer = 42;                 │
 *     ╰────────────────────────────────────╯
 *
 * Pi draws a code block as raw ``` fences with an indent, so a mouse selection
 * copies the fences and the indent. This draws each block as an indented card
 * with round corners and the language on a header row. A left click on the
 * ⿻ button copies the code, and the button shows ✓ for a short time.
 *
 * A mouse selection that starts in the code stays in the code of that card. It
 * skips the borders and the padding, and a wrapped line copies as one line.
 *
 * A selection that starts outside the code copies Markdown when it covers a code
 * block or more than one block of a reply. Each block that it touches copies
 * whole, as its Markdown source. Other rows, such as tool calls, keep their text.
 */

import { copyToClipboard, type ExtensionAPI, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	Container,
	Markdown,
	mixColors,
	rgbColor,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
	type MarkdownTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const PATCH = Symbol.for("pi-warehouse.code-blocks");
const RENDERED = Symbol("code-blocks.rendered");
const BLOCK = Symbol("code-blocks.block");
const CODES = Symbol("code-blocks.codes");
const LAYOUT = Symbol("code-blocks.layout");
const COPIED = Symbol("code-blocks.copied");
const SELECTION_PATCH = Symbol.for("pi-warehouse.code-blocks.selection");
const IN_CARD = Symbol("code-blocks.in-card");
// The card is lighter than user messages: their background mixed toward the terminal's.
const CARD_LIGHTEN = 0.55;
// Columns on each side of the card, beyond the margins of regular output.
const INDENT = 2;
const PAD = 1;
const MIN_WIDTH = 20;
const COPIED_MS = 2000;
// Styles inside a row can reset the background. The row puts it back after each one.
const BG_RESET = /\x1b\[(?:0|49)?m/g;

type CodeToken = { type: "code"; raw: string; text: string; lang?: string };
type Token = { type: string; raw: string } | CodeToken;
type Block = { header: string; button: string; code: string };
type Button = { code: string; start: number; end: number };

/** A top-level block that Pi rendered. Pi reuses it, without a new render, while its source stays the same. */
type PiBlock = { lines: string[]; [CODES]?: Block[] };
/** The rows of one top-level token in the lines of a Markdown. */
type Span = { token: Token; start: number; end: number; codes: Block[] };
type Layout = { lines: string[]; spans: Span[]; buttons: Map<number, Button> };

/** Fields of Pi's Markdown. They are private in its type declarations. */
type MarkdownFields = {
	text: string;
	paddingY: number;
	theme: MarkdownTheme;
	defaultTextStyle: unknown;
	cachedTokens?: WeakRef<{ tokens: Token[] }>;
	blocks?: WeakRef<Map<string, PiBlock>>;
	invalidate(): void;
	[RENDERED]?: PiBlock[];
	[BLOCK]?: PiBlock;
	[LAYOUT]?: Layout;
	[COPIED]?: { code: string; label: "Copied" | "Copy failed"; timer: ReturnType<typeof setTimeout> };
};

type MarkdownPrototype = {
	render(width: number): string[];
	renderBlock(block: PiBlock, token: Token, ...rest: unknown[]): void;
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	[PATCH]?: Partial<Pick<MarkdownPrototype, "render" | "renderBlock" | "renderToken" | "handleMouse">>;
};

type Card = { bg: string };

/** A position in the fullscreen selection. Rows and columns are in the frame of the line they index. */
type Point = { row: number; col: number; boundary?: boolean; scrollView?: unknown; [IN_CARD]?: true };
type Bounds = { start: Point; end: Point };

/** A box of Pi's layout frame. A scroll view box has the lines of its content. */
type LayoutBox = { component?: unknown; scrollView?: unknown; scrollContentLines?: string[]; children: LayoutBox[] };
/** A reply and its first row in the lines of a scroll view. */
type Reply = { markdown: MarkdownFields; layout: Layout; top: number };

/** Fields of Pi's fullscreen TUI. They are private in its type declarations. */
type AltScreenPrototype = {
	currentLayout?: { root: LayoutBox };
	selectionAnchor?: Point;
	getSelectionBounds(): Bounds | undefined;
	getSelectionColumns(line: string, row: number, selection: Bounds, minColumn?: number, maxColumn?: number): { start: number; end: number };
	getSelectionSourceLine(point: Point): string;
	getActiveSelectionText(): string | undefined;
	[SELECTION_PATCH]?: Pick<AltScreenPrototype, "getSelectionBounds" | "getSelectionColumns" | "getActiveSelectionText">;
};

/** Columns of the code in one row of a card. `continued` marks the second and later rows of a wrapped line. */
type CodeRow = { start: number; end: number; continued: boolean };

function cardColors(theme: Theme): Card {
	const page = theme.appearance === "dark" ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
	const bg = mixColors(theme.colors.userMessageBg, page, CARD_LIGHTEN);
	return { bg: backgroundAnsi(bg, theme.getColorMode()) };
}

/**
 * The start of each code row. The selection finds code rows by these strings.
 * A wrapped row sets the background twice: it looks the same, but the copy joins it to the row above.
 */
function codeRowPrefix(theme: Theme, card: Card, continued: boolean): string {
	return theme.fg("borderMuted", "│") + card.bg + (continued ? card.bg : "") + " ".repeat(PAD);
}

/** One row inside the card: the side borders and the filled text between them. */
function cardRow(theme: Theme, card: Card, text: string, inner: number, continued = false): string {
	const fill = " ".repeat(Math.max(0, inner - visibleWidth(text)));
	const side = theme.fg("borderMuted", "│");
	const bg = continued ? card.bg + card.bg : card.bg;
	return `${" ".repeat(INDENT)}${side}${bg}${(text + fill).replace(BG_RESET, (code) => code + card.bg)}\x1b[49m${side}`;
}

/** Find the code columns in a rendered line. The line can have more text on its left, such as margins. */
function findCodeRow(theme: Theme, line: string): CodeRow | undefined {
	const card = cardColors(theme);
	let continued = true;
	let at = line.indexOf(codeRowPrefix(theme, card, true));
	if (at < 0) {
		continued = false;
		at = line.indexOf(codeRowPrefix(theme, card, false));
	}
	if (at < 0) return undefined;
	const right = line.lastIndexOf(`\x1b[49m${theme.fg("borderMuted", "│")}`);
	if (right < at) return undefined;
	const start = visibleWidth(line.slice(0, at)) + 1 + PAD;
	return { start, end: visibleWidth(line.slice(0, right)) - PAD, continued };
}

/**
 * Cut a code line into rows at exact columns. Word wrap drops the blanks at each
 * break, so a copy of the rows would not be the same as the code.
 */
function wrapCode(line: string, width: number): string[] {
	const total = visibleWidth(line);
	if (total <= width) return [line];
	const rows: string[] = [];
	for (let col = 0; col < total; ) {
		const row = sliceByColumn(line, col, width, true);
		const rowWidth = visibleWidth(row);
		if (rowWidth === 0) break;
		rows.push(row);
		col += rowWidth;
	}
	return rows;
}

function borderRow(theme: Theme, left: string, right: string, inner: number): string {
	return " ".repeat(INDENT) + theme.fg("borderMuted", left + "─".repeat(inner) + right);
}

/** The icon with one space on each side. ⿻ is two columns, so the marks are padded to match. */
function buttonLabel(label: string): string {
	return label === "Copied" ? " ✓  " : label === "Copy failed" ? " ✗  " : " ⿻ ";
}

function headerRow(theme: Theme, card: Card, lang: string, label: string, inner: number): string {
	const color: ThemeColor = label === "Copied" ? "success" : label === "Copy failed" ? "error" : "accent";
	const button = theme.fg(color, buttonLabel(label));
	const buttonWidth = visibleWidth(buttonLabel(label));
	const name = truncateToWidth(`${" ".repeat(PAD)}${lang}`, Math.max(0, inner - buttonWidth - 1), "…");
	const gap = " ".repeat(Math.max(1, inner - visibleWidth(name) - buttonWidth));
	return cardRow(theme, card, theme.fg("dim", name) + gap + button, inner);
}

/**
 * Pi lexes the source with each tab as three spaces, so a token's `raw` has no tabs.
 * Take the same text from the source to keep them. Any doubt falls back to `raw`.
 */
function sourceText(source: string, raw: string): string {
	if (!source.includes("\t")) return raw;
	const start = source.replace(/\t/g, "   ").indexOf(raw);
	if (start < 0) return raw;
	let from = 0;
	for (let offset = 0; offset < start; from++) offset += source[from] === "\t" ? 3 : 1;
	let to = from;
	for (let offset = start; offset < start + raw.length; to++) offset += source[to] === "\t" ? 3 : 1;
	const text = source.slice(from, to);
	return text.replace(/\t/g, "   ") === raw ? text : raw;
}

/** The code of a block with its tabs. Pi's `token.text` has none. */
function sourceCode(source: string, token: CodeToken): string {
	const block = sourceText(source, token.raw);
	if (block === token.raw) return token.text;
	const lines = block.replace(/\n$/, "").split("\n").slice(1);
	if (/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(lines.at(-1) ?? "")) lines.pop();
	const indent = new RegExp(`^ {0,${/^ */.exec(token.raw)![0].length}}`);
	const code = lines.map((line) => line.replace(indent, "")).join("\n");
	return code.replace(/\t/g, "   ") === token.text ? code : token.text;
}

/**
 * The rows of each top-level token, and the copy button rows. Pi renders each token
 * as one block, but it reuses a block without a render while the token's source
 * stays the same. So the code of a block is kept on Pi's block.
 */
function layoutOf(markdown: MarkdownFields, lines: string[], rendered: PiBlock[]): Layout {
	const layout: Layout = { lines, spans: [], buttons: new Map() };
	const tokens = lines.length > 0 ? markdown.cachedTokens?.deref()?.tokens ?? [] : [];
	// Pi keys the blocks by source when it reuses them. If not, it renders each token in order.
	const reused = markdown.blocks?.deref();
	let row = markdown.paddingY;
	for (const [index, token] of tokens.entries()) {
		const block = reused?.size ? reused.get(token.raw) : rendered[index];
		if (!block) return layout;
		layout.spans.push({ token, start: row, end: row + block.lines.length, codes: block[CODES] ?? [] });
		row += block.lines.length;
	}
	// Rows that do not add up mean an unknown render. Then nothing maps to the source.
	if (row + markdown.paddingY !== lines.length) {
		layout.spans = [];
		return layout;
	}
	for (const span of layout.spans) {
		let at = span.start;
		for (const block of span.codes) {
			while (at < span.end && !lines[at]!.includes(block.header)) at++;
			if (at >= span.end) break;
			const plain = stripTerminalSequences(lines[at]!);
			const start = visibleWidth(plain.slice(0, plain.lastIndexOf(block.button)));
			layout.buttons.set(at++, { code: block.code, start, end: start + visibleWidth(block.button) });
		}
	}
	return layout;
}

function copy(markdown: MarkdownFields, code: string): void {
	const show = (label: "Copied" | "Copy failed") => {
		clearTimeout(markdown[COPIED]?.timer);
		const timer = setTimeout(() => {
			markdown[COPIED] = undefined;
			markdown.invalidate();
		}, COPIED_MS);
		timer.unref?.();
		markdown[COPIED] = { code, label, timer };
		markdown.invalidate();
	};
	// The click renders at once, but the clipboard write ends later. Show success first.
	show("Copied");
	copyToClipboard(code).catch(() => show("Copy failed"));
}

/**
 * Pi has no hook for code blocks, so this replaces Markdown's render, block render,
 * code-block token, and mouse handler. Only Markdown without a default text style
 * changes: assistant replies, not user messages, thinking, or tool output. Returns the undo.
 */
export function patchCodeBlocks(theme: Theme): () => void {
	const proto = Markdown.prototype as unknown as MarkdownPrototype;
	// Each method is saved on its own, so a reload keeps Pi's methods from an older patch.
	const saved = (proto[PATCH] ??= {});
	saved.render ??= proto.render;
	saved.renderBlock ??= proto.renderBlock;
	saved.renderToken ??= proto.renderToken;
	if (!("handleMouse" in saved)) saved.handleMouse = proto.handleMouse;
	const original = saved as Required<Pick<MarkdownPrototype, "render" | "renderBlock" | "renderToken">> & Pick<MarkdownPrototype, "handleMouse">;

	function render(this: MarkdownFields, width: number): string[] {
		if (this.defaultTextStyle !== undefined) return original.render.call(this, width);
		const rendered: PiBlock[] = [];
		this[RENDERED] = rendered;
		let lines: string[];
		try {
			lines = original.render.call(this, width);
		} finally {
			this[RENDERED] = undefined;
		}
		// A cached render returns the same lines.
		if (this[LAYOUT]?.lines !== lines) this[LAYOUT] = layoutOf(this, lines, rendered);
		return lines;
	}

	function renderBlock(this: MarkdownFields, block: PiBlock, token: Token, ...rest: unknown[]): void {
		const rendered = this[RENDERED];
		if (!rendered) return original.renderBlock.call(this, block, token, ...rest);
		block[CODES] = [];
		this[BLOCK] = block;
		try {
			original.renderBlock.call(this, block, token, ...rest);
		} finally {
			this[BLOCK] = undefined;
		}
		rendered.push(block);
	}

	function renderToken(this: MarkdownFields, token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
		const blocks = this[BLOCK]?.[CODES];
		if (token.type !== "code" || !blocks || width < MIN_WIDTH) {
			return original.renderToken.call(this, token, width, nextTokenType, styleContext);
		}
		const { text, lang: info } = token as CodeToken;
		const code = sourceCode(this.text, token as CodeToken);
		const lang = info?.trim().split(/\s+/)[0] ?? "";
		const copied = this[COPIED];
		const label = copied?.code === code ? copied.label : "Copy";
		const card = cardColors(theme);
		// Width inside the side borders, with INDENT free on both sides.
		const inner = width - 2 * INDENT - 2;
		const header = headerRow(theme, card, lang, label, inner);
		blocks.push({ header, button: buttonLabel(label), code });
		const highlighted = this.theme.highlightCode?.(text, lang || undefined)
			?? text.split("\n").map((line) => this.theme.codeBlock(line));
		const pad = " ".repeat(PAD);
		const body = highlighted.flatMap((line) =>
			wrapCode(line, inner - 2 * PAD).map((row, index) => cardRow(theme, card, pad + row, inner, index > 0)),
		);
		const lines = [borderRow(theme, "╭", "╮", inner), header, ...body, borderRow(theme, "╰", "╯", inner)];
		if (nextTokenType && nextTokenType !== "space") lines.push("");
		return lines;
	}

	function handleMouse(this: MarkdownFields, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const button = this[LAYOUT]?.buttons.get(event.y);
		const onButton = button && event.x >= button.start && event.x < button.end;
		if (!onButton || event.type !== "click" || event.button !== "left") {
			return original.handleMouse?.call(this, event);
		}
		copy(this, button.code);
		return { handled: true };
	}

	proto.render = render;
	proto.renderBlock = renderBlock;
	proto.renderToken = renderToken;
	proto.handleMouse = handleMouse;
	return () => {
		// After a reload the new runtime patches again. Leave its patch in place.
		if (proto.render !== render) return;
		proto.render = original.render;
		proto.renderBlock = original.renderBlock;
		proto.renderToken = original.renderToken;
		if (original.handleMouse) proto.handleMouse = original.handleMouse;
		else delete proto.handleMouse;
	};
}

function findScrollBox(box: LayoutBox, scrollView: unknown): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = findScrollBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

/** Find the replies in the rows of a component. Pi's containers keep the height of each child from their last render. */
function findReplies(component: unknown, top: number, replies: Reply[]): void {
	if (component instanceof Markdown) {
		const markdown = component as unknown as MarkdownFields;
		const layout = markdown[LAYOUT];
		if (layout) replies.push({ markdown, layout, top });
		return;
	}
	if (!(component instanceof Container)) return;
	const children = (component as unknown as { mouseLayout?: { children: { component: unknown; height: number }[] } }).mouseLayout?.children;
	for (const child of children ?? []) {
		findReplies(child.component, top, replies);
		top += child.height;
	}
}

/**
 * The Markdown of a selection in a scroll view. Each block of a reply that the
 * selection touches copies whole as its source, and other rows copy as Pi copies
 * them. A selection in one block that is not code, and has no other text, is undefined,
 * so Pi copies a word or a sentence as it shows it.
 */
function markdownSelectionText(screen: AltScreenPrototype, selection: Bounds): string | undefined {
	const scrollView = selection.start.scrollView;
	const box = scrollView && screen.currentLayout ? findScrollBox(screen.currentLayout.root, scrollView) : undefined;
	const lines = box?.scrollContentLines;
	if (!box || !lines) return undefined;
	const replies: Reply[] = [];
	findReplies(box.children[0]?.component, 0, replies);

	const parts: string[] = [];
	const touched = new Set<Span>();
	let otherText = false;
	let group: { reply: Reply; first: number; last: number } | undefined;
	const flush = () => {
		if (!group) return;
		const raw = group.reply.layout.spans.slice(group.first, group.last + 1).map((span) => span.token.raw).join("");
		parts.push(sourceText(group.reply.markdown.text, raw).replace(/\n+$/, ""));
		group = undefined;
	};
	for (let row = selection.start.row; row <= selection.end.row; row++) {
		const line = lines[row] ?? "";
		const columns = screen.getSelectionColumns(line, row, selection);
		const text = stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd();
		const reply = replies.find((reply) => row >= reply.top && row < reply.top + reply.layout.lines.length);
		const local = reply ? row - reply.top : -1;
		const index = reply ? reply.layout.spans.findIndex((span) => local >= span.start && local < span.end) : -1;
		if (!reply || index < 0) {
			flush();
			parts.push(text);
			otherText ||= text.trim() !== "";
			continue;
		}
		// The reply has rendered again since this frame. Its rows are not known.
		if (!line.endsWith(reply.layout.lines[local]!)) return undefined;
		// Blank rows between blocks come from the source.
		if (!text.trim()) continue;
		touched.add(reply.layout.spans[index]!);
		if (group?.reply === reply) group.last = index;
		else {
			flush();
			group = { reply, first: index, last: index };
		}
	}
	flush();
	const [only] = touched;
	if (!only || (touched.size === 1 && only.codes.length === 0 && !otherText)) return undefined;
	return parts.join("\n");
}

/**
 * Keep a fullscreen selection that starts in the code of a card inside that code.
 * The rows stop at the first and last code rows, and each row skips the borders
 * and the padding. Inside the code, the selection ends at the pointer as usual.
 * Returns the undo.
 */
export function patchCodeSelection(theme: Theme): () => void {
	const proto = TuiAltScreen.prototype as unknown as AltScreenPrototype;
	const original = (proto[SELECTION_PATCH] ??= {
		getSelectionBounds: proto.getSelectionBounds,
		getSelectionColumns: proto.getSelectionColumns,
		getActiveSelectionText: proto.getActiveSelectionText,
	});

	function getSelectionBounds(this: AltScreenPrototype): Bounds | undefined {
		const bounds = original.getSelectionBounds.call(this);
		const anchor = this.selectionAnchor;
		if (!bounds || !anchor) return bounds;
		const code = findCodeRow(theme, this.getSelectionSourceLine(anchor));
		// The anchor must be between the side borders of a code row.
		if (!code || anchor.col < code.start - PAD || anchor.col >= code.end + PAD) return bounds;
		const anchorFirst = bounds.start === anchor;
		const focus = anchorFirst ? bounds.end : bounds.start;
		// Walk from the anchor toward the focus. Stop at the last code row of the card.
		const step = Math.sign(focus.row - anchor.row);
		let row = anchor.row;
		while (row !== focus.row && findCodeRow(theme, this.getSelectionSourceLine({ ...anchor, row: row + step }))) row += step;
		const scrollView = anchor.scrollView;
		const clamped: Point = row === focus.row
			? { ...focus, [IN_CARD]: true }
			: step < 0
				? { row, col: 0, scrollView, [IN_CARD]: true }
				: { row, col: Number.MAX_SAFE_INTEGER, boundary: true, scrollView, [IN_CARD]: true };
		const start: Point = { ...anchor, [IN_CARD]: true };
		return anchorFirst ? { start, end: clamped } : { start: clamped, end: start };
	}

	function getSelectionColumns(this: AltScreenPrototype, line: string, row: number, selection: Bounds, minColumn?: number, maxColumn?: number) {
		const columns = original.getSelectionColumns.call(this, line, row, selection, minColumn, maxColumn);
		// Pi copies the points into screen coordinates with object spread, which keeps the mark.
		const code = selection.start[IN_CARD] ? findCodeRow(theme, line) : undefined;
		if (!code) return columns;
		return { start: Math.max(columns.start, code.start), end: Math.min(columns.end, code.end) };
	}

	function getActiveSelectionText(this: AltScreenPrototype): string | undefined {
		const selection = this.getSelectionBounds();
		if (!selection) return undefined;
		if (!selection.start[IN_CARD]) return markdownSelectionText(this, selection) ?? original.getActiveSelectionText.call(this);
		let text = "";
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = this.getSelectionSourceLine({ ...selection.start, row });
			const columns = this.getSelectionColumns(line, row, selection);
			const part = stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true));
			if (row === selection.end.row) {
				text += part.trimEnd();
				break;
			}
			// The fill after a line is blank, but a wrapped row has no fill, so keep its blanks.
			const next = findCodeRow(theme, this.getSelectionSourceLine({ ...selection.start, row: row + 1 }));
			text += next?.continued ? part : `${part.trimEnd()}\n`;
		}
		return text.length === 0 ? undefined : text;
	}

	proto.getSelectionBounds = getSelectionBounds;
	proto.getSelectionColumns = getSelectionColumns;
	proto.getActiveSelectionText = getActiveSelectionText;
	return () => {
		// After a reload the new runtime patches again. Leave its patch in place.
		if (proto.getSelectionBounds !== getSelectionBounds) return;
		proto.getSelectionBounds = original.getSelectionBounds;
		proto.getSelectionColumns = original.getSelectionColumns;
		proto.getActiveSelectionText = original.getActiveSelectionText;
	};
}

export function installCodeBlocks(pi: ExtensionAPI): void {
	let unpatch: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unpatch?.();
		const unpatchBlocks = patchCodeBlocks(ctx.ui.theme);
		const unpatchSelection = patchCodeSelection(ctx.ui.theme);
		unpatch = () => {
			unpatchSelection();
			unpatchBlocks();
		};
	});
	pi.on("session_shutdown", () => {
		unpatch?.();
		unpatch = undefined;
	});
}
