/**
 * Tests for the Claude Code-style tool call renderer.
 *
 * Run with: node test/claude-tools.test.ts
 */
import assert from "node:assert/strict";
import { setCapabilityOverrides, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

// Script rows are highlighted through the global theme and may link paths with OSC 8.
initTheme();
setCapabilityOverrides({ hyperlinks: false, trueColor: false });
const { installClaudeToolCalls } = await import("../extensions/util/claude-tools.ts");

const BULLET = process.platform === "darwin" ? "⏺" : "●";
const plain: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tagged: any = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };

function install(getSettings: () => unknown = () => ({ outputPad: 1 })) {
	let resolver: any;
	installClaudeToolCalls({ registerToolRenderer: (r: any) => (resolver = r), getSettings } as any);
	return (toolName: string, base?: any) => resolver(toolName, () => base);
}
const resolve = install();

function context(args: unknown, overrides: Record<string, unknown> = {}) {
	return {
		args,
		toolCallId: "call-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

const text = (value: string) => ({ content: [{ type: "text", text: value }], details: undefined });

function render(
	toolName: string,
	args: unknown,
	result?: { content: unknown[]; details?: unknown },
	overrides: Record<string, unknown> = {},
	base?: any,
	width = 80,
	theme = plain,
) {
	const renderers = resolve(toolName, base);
	const ctx = context(args, overrides);
	const lines: string[] = renderers.renderCall(args, theme, ctx).render(width);
	if (result) {
		const options = { expanded: ctx.expanded, isPartial: ctx.isPartial };
		lines.push(...renderers.renderResult(result, options, theme, ctx).render(width));
	}
	// Script bodies are syntax-highlighted through the global theme, which the fake
	// theme cannot reach. Strip those colors so only the text under test remains.
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

// --- Tools that draw their own frame keep their renderers. ---
const selfFramed = { renderShell: "self", renderCall: () => new Text("plan", 0, 0) };
assert.equal(resolve("update_plan", selfFramed), selfFramed);
assert.equal(resolve("bash", { renderCall: () => new Text("", 0, 0) }).renderShell, "self");
console.log("PASSTHROUGH: self-framed tools are untouched");

// --- Bash: Claude's three-line fold. ---
assert.deepEqual(render("bash", { command: "git status" }, text(numbered(9))), [
	` ${BULLET} Bash(git status)`,
	"   ⎿  line 1",
	"      line 2",
	"      line 3",
	"      … +6 lines (ctrl+o to expand)",
]);
// Claude shows a fourth line instead of "+1 lines".
assert.deepEqual(render("bash", { command: "ls" }, text(numbered(4))).slice(1), [
	"   ⎿  line 1",
	"      line 2",
	"      line 3",
	"      line 4",
]);
assert.equal(render("bash", { command: "ls" }, text(numbered(9)), { expanded: true }).length, 10);
assert.deepEqual(render("bash", { command: "sleep 9" }, text(""), { isPartial: true }).slice(1), ["   ⎿  Running…"]);
assert.deepEqual(render("bash", { command: "true" }, text("")).slice(1), ["   ⎿  (No content)"]);
// Running and failed output keep the tail, where progress and errors are.
assert.deepEqual(render("bash", { command: "make" }, text(numbered(9)), { isPartial: true }).slice(1), [
	"   ⎿  … +6 lines (ctrl+o to expand)",
	"      line 7",
	"      line 8",
	"      line 9",
]);
const failed = render("bash", { command: "false" }, text(`${numbered(5)}\nCommand exited with code 1`), { isError: true }, undefined, 80, tagged);
assert.match(failed[0]!, new RegExp(`<error>${BULLET}</error>`));
assert.match(failed.at(-1)!, /<error>Command exited with code 1<\/error>/);
assert.match(render("bash", { command: "ls" }, undefined, { isPartial: true }, undefined, 80, tagged)[0]!, new RegExp(`<dim>${BULLET}</dim>`));
assert.match(render("bash", { command: "ls" }, text("x"), {}, undefined, 80, tagged)[0]!, new RegExp(`<success>${BULLET}</success>`));
console.log("BASH: three-line fold, running/empty notes, status colors");

// --- Long and multi-line calls stay on one row until expanded. ---
assert.deepEqual(render("bash", { command: "npm test\nnpm run build" }), [` ${BULLET} Bash(npm test …)`]);
assert.deepEqual(render("bash", { command: "npm test\nnpm run build" }, undefined, { expanded: true }), [
	` ${BULLET} Bash(npm test`,
	"   npm run build)",
]);
const long = render("bash", { command: "x".repeat(200) }, undefined, {}, undefined, 40);
assert.equal(long.length, 1);
assert.ok(stripTerminalSequences(long[0]!).endsWith("…"));
assert.equal(visibleWidth(long[0]!), 40);
console.log("CALL ROW: one truncated row collapsed, wrapped when expanded");

// --- Read: summary collapsed, the tool's own body when expanded. ---
const readResult = text("a\nb\nc\n\n[Showing lines 10-12 of 99. Use offset=13 to continue.]");
assert.deepEqual(render("read", { path: "/repo/src/index.ts", offset: 10, limit: 3 }, readResult), [
	` ${BULLET} Read(src/index.ts:10-12)`,
	"   ⎿  Read 3 lines (ctrl+o to expand)",
]);
// Leading blank lines are part of the file and count.
assert.equal(render("read", { path: "a.txt" }, text("\n\nc\nd"))[1], "   ⎿  Read 4 lines (ctrl+o to expand)");
let readBaseLast: unknown = "unset";
const readBase = {
	renderCall: () => new Text("read", 0, 0),
	renderResult: (_r: unknown, _o: unknown, _t: unknown, ctx: any) => {
		readBaseLast = ctx.lastComponent;
		return ctx.lastComponent ?? new Text("\nconst a = 1;\nconst b = 2;", 0, 0);
	},
};
const readRenderers = resolve("read", readBase);
const readCtx = context({ path: "src/index.ts" }, { expanded: true });
const firstRead = readRenderers.renderResult(readResult, { expanded: true, isPartial: false }, plain, readCtx);
assert.deepEqual(firstRead.render(60).map((line: string) => line.trimEnd()), [
	"   ⎿  Read 3 lines",
	"      const a = 1;",
	"      const b = 2;",
]);
const ownReadComponent = firstRead.inner;
// Pi passes the previous wrapper back; the base renderer must get its own component.
const secondRead = readRenderers.renderResult(readResult, { expanded: true, isPartial: false }, plain, {
	...readCtx,
	lastComponent: firstRead,
});
assert.equal(secondRead, firstRead);
assert.equal(readBaseLast, ownReadComponent);
console.log("READ: line summary, expanded body, lastComponent unwrapped");

// --- Skill: Claude Skill title and Bash-like fold when reading SKILL.md. ---
const skillContent = "---\nname: commit-message\ndescription: Write commits\n---\n\n# Commit Messages\n\nBe short and concise.\nCover what and why.\n\n## Details\nExtra info.";
assert.deepEqual(render("read", { path: "/repo/skills/commit-message/SKILL.md" }, text(skillContent)), [
	` ${BULLET} Skill(commit-message)`,
	"   ⎿  # Commit Messages",
	"",
	"      Be short and concise.",
	"      … +4 lines (ctrl+o to expand)",
]);
assert.deepEqual(render("read", { path: "skills/commit-message/SKILL.md" }, text(""), { isPartial: true }).slice(1), [
	"   ⎿  Loading…",
]);
assert.equal(
	render("read", { path: "/repo/skills/commit-message/SKILL.md" }, text(skillContent), { expanded: true }).length,
	8,
);
// Hashline edit view also gets Skill display.
assert.deepEqual(render("edit", { action: "view", path: "skills/commit-message/SKILL.md" }, text(skillContent)), [
	` ${BULLET} Skill(commit-message)`,
	"   ⎿  # Commit Messages",
	"",
	"      Be short and concise.",
	"      … +4 lines (ctrl+o to expand)",
]);
const failedSkill = render(
	"read",
	{ path: "skills/commit-message/SKILL.md" },
	text("File not found"),
	{ isError: true },
	undefined,
	80,
	tagged,
);
assert.match(failedSkill[0]!, new RegExp(`<error>${BULLET}</error>`));
assert.match(failedSkill.at(-1)!, /<error>File not found<\/error>/);
console.log("SKILL: Claude Skill title, Bash-like fold, Loading and error states");

// --- Search and list. ---
assert.deepEqual(render("grep", { pattern: "foo", path: "/repo/src", glob: "*.ts" }, text("src/a.ts:1: foo\nsrc/b.ts:2: foo")), [
	` ${BULLET} Search(pattern: "foo", path: "src", glob: "*.ts")`,
	"   ⎿  Found 2 lines (ctrl+o to expand)",
]);
assert.deepEqual(render("find", { pattern: "*.md" }, text("No files found matching pattern")).slice(1), [
	"   ⎿  No files found matching pattern",
]);
assert.deepEqual(render("ls", { path: "/repo" }, text("a\nb\nc\n\n[500 entries limit reached. Use limit=1000 for more]")), [
	` ${BULLET} List(.)`,
	"   ⎿  Listed 3 paths (ctrl+o to expand)",
]);
assert.equal(render("grep", { pattern: "foo" }, text("a:1: foo\nb:2: foo"), { expanded: true }).length, 4);
console.log("SEARCH: Claude titles and counts");

// --- Write: summary, then_run, and a ten-line preview. ---
assert.deepEqual(render("write", { path: "/repo/notes.txt", content: "one\ntwo\n", then_run: { command: "cat notes.txt" } }, text("ok")), [
	` ${BULLET} Write(notes.txt)`,
	"   ⎿  Wrote 2 lines to notes.txt",
	"      then_run: cat notes.txt",
	"      one",
	"      two",
]);
const bigWrite = render("write", { path: "/repo/big.txt", content: numbered(25) }, text("ok"));
assert.equal(bigWrite.length, 13);
assert.equal(bigWrite.at(-1), "      … +15 lines (ctrl+o to expand)");
assert.match(render("write", { path: "x.txt", content: "a" }, text("EACCES"), { isError: true })[1]!, /EACCES/);
console.log("WRITE: summary, then_run, folded preview, errors");

// --- Hashline edit gets Claude titles; other edits keep their own call row. ---
const hashline = {
	renderCall: () => new Text("edit a.ts", 0, 0),
	renderResult: () => new Text("Applied 2 edits (10 → 12 lines)", 0, 0),
};
assert.deepEqual(render("edit", { action: "replace", path: "/repo/a.ts" }, text("Applied"), {}, hashline), [
	` ${BULLET} Edit(a.ts)`,
	"   ⎿  Applied 2 edits (10 → 12 lines)",
]);
assert.equal(render("edit", { action: "view", path: "a.ts" }, undefined, {}, hashline)[0], ` ${BULLET} Read(a.ts)`);
const builtInEdit = { renderCall: () => new Text("edit a.ts\n- x\n+ y", 0, 0), renderResult: () => new Text("", 0, 0) };
assert.deepEqual(render("edit", { path: "a.ts", oldText: "x", newText: "y" }, text("ok"), {}, builtInEdit), [
	` ${BULLET} edit a.ts`,
	"   - x",
	"   + y",
]);
console.log("EDIT: hashline titles; built-in diff row kept");

// --- Other tools: their own rows inside the frame, or a generic Claude row. ---
assert.deepEqual(render("ask-user-question", { questions: [{ question: "Which?" }] }, text("User chose A")), [
	` ${BULLET} AskUserQuestion(questions: [{"question":"Which?"}])`,
	"   ⎿  User chose A",
]);
const todo = { renderCall: () => new Text("todo + Write tests", 0, 0), renderResult: () => new Text("○ pending", 0, 0) };
assert.deepEqual(render("todo", { action: "create" }, text("x"), {}, todo), [
	` ${BULLET} todo + Write tests`,
	"   ⎿  ○ pending",
]);
const throwing = {
	renderCall: () => {
		throw new Error("boom");
	},
};
assert.deepEqual(render("update_plan", { steps: 2 }, undefined, {}, throwing), [` ${BULLET} UpdatePlan(steps: 2)`]);
console.log("GENERIC: delegated rows, PascalCase fallback, renderer errors");

// --- codemode: one Claude row, nested calls and the script output in the body. ---
const scriptCode = 'const [a, b] = await Promise.all([\n  tools.bash({ command: "ls" }),\n]);\nreturn { n: 2 };';
const nested = [
	{ name: "bash", args: "git status --porcelain", status: "ok", durationMs: 12 },
	{ name: "read", args: '{"path":"a.ts"}', status: "ok", durationMs: 3 },
];
function scriptResult(output: string, calls: unknown[] = [], details: Record<string, unknown> = {}) {
	return {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
			{ type: "text", text: output },
		],
		details: { calls, ...details },
	};
}
assert.deepEqual(render("codemode", { code: scriptCode }, scriptResult('{"n":2}', nested)), [
	` ${BULLET} Codemode(const [a, b] = await Promise.all([)`,
	"   ⎿  ✓ bash git status --porcelain 12ms",
	'      ✓ read {"path":"a.ts"} 3ms',
	'      {"n":2}',
]);
// Expanded, the whole script replaces the one-line summary.
assert.deepEqual(render("codemode", { code: scriptCode }, scriptResult('{"n":2}', nested), { expanded: true }), [
	` ${BULLET} Codemode`,
	"   const [a, b] = await Promise.all([",
	'     tools.bash({ command: "ls" }),',
	"   ]);",
	"   return { n: 2 };",
	"   ⎿  ✓ bash git status --porcelain 12ms",
	'      ✓ read {"path":"a.ts"} 3ms',
	'      {"n":2}',
]);
// The `// @options:` line stays off the row; the output folds like Bash and names a truncated file.
const optionsCode = '// @options: {"max_output_tokens": 2000}\nreturn 1;';
const foldedScript = render("codemode", { code: optionsCode }, scriptResult(numbered(9), [], { fullOutputPath: "/tmp/full.txt" }));
assert.deepEqual(foldedScript, [
	` ${BULLET} Codemode(return 1;)`,
	"   ⎿  line 1",
	"      line 2",
	"      line 3",
	"      … +6 lines (ctrl+o to expand)",
	"      Full output: /tmp/full.txt",
]);
// Pi's own codemode body adds a `Took` timer, which no other tool row shows.
assert.ok(!foldedScript.some((line) => line.includes("Took")));
assert.deepEqual(render("codemode", { code: optionsCode }, scriptResult("")), [
	` ${BULLET} Codemode(return 1;)`,
	"   ⎿  (No content)",
]);
// A failed script keeps its header off the row, its call statuses, and the error at the end.
const failedScriptArgs = { code: "throw new Error('boom')" };
const failedScript = {
	content: [
		{ type: "text", text: "Script failed\nWall time 0.3 seconds\nOutput:\n" },
		{ type: "text", text: "Script error:\nError: boom" },
	],
	details: { calls: [{ name: "bash", args: "ls", status: "error", durationMs: 4, error: "exit 1" }] },
};
const failedRows = render("codemode", failedScriptArgs, failedScript, { isError: true }, undefined, 80, tagged);
assert.match(failedRows[0]!, new RegExp(`<error>${BULLET}</error>`));
assert.ok(!failedRows.some((line) => line.includes("Script failed")));
assert.ok(failedRows.at(-1)!.includes("<error>Error: boom</error>"));
assert.ok(render("codemode", failedScriptArgs, failedScript, { isError: true, expanded: true }).some((line) => line.includes("exit 1")));
// An image has no text rows, so Pi's renderer keeps that result.
const imageBase = { renderResult: () => new Text("image from base", 0, 0) };
assert.deepEqual(
	render("codemode", { code: optionsCode }, { content: [{ type: "image", data: "x", mimeType: "image/png" }], details: { calls: [] } }, {}, imageBase),
	[` ${BULLET} Codemode(return 1;)`, "   ⎿  image from base"],
);
console.log("CODEMODE: one call row, nested calls and output body, script on expand");
// --- MCP tools: MCP server/tool titles, one-line summary, full output on expand. ---
const mcpOutput = numbered(6);
assert.deepEqual(render("mcp__rea__open_binary", { path: "/repo/app.bin" }, text(mcpOutput)), [
	` ${BULLET} MCP rea/open_binary(path: "app.bin")`,
	"   ⎿  Returned 6 lines (ctrl+o to expand)",
]);
assert.deepEqual(render("mcp__rea__open_binary", { path: "/repo/app.bin" }, text(mcpOutput), { expanded: true }), [
	` ${BULLET} MCP rea/open_binary(path: "app.bin")`,
	"   ⎿  Returned 6 lines",
	...Array.from({ length: 6 }, (_, i) => `      line ${i + 1}`),
]);
const notionJson = JSON.stringify({ results: [{ title: "Q4" }, { title: "OKRs" }], type: "search" }, null, 2);
assert.deepEqual(render("mcp__notion__notion-search", { query: "Q4" }, text(notionJson)), [
	` ${BULLET} MCP notion/search(query: "Q4")`,
	"   ⎿  Returned 2 results (ctrl+o to expand)",
]);
const notionExpanded = render("mcp__notion__notion-search", { query: "Q4" }, text(notionJson), { expanded: true });
assert.deepEqual(notionExpanded.slice(2).map((line) => line.slice(6)), notionJson.split("\n"),
	"Expanded MCP output must show every line");
assert.equal(render("mcp__x__get", {}, text('{"quotes":[{"a":1}]}'))[1], "   ⎿  Returned 1 quote (ctrl+o to expand)");
assert.equal(render("mcp__x__get", {}, text("[1,2,3]"))[1], "   ⎿  Returned 3 items (ctrl+o to expand)");
assert.equal(render("mcp__x__get", {}, text("{}"))[1], "   ⎿  Returned 0 fields (ctrl+o to expand)");
const spilled = { content: [{ type: "text", text: "a" }], details: { fullOutputPath: "/tmp/out.txt" } };
assert.equal(render("mcp__x__get", {}, spilled, { expanded: true }).at(-1), "      Full output: /tmp/out.txt");
assert.equal(render("mcp__x__get", {}, spilled).length, 2, "Folded MCP rows hide the full-output path");
assert.deepEqual(
	render("mcp__rea__open_binary", { path: "/repo/app.bin" }, text(""), { isPartial: true }).slice(1),
	["   ⎿  Running…"],
);
assert.deepEqual(render("mcp__x__get", {}, text(""))[1], "   ⎿  (No content)");
assert.deepEqual(
	render("read_mcp_resource", { server: "rea", uri: "rea://target" }, text("resource data")),
	[
		` ${BULLET} MCP read_resource(server: "rea", uri: "rea://target")`,
		"   ⎿  Returned 1 line (ctrl+o to expand)",
	],
);
const failedMcp = render(
	"mcp__rea__open_binary",
	{ path: "app.bin" },
	text("Engine failed"),
	{ isError: true },
	undefined,
	80,
	tagged,
);
assert.match(failedMcp[0]!, new RegExp(`<error>${BULLET}</error>`));
assert.match(failedMcp.at(-1)!, /<error>Engine failed<\/error>/);
console.log("MCP: MCP server/tool title, summary row, full output on expand, running/error states");

// --- Every row fits the width. ---
const narrow = [
	...render("bash", { command: "y".repeat(90) }, text("z".repeat(300)), {}, undefined, 24),
	...render("write", { path: "/repo/" + "d".repeat(50), content: "w".repeat(90) }, text("ok"), {}, undefined, 24),
	...render("grep", { pattern: "p".repeat(40) }, text("hit"), {}, undefined, 24),
];
for (const line of narrow) assert.ok(visibleWidth(line) <= 24, `too wide: ${JSON.stringify(line)}`);
console.log("WIDTH: rows fit narrow terminals");

// --- outputPad follows settings; a stale runtime falls back to 1. ---
const noPad = install(() => ({ outputPad: 0 }));
assert.equal(noPad("bash").renderCall({ command: "ls" }, plain, context({})).render(40)[0], `${BULLET} Bash(ls)`);
const stale = install(() => {
	throw new Error("stale");
});
assert.equal(stale("bash").renderCall({ command: "ls" }, plain, context({})).render(40)[0], ` ${BULLET} Bash(ls)`);
console.log("PADDING: outputPad setting respected");

// --- Re-renders reuse the wrapper components. ---
const bash = resolve("bash");
const firstCall = bash.renderCall({ command: "ls" }, plain, context({}));
assert.equal(bash.renderCall({ command: "ls -la" }, plain, context({}, { lastComponent: firstCall })), firstCall);
assert.equal(firstCall.render(40)[0], ` ${BULLET} Bash(ls -la)`);
console.log("REUSE: renderers update the previous component");

console.log("\nALL TESTS PASSED");
