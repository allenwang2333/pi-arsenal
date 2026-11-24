/**
 * Tests for the Claude Code-style header, prompt, spinner, and user messages.
 *
 * Run with: node test/claude-ui.test.ts
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, UserMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installClaudeInput, installClaudeSpinner, installClaudeUi } from "../extensions/util/claude-ui.ts";

const plain: any = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string) => text,
};
const tagged: any = { ...plain, fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
// Pi's own components read the global theme.
initTheme("dark", false);

const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
let thinkingLevel = "high";
const pi = {
	getThinkingLevel: () => thinkingLevel,
	on: (event: string, handler: (event: unknown, ctx: any) => unknown) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
};
installClaudeUi(pi as any);

async function emit(event: string, ctx: any, data: Record<string, unknown> = {}) {
	for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
}

const calls: Record<string, any[]> = {};
const record =
	(name: string) =>
	(...args: any[]) =>
		(calls[name] ??= []).push(args);
const ui = {
	theme: plain,
	setHeader: record("setHeader"),
	setWorkingIndicator: record("setWorkingIndicator"),
	setHiddenThinkingLabel: record("setHiddenThinkingLabel"),
	setEditorComponent: record("setEditorComponent"),
	setWorkingMessage: record("setWorkingMessage"),
};
const ctx = {
	mode: "tui",
	cwd: join(homedir(), "work", "app"),
	model: { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai-codex" },
	modelRegistry: { getProviderDisplayName: (provider: string) => (provider === "openai-codex" ? "OpenAI Codex" : provider) },
	ui,
};

const userMessage = (text: string, transformers: any[] = []) =>
	new UserMessageComponent(text, getMarkdownTheme(), 1, transformers);
const piUserMessage = userMessage("hello").render(40).map(stripTerminalSequences);

// --- Other modes get no terminal chrome. ---
await emit("session_start", { ...ctx, mode: "print" });
await emit("agent_start", { ...ctx, mode: "print" });
assert.deepEqual(calls, {});
assert.deepEqual(userMessage("hello").render(40).map(stripTerminalSequences), piUserMessage);
console.log("MODES: print mode untouched");

await emit("session_start", ctx);

// --- Header: Clawd beside version, model, and cwd. ---
const header = calls.setHeader![0]![0](undefined, plain);
assert.deepEqual(header.render(80).map(stripTerminalSequences), [
	`  ▐▛███▜▌   Pi v${VERSION}`,
	" ▝▜█████▛▘  GPT-5.6 Terra · OpenAI Codex",
	"   ▘▘ ▝▝    ~/work/app",
]);
assert.deepEqual(header.render(20).map(stripTerminalSequences), [` Pi v${VERSION}`, " GPT-5.6 Terra · Op…", " ~/work/app"]);
for (const width of [12, 20, 40, 80]) {
	for (const line of header.render(width)) assert.ok(visibleWidth(line) <= width);
}
console.log("HEADER: Clawd, version, model, cwd; narrow widths drop the art");

// --- Spinner: Claude's frames played forward then back. ---
const indicator = calls.setWorkingIndicator![0]![0];
const glyphs = process.env.TERM === "xterm-ghostty" ? "·✢✳✶✻✻" : "·✢✳✶✻✽";
assert.equal(indicator.frames.join(""), glyphs + [...glyphs].reverse().join(""));
assert.equal(indicator.intervalMs, 120);
assert.deepEqual(calls.setHiddenThinkingLabel, [[""]]);
const assistant = new AssistantMessageComponent({
	role: "assistant",
	content: [{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text: "Result" }],
	stopReason: "stop",
} as any, true, getMarkdownTheme(), calls.setHiddenThinkingLabel![0]![0]);
const hiddenText = assistant.render(40).map(stripTerminalSequences).join("\n");
assert.doesNotMatch(hiddenText, /Thinking|Private reasoning/);
assert.match(hiddenText, /Result/);
assert.deepEqual(assistant.render(40).map((line) => stripTerminalSequences(line).trimEnd()), ["", " Result"]);
assistant.setHideThinkingBlock(false);
assert.match(assistant.render(40).map(stripTerminalSequences).join("\n"), /Private reasoning/);
console.log("SPINNER: ping-pong frames; hidden thinking placeholder omitted; reasoning can still be revealed");

// --- Working message: one verb, elapsed seconds, interrupt key; stops at agent_end. ---
await emit("agent_start", ctx);
const first = calls.setWorkingMessage![0]![0] as string;
assert.match(first, /^[A-Z][\w'é-]+… \(esc to interrupt\)$/);
const verb = first.split("…")[0];
await new Promise((resolve) => setTimeout(resolve, 1100));
assert.equal(calls.setWorkingMessage!.at(-1)![0], `${verb}… (1s · esc to interrupt)`);
await emit("agent_end", ctx);
const settled = calls.setWorkingMessage!.length;
await new Promise((resolve) => setTimeout(resolve, 1100));
assert.equal(calls.setWorkingMessage!.length, settled);
console.log("SPINNER: verb with elapsed time; timer stops at agent_end");

// --- A stale ctx stops the timer instead of throwing from setInterval. ---
let staleCalls = 0;
await emit("agent_start", {
	...ctx,
	ui: {
		...ui,
		setWorkingMessage: () => {
			staleCalls++;
			if (staleCalls > 1) throw new Error("stale ctx");
		},
	},
});
await new Promise((resolve) => setTimeout(resolve, 2200));
assert.equal(staleCalls, 2);
console.log("SPINNER: stale ctx stops the timer");

// --- Editor: full-width borders, ❯ in the left padding, correct mouse mapping. ---
const tui = { terminal: { rows: 40, columns: 40 }, requestRender() {} };
const editorTheme = { borderColor: (text: string) => text, selectList: {} };
const editor = calls.setEditorComponent![0]![0](tui, editorTheme, {});
editor.setPaddingX(0);
assert.equal(editor.getPaddingX(), 2);
editor.setText("hello world");
const rows = editor.render(40);
assert.equal(rows[0], "─".repeat(40));
assert.match(stripTerminalSequences(rows[1]), /^❯ hello world/);
assert.equal(rows.at(-1), "─".repeat(40));
for (const row of rows) assert.equal(visibleWidth(row), 40);
editor.handleMouse({ type: "click", button: "left", x: 2 + 6, y: 1, width: 40, height: rows.length });
assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
console.log("EDITOR: full-width borders, prompt, mouse column");

// --- Editor border: gray, bash color for ! commands; Pi's thinking color is ignored. ---
ui.theme = tagged;
const colored = calls.setEditorComponent![0]![0](tui, editorTheme, {});
ui.theme = plain;
colored.borderColor = (text: string) => `<thinkingMax>${text}</thinkingMax>`;
assert.equal(colored.render(20)[0], `<border>${"─".repeat(20)}</border>`);
colored.setText("!ls");
assert.equal(colored.render(20)[0], `<bashMode>${"─".repeat(20)}</bashMode>`);
console.log("EDITOR: gray border, bash color for ! commands");

// --- User messages: ❯ column, hanging indent, no blank rows. ---
const wrapped = userMessage("fix the bug in the parser, then add a test").render(34);
assert.deepEqual(wrapped.map(stripTerminalSequences), [
	" ❯ fix the bug in the parser,     ",
	"   then add a test                ",
]);
for (const line of wrapped) assert.equal(visibleWidth(line), 34);
assert.ok(wrapped[0]!.startsWith("\x1b]133;A\x07"), "prompt zone start kept");
assert.ok(wrapped[1]!.startsWith("\x1b]133;B\x07\x1b]133;C\x07"), "prompt zone end kept");
const blocks = userMessage("- one\n- two").render(20).map((line) => stripTerminalSequences(line).trimEnd());
assert.deepEqual(blocks, [" ❯ - one", "   - two"]);
const shout = (markdown: string, context: any) => (context.messageType === "user" ? markdown.toUpperCase() : markdown);
assert.match(stripTerminalSequences(userMessage("quiet", [shout]).render(20)[0]!), /❯ QUIET/);
console.log("MESSAGES: Claude layout, Markdown blocks, transformers");

// --- A second session_start replaces the patch; shutdown restores Pi's layout. ---
await emit("session_start", ctx);
assert.deepEqual(userMessage("hello").render(20).map((line) => stripTerminalSequences(line).trimEnd()), [" ❯ hello"]);
await emit("session_shutdown", ctx);
assert.deepEqual(userMessage("hello").render(40).map(stripTerminalSequences), piUserMessage);
console.log("MESSAGES: patch replaced on restart, removed at shutdown");

// --- Input-only registration keeps Pi's header, spinner, and thinking label. ---
handlers.clear();
for (const name of Object.keys(calls)) delete calls[name];
installClaudeInput(pi as any);
for (const mode of ["print", "json", "rpc"]) {
	await emit("session_start", { ...ctx, mode });
	assert.deepEqual(calls, {});
	assert.deepEqual(userMessage("hello").render(40).map(stripTerminalSequences), piUserMessage);
}
await emit("session_start", ctx);
await emit("agent_start", ctx);
assert.deepEqual(Object.keys(calls), ["setEditorComponent"]);
const inputEditor = calls.setEditorComponent![0]![0](tui, editorTheme, {});
inputEditor.setPaddingX(0);
inputEditor.setText("hello");
assert.equal(inputEditor.getPaddingX(), 2);
assert.match(stripTerminalSequences(inputEditor.render(40)[1]), /^❯ hello/);
assert.deepEqual(userMessage("hello").render(20).map((line) => stripTerminalSequences(line).trimEnd()), [" ❯ hello"]);
await emit("session_start", ctx);
assert.equal(calls.setEditorComponent!.length, 2);
await emit("session_shutdown", ctx);
await emit("session_shutdown", ctx);
assert.deepEqual(userMessage("hello").render(40).map(stripTerminalSequences), piUserMessage);
console.log("INPUT ONLY: Claude editor and messages; other chrome and non-TUI modes untouched; clean shutdown");

// --- Spinner-only registration keeps the Pi header and input untouched. ---
handlers.clear();
for (const name of Object.keys(calls)) delete calls[name];
installClaudeSpinner(pi as any);
for (const mode of ["print", "json", "rpc"]) {
	await emit("session_start", { ...ctx, mode });
	await emit("agent_start", { ...ctx, mode });
	assert.deepEqual(calls, {});
}
await emit("session_start", ctx);
assert.deepEqual(Object.keys(calls), ["setWorkingIndicator", "setHiddenThinkingLabel"]);
assert.deepEqual(userMessage("hello").render(40).map(stripTerminalSequences), piUserMessage);
await emit("agent_start", ctx);
assert.match(calls.setWorkingMessage![0]![0], /^[A-Z][\w'é-]+… \(esc to interrupt\)$/);
await emit("agent_end", ctx);
await emit("session_shutdown", ctx);
await emit("session_shutdown", ctx);
console.log("SPINNER ONLY: Claude working display; header, input, and non-TUI modes untouched");

// --- Live progress: reasoning phase, estimated tokens, reported usage, and per-turn reset. ---
mock.timers.enable({ apis: ["Date", "setInterval"] });
const reasoningCtx = { ...ctx, model: { ...ctx.model, reasoning: true } };
const message = (output = 0, role = "assistant") => ({ role, usage: { output } });
const lastWorking = () => calls.setWorkingMessage!.at(-1)![0] as string;
const updateStream = (type: string, delta = "", output = 0, context = reasoningCtx) =>
	emit("message_update", context, { message: message(output), assistantMessageEvent: { type, delta } });
try {
	await emit("agent_start", reasoningCtx);
	await emit("message_start", reasoningCtx, { message: message() });
	await updateStream("thinking_start");
	await updateStream("thinking_delta", "x".repeat(3996));
	mock.timers.tick(36_000);
	assert.match(lastWorking(), /\(36s · ↓ ~999 tokens · still thinking with high effort · esc to interrupt\)$/);
	const progressVerb = lastWorking().split("…")[0];
	thinkingLevel = "max";
	mock.timers.tick(1000);
	assert.match(lastWorking(), /still thinking with max effort/);
	thinkingLevel = "off";
	mock.timers.tick(1000);
	assert.match(lastWorking(), /still thinking · esc to interrupt/);
	assert.doesNotMatch(lastWorking(), /off effort/);
	thinkingLevel = "high";
	await updateStream("thinking_end");
	mock.timers.tick(1000);
	assert.doesNotMatch(lastWorking(), /still thinking/);
	await updateStream("text_delta", "abcd");
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ ~1000 tokens/);
	await updateStream("text_delta", "", 1200);
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ 1200 tokens/);
	assert.doesNotMatch(lastWorking(), /~/);
	await emit("message_end", reasoningCtx, { message: message(1250) });
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ 1250 tokens/);

	// User and tool messages must not change the assistant output count.
	await emit("message_start", reasoningCtx, { message: message(0, "toolResult") });
	await emit("message_end", reasoningCtx, { message: message(9000, "toolResult") });
	await emit("message_end", reasoningCtx, { message: message(9000, "user") });
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ 1250 tokens/);

	// A tool continuation starts a fresh count before the next response arrives.
	await emit("turn_start", reasoningCtx);
	mock.timers.tick(1000);
	assert.doesNotMatch(lastWorking(), /tokens|thinking/);
	assert.match(lastWorking(), /^.+… \(44s · esc to interrupt\)$/);
	await emit("message_start", reasoningCtx, { message: message() });
	await updateStream("thinking_delta", "abcd");
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ ~1 tokens · still thinking with high effort/);
	await updateStream("toolcall_delta", "abcdefgh");
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ ~3 tokens/);
	assert.doesNotMatch(lastWorking(), /still thinking/);
	await emit("message_end", reasoningCtx, { message: message(20) });
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ 20 tokens/);
	assert.equal(lastWorking().split("…")[0], progressVerb);
	await emit("agent_end", reasoningCtx);
	const stopped = calls.setWorkingMessage!.length;
	await updateStream("thinking_delta", "ignored");
	mock.timers.tick(2000);
	assert.equal(calls.setWorkingMessage!.length, stopped);

	await emit("agent_start", reasoningCtx);
	assert.doesNotMatch(lastWorking(), /tokens|thinking/);
	await emit("message_start", reasoningCtx, { message: message() });
	await updateStream("thinking_delta", "abcd");
	// No usage is available on this failed response. Keep the estimate, but stop claiming reasoning.
	await emit("message_end", reasoningCtx, { message: { ...message(), stopReason: "error" } });
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ ~1 tokens/);
	assert.doesNotMatch(lastWorking(), /still thinking/);

	// An estimated or failed response must not affect the next response's count or precision.
	await emit("turn_start", reasoningCtx);
	await emit("message_start", reasoningCtx, { message: message() });
	await updateStream("text_delta", "abcd", 8);
	mock.timers.tick(1000);
	assert.match(lastWorking(), /↓ 8 tokens/);
	assert.doesNotMatch(lastWorking(), /~/);
	await emit("message_end", reasoningCtx, { message: message(8) });

	// A replacement assistant response also resets progress without restarting the run.
	await emit("message_start", reasoningCtx, { message: message() });
	mock.timers.tick(1000);
	assert.doesNotMatch(lastWorking(), /tokens|thinking/);
	await emit("message_end", reasoningCtx, { message: message() });
	mock.timers.tick(1000);
	assert.doesNotMatch(lastWorking(), /tokens/);
	await emit("session_shutdown", reasoningCtx);
	const shutdown = calls.setWorkingMessage!.length;
	mock.timers.tick(2000);
	assert.equal(calls.setWorkingMessage!.length, shutdown);

	// A non-reasoning model must not inherit a thinking effort from settings.
	await emit("agent_start", ctx);
	await emit("message_start", ctx, { message: message() });
	await updateStream("thinking_start", "", 0, ctx);
	mock.timers.tick(1000);
	assert.match(lastWorking(), /still thinking · esc to interrupt/);
	assert.doesNotMatch(lastWorking(), /effort/);
	for (const mode of ["print", "json", "rpc"]) {
		await updateStream("thinking_delta", "ignored".repeat(100), 0, { ...reasoningCtx, mode });
	}
	mock.timers.tick(1000);
	assert.doesNotMatch(lastWorking(), /tokens/);
} finally {
	await emit("session_shutdown", reasoningCtx);
	mock.timers.reset();
}
console.log("PROGRESS: per-turn estimated/reported output, thinking effort, tool turns, errors, mode guards, reset, and shutdown");

console.log("\nALL TESTS PASSED");
