/**
 * Tests for code block cards: mouse selection, Markdown copy, and the copy button.
 *
 * Run with: node test/code-blocks.test.ts
 */
import assert from "node:assert/strict";
import { Container, Markdown, rgbColor, stripTerminalSequences, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { patchCodeBlocks, patchCodeSelection } from "../extensions/util/code-blocks.ts";

const theme: any = {
	appearance: "dark",
	colors: { userMessageBg: rgbColor(40, 40, 60) },
	getColorMode: () => "truecolor",
	fg: (_color: string, text: string) => `\x1b[38;5;244m${text}\x1b[39m`,
};
const identity = (text: string) => text;
const markdownTheme: any = {
	heading: identity, link: identity, linkUrl: identity, code: identity,
	codeBlock: (text: string) => `\x1b[32m${text}\x1b[39m`,
	codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity,
	listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};

const proto = TuiAltScreen.prototype as any;
const originalBounds = proto.getSelectionBounds;
const unpatchBlocks = patchCodeBlocks(theme);
const unpatchSelection = patchCodeSelection(theme);

const long = "    return compute(alpha,  beta, gamma) + more(delta);";
const code = ["const answer = 42;", "if (answer) {", long, "}"];
const source = `Before the code.\n\n\`\`\`ts\n${code.join("\n")}\n\`\`\`\n\nAfter the code.`;
// Two extra columns on the left stand for the margins of the transcript.
const lines = new Markdown(source, 1, 0, markdownTheme).render(40).map((line) => `  ${line}`);
const plain = lines.map(stripTerminalSequences);
const row = (text: string) => plain.findIndex((line) => line.includes(text));
const col = (r: number, text: string) => plain[r]!.indexOf(text);

// The long line wraps at exact columns and keeps its indent and blanks.
const first = row("const answer");
const wrapStart = row("return compute");
assert.ok(plain[wrapStart]!.includes("│     return"), "the wrapped line keeps its indent");
const codeWidth = plain[wrapStart]!.lastIndexOf("│") - plain[wrapStart]!.indexOf("│") - 3;
assert.equal(plain[wrapStart]!.slice(col(wrapStart, "│") + 2, col(wrapStart, "│") + 2 + codeWidth), long.slice(0, codeWidth));
assert.ok(plain[wrapStart + 1]!.includes(long.slice(codeWidth, codeWidth + 10)), "the next row continues at the next column");
const last = row("}");

function select(anchor: { row: number; col: number }, focus: { row: number; col: number }) {
	const screen = Object.create(TuiAltScreen.prototype);
	screen.terminal = { columns: 60, rows: 100 };
	screen.previousScreen = lines;
	screen.selectionAnchor = anchor;
	screen.selectionFocus = focus;
	const highlighted = screen.applySelection(lines) as string[];
	// The reverse-video cells of each row, as plain text.
	const cells = highlighted.map((line) => {
		const match = /\x1b\[7m(.*)\x1b\[27m/.exec(line);
		return match ? stripTerminalSequences(match[1]!) : "";
	});
	return { text: screen.getActiveSelectionText() as string | undefined, cells };
}

// In one row, the selection ends at the pointer cell.
let result = select({ row: first, col: col(first, "answer") }, { row: first, col: col(first, "42") });
assert.equal(result.text, "answer = 4");
assert.equal(result.cells[first], "answer = 4");

// Across rows, each row has only code: no indent, borders, or padding.
result = select({ row: first, col: col(first, "answer") }, { row: first + 1, col: col(first + 1, "answer") });
assert.equal(result.text, "answer = 42;\nif (a");
assert.equal(result.cells[first], "answer = 42;".padEnd(codeWidth - "const ".length), "the start row stops before the padding");
assert.equal(result.cells[first + 1], "if (a", "the end row starts at the code");
assert.ok(result.cells.every((cells) => !cells.includes("│")), "no border is highlighted");

// A pointer below the card stops at the end of the last code row.
result = select({ row: first, col: col(first, "const") }, { row: row("After"), col: 10 });
assert.equal(result.text, code.join("\n"), "the copy is the code, and the wrapped line is one line");
assert.equal(result.cells[row("After")], "", "the text after the card is not selected");

// A pointer above the card stops at the start of the first code row.
result = select({ row: last, col: col(last, "}") }, { row: row("Before"), col: 3 });
assert.equal(result.text, code.join("\n"));
assert.equal(result.cells[row("ts")], "", "the header row is not selected");

// A pointer on the left margin selects nothing on that row.
result = select({ row: first + 1, col: col(first + 1, "{") }, { row: first, col: 0 });
assert.equal(result.text, "const answer = 42;\nif (answer) {");

// A pointer on the right border stops at the end of the code columns.
result = select({ row: wrapStart, col: col(wrapStart, "compute") }, { row: wrapStart, col: plain[wrapStart]!.lastIndexOf("│") });
assert.equal(result.text, long.slice(long.indexOf("compute"), codeWidth).trimEnd());

// A selection from outside the card keeps Pi's behavior.
result = select({ row: row("Before"), col: 3 }, { row: first, col: col(first, "const") });
assert.ok(result.text?.includes("│"), "Pi selects the whole rows");

// The copy button keeps working when Pi reuses a rendered block.
const symbol = (target: object, name: string) => Object.getOwnPropertySymbols(target).find((s) => s.description === name)!;
const streamed: any = new Markdown("Hi\n\n```ts\nx\n```\n\nBye", 1, 0, markdownTheme);
streamed.render(40);
streamed.setText("Hi\n\n```ts\nx\n```\n\nBye for now");
streamed.render(40);
assert.equal(streamed[symbol(streamed, "code-blocks.layout")].buttons.size, 1, "the reused code block keeps its button");

// In a scroll view, a selection across blocks copies the Markdown source.
const prose = "Run **this** first:";
const tabbed = "if (ok) {\n\treturn 1;\n}";
const reply = `# Title\n\n${prose}\n\n\`\`\`ts\n${tabbed}\n\`\`\`\n\nA *last* line.`;
const transcript = new Container();
transcript.addChild(new Text("Tool row", 1, 0));
transcript.addChild(new Markdown(reply, 1, 0, markdownTheme));
const scrollView = {};
const view = transcript.render(40);
const viewPlain = view.map(stripTerminalSequences);
const at = (text: string) => {
	const r = viewPlain.findIndex((line) => line.includes(text));
	return { row: r, col: viewPlain[r]!.indexOf(text), scrollView };
};

function selectInView(anchor: object, focus: object) {
	const screen = Object.create(TuiAltScreen.prototype);
	screen.terminal = { columns: 40, rows: 100 };
	screen.previousScreen = [];
	screen.currentLayout = { root: { scrollView, scrollContentLines: view, children: [{ component: transcript, children: [] }] } };
	screen.selectionAnchor = anchor;
	screen.selectionFocus = focus;
	return screen;
}

// From the middle of a paragraph into the code: both blocks whole, with the tab.
let screen = selectInView(at("this"), at("return"));
assert.equal(screen.getActiveSelectionText(), `${prose}\n\n\`\`\`ts\n${tabbed}\n\`\`\``);

// The copy key and /copy with a selection use the same text.
let copied: string | undefined;
screen.copySelection = async (text: string) => {
	copied = text;
	return true;
};
screen.flash = () => {};
await screen.copyActiveSelectionToClipboard();
assert.equal(copied, `${prose}\n\n\`\`\`ts\n${tabbed}\n\`\`\``);

// Across the whole transcript: other rows keep their text.
screen = selectInView(at("Tool"), at("line."));
assert.equal(screen.getActiveSelectionText(), `Tool row\n${reply}`);

// From outside the code into a card only: the block as Markdown.
screen = selectInView(at("ts"), at("return"));
assert.equal(screen.getActiveSelectionText(), `\`\`\`ts\n${tabbed}\n\`\`\``);

// Inside one paragraph: the text as Pi shows it.
screen = selectInView(at("Run"), { ...at("first:"), col: at("first:").col + 5 });
assert.equal(screen.getActiveSelectionText(), "Run this first:");

// From the code: only the code, as before.
screen = selectInView(at("return"), at("line."));
assert.equal(screen.getActiveSelectionText(), "return 1;\n}");

unpatchSelection();
unpatchBlocks();
assert.equal(proto.getSelectionBounds, originalBounds, "undo restores Pi's selection");

console.log("code block tests passed");
