import { createRequire, registerHooks } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Use the same pi-ai exports that Pi supplies to extensions.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const aliases = new Map([
	["typebox", hostRequire.resolve("typebox")],
	["@earendil-works/pi-ai", new URL("core/extensions/pi-ai-extension-view.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href],
]);
registerHooks({ resolve(specifier, context, nextResolve) {
	return nextResolve(aliases.get(specifier) ?? specifier, context);
} });
const { default: installExtensions } = await import("../extensions/index.ts");
const { default: createExtension } = await import("../extensions/tools/edit.ts");


const registryTools: any[] = [];
const registryCommands: string[] = [];
installExtensions({
	registerTool: (tool: any) => registryTools.push(tool),
	registerCommand: (name: string) => registryCommands.push(name),
	on: () => {},
	registerToolRenderer: () => {},
} as any);
assert.deepEqual(registryTools.map((tool) => tool.name), ["edit", "background-process"]);
assert.deepEqual(registryCommands, ["context", "usage"]);
// Capture registered tools via a minimal ExtensionAPI stub.
const tools: any[] = [];
const fakePi: any = {
	registerTool: (def: any) => {
		tools.push(def);
	},
	on: () => {},
};
createExtension(fakePi);
assert.equal(tools.length, 1, "registers only edit");
assert.equal(tools.length, 1, "registers only edit");
const editTool = tools.find((t) => t.name === "edit");
assert.ok(editTool, "edit tool registered");

const rendererColors: string[] = [];
const rendererTheme = {
	fg: (color: string, text: string) => {
		rendererColors.push(color);
		return text;
	},
	bold: (text: string) => text,
};

assert.equal(editTool.renderShell, "default");
const callDisplay = editTool
	.renderCall({ action: "view", path: "sample.ts" }, rendererTheme, {} as any)
	.render(120)
	.join("\n");
assert.match(callDisplay, /edit sample\.ts \(view\)/);
assert.deepEqual(rendererColors, ["toolTitle", "accent", "dim"]);

// --- partial streaming args must not render as an invalid path ---
const partialDisplay = editTool
	.renderCall({ action: "view" }, rendererTheme, { argsComplete: false } as any)
	.render(120)
	.join("\n");
assert.match(partialDisplay, /edit … \(view\)/);
assert.doesNotMatch(partialDisplay, /invalid path/);

// --- file_path alias renders like path (prepareArguments maps it for execute) ---
const aliasDisplay = editTool
	.renderCall({ action: "view", file_path: "alias.ts" }, rendererTheme, { argsComplete: true } as any)
	.render(120)
	.join("\n");
assert.match(aliasDisplay, /edit alias\.ts \(view\)/);

// --- a settled call that still has no path says so instead of "invalid" ---
const missingDisplay = editTool
	.renderCall({ action: "view" }, rendererTheme, { argsComplete: true } as any)
	.render(120)
	.join("\n");
assert.match(missingDisplay, /edit \(missing path\) \(view\)/);

const rendererResult = {
	content: [{ type: "text", text: "hashline view\n\x1b[31mred\x1b[0m" }],
	details: { lines: 2, shown: 2 },
};
rendererColors.length = 0;
const collapsedDisplay = editTool
	.renderResult(
		rendererResult,
		{ expanded: false, isPartial: false },
		rendererTheme,
		{ args: { action: "view", path: "sample.ts" }, isError: false } as any,
	)
	.render(120)
	.join("\n");
assert.match(collapsedDisplay, /Viewed 2 lines/);
assert.doesNotMatch(collapsedDisplay, /hashline view/);

rendererColors.length = 0;
const expandedDisplay = editTool
	.renderResult(
		rendererResult,
		{ expanded: true, isPartial: false },
		rendererTheme,
		{ args: { action: "view", path: "sample.ts" }, isError: false } as any,
	)
	.render(120)
	.join("\n");
assert.match(expandedDisplay, /hashline view[ \t]*\nred/);
assert.doesNotMatch(expandedDisplay, /\x1b\[/);
assert.ok(rendererColors.includes("toolOutput"));

const replaceDisplay = editTool
	.renderResult(
		{ content: [], details: { editsApplied: 1, linesBefore: 2, linesAfter: 3 } },
		{ expanded: false, isPartial: false },
		rendererTheme,
		{ args: { action: "replace", path: "sample.ts" }, isError: false } as any,
	)
	.render(120)
	.join("\n");
assert.match(replaceDisplay, /Applied 1 edit \(2 → 3 lines\)/);
const dir = await mkdtemp(join(tmpdir(), "hashline-test-"));
const ctx = { cwd: dir };
const file = (name: string) => join(dir, name);

async function callWith(tool: any, params: any) {
	// pi runs prepareArguments before schema validation; mimic that here.
	const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
	return tool.execute("test-id", prepared, undefined, undefined, ctx);
}

async function call(params: any) {
	return callWith(editTool, params);
}

async function expectError(pattern: RegExp, fn: () => Promise<unknown>) {
	let threw = false;
	try {
		await fn();
	} catch (error: any) {
		threw = true;
		assert.match(String(error?.message ?? error), pattern, `expected ${pattern}, got ${error}`);
	}
	assert.ok(threw, `expected an error matching ${pattern}`);
}

function parseView(viewText: string): Map<number, string> {
	const hashes = new Map<number, string>();
	for (const line of viewText.split("\n").slice(1)) {
		const m = line.match(/^\s*(\d+) │ ([0-9a-f]{12}) │ (.*)$/);
		if (m) hashes.set(Number(m[1]), m[2]);
	}
	return hashes;
}

const sample = ["import a from 'a'", "", "const x = 1;", "const y = 2;", "", "export { x, y };"].join("\n") + "\n";
await writeFile(file("sample.ts"), sample);

// --- view ---
let view = await call({ action: "view", path: "sample.ts" });
console.log("VIEW\n" + view.content[0].text + "\n");
let hashes = parseView(view.content[0].text);
assert.equal(hashes.size, 6, "all 6 lines shown");
assert.equal(new Set(hashes.values()).size, 6, "blank duplicate lines get distinct hashes");
assert.equal(view.details.fileHash.length, 12);

// --- single-line replace ---
let res = await call({ action: "replace", path: "sample.ts", edits: [{ hash: hashes.get(3), newText: "const x = 10;" }] });
console.log("R1\n" + res.content[0].text + "\n");
assert.equal(await readFile(file("sample.ts"), "utf8"), sample.replace("const x = 1;", "const x = 10;"));

// --- chained replace from the same view (line count unchanged) ---
res = await call({ action: "replace", path: "sample.ts", edits: [{ hash: hashes.get(4), newText: "const y = 20;" }] });
assert.ok((await readFile(file("sample.ts"), "utf8")).includes("const y = 20;"));

// --- region replace between the two blank lines (boundaries kept) ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
res = await call({
	action: "replace",
	path: "sample.ts",
	edits: [{ startHash: hashes.get(2), endHash: hashes.get(5), newText: "const z = 3;" }],
});
console.log("R3\n" + res.content[0].text + "\n");
assert.equal(await readFile(file("sample.ts"), "utf8"), "import a from 'a'\n\nconst z = 3;\n\nexport { x, y };\n");

// --- insert between adjacent boundaries ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
res = await call({
	action: "replace",
	path: "sample.ts",
	edits: [{ startHash: hashes.get(3), endHash: hashes.get(4), newText: "const w = 4;" }],
});
assert.equal(await readFile(file("sample.ts"), "utf8"), "import a from 'a'\n\nconst z = 3;\nconst w = 4;\n\nexport { x, y };\n");

// --- insert a blank line: lone newline in newText ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "sample.ts", edits: [{ startHash: hashes.get(4), endHash: hashes.get(5), newText: "\n" }] });
assert.equal(await readFile(file("sample.ts"), "utf8"), "import a from 'a'\n\nconst z = 3;\nconst w = 4;\n\n\nexport { x, y };\n");

// --- delete a line ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "sample.ts", edits: [{ hash: hashes.get(5), newText: "" }] });
assert.equal(await readFile(file("sample.ts"), "utf8"), "import a from 'a'\n\nconst z = 3;\nconst w = 4;\n\nexport { x, y };\n");

// --- multiple disjoint edits in one call ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
res = await call({
	action: "replace",
	path: "sample.ts",
	edits: [
		{ hash: hashes.get(3), newText: "const z = 30;" },
		{ hash: hashes.get(6), newText: "export default { x, y };" },
	],
});
assert.equal(await readFile(file("sample.ts"), "utf8"), "import a from 'a'\n\nconst z = 30;\nconst w = 4;\n\nexport default { x, y };\n");

// --- whole-file replace (no anchors) ---
await call({ action: "view", path: "sample.ts" });
await call({ action: "replace", path: "sample.ts", edits: [{ newText: "x\ny\n" }] });
assert.equal(await readFile(file("sample.ts"), "utf8"), "x\ny\n");

// --- append at end (endHash omitted) ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "sample.ts", edits: [{ startHash: hashes.get(2), newText: "z" }] });
assert.equal(await readFile(file("sample.ts"), "utf8"), "x\ny\nz\n");

// --- top of file (startHash omitted) ---
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "sample.ts", edits: [{ endHash: hashes.get(1), newText: "top" }] });
assert.equal(await readFile(file("sample.ts"), "utf8"), "top\nx\ny\nz\n");

// --- stale file: edit by another tool after view ---
await call({ action: "view", path: "sample.ts" });
await writeFile(file("sample.ts"), "externally changed\n");
await expectError(/changed since the last view/, () =>
	call({ action: "replace", path: "sample.ts", edits: [{ hash: "0123456789ab", newText: "x" }] }),
);

// --- unknown hash ---
await call({ action: "view", path: "sample.ts" });
await expectError(/Unknown line hash "0123456789ab"/, () =>
	call({ action: "replace", path: "sample.ts", edits: [{ hash: "0123456789ab", newText: "x" }] }),
);

// --- replace without any view ---
await expectError(/no view of/, () =>
	call({ action: "replace", path: "never-viewed.ts", edits: [{ newText: "x" }] }),
);

// --- fileHash pinning ---
view = await call({ action: "view", path: "sample.ts" });
const wrongHash = view.details.fileHash === "000000000000" ? "111111111111" : "000000000000";
await expectError(/does not match the last view/, () =>
	call({ action: "replace", path: "sample.ts", fileHash: wrongHash, edits: [{ newText: "x" }] }),
);
await call({ action: "replace", path: "sample.ts", fileHash: view.details.fileHash, edits: [{ newText: "pinned ok\n" }] });
assert.equal(await readFile(file("sample.ts"), "utf8"), "pinned ok\n");

// --- overlapping edits ---
await writeFile(file("sample.ts"), "a\nb\nc\n");
view = await call({ action: "view", path: "sample.ts" });
hashes = parseView(view.content[0].text);
await expectError(/overlap/, () =>
	call({
		action: "replace",
		path: "sample.ts",
		edits: [
			{ hash: hashes.get(2), newText: "B" },
			{ startHash: hashes.get(1), endHash: hashes.get(3), newText: "X" },
		],
	}),
);

// --- mixed hash + region anchors ---
await expectError(/not both/, () =>
	call({
		action: "replace",
		path: "sample.ts",
		edits: [{ hash: hashes.get(1), startHash: hashes.get(1), endHash: hashes.get(2), newText: "b" }],
	}),
);

// --- CRLF file keeps its line endings ---
await writeFile(file("crlf.txt"), "a\r\nb\r\nc\r\n");
view = await call({ action: "view", path: "crlf.txt" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "crlf.txt", edits: [{ hash: hashes.get(2), newText: "B\nD" }] });
assert.equal(await readFile(file("crlf.txt"), "utf8"), "a\r\nB\r\nD\r\nc\r\n");

// --- no trailing newline is preserved ---
await writeFile(file("nonl.txt"), "a\nb");
view = await call({ action: "view", path: "nonl.txt" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "nonl.txt", edits: [{ hash: hashes.get(2), newText: "B" }] });
assert.equal(await readFile(file("nonl.txt"), "utf8"), "a\nB");

// --- empty file: view + whole-file replace ---
await writeFile(file("empty.txt"), "");
view = await call({ action: "view", path: "empty.txt" });
assert.ok(view.content[0].text.includes("0 lines"));
await call({ action: "replace", path: "empty.txt", edits: [{ newText: "now has content" }] });
assert.equal(await readFile(file("empty.txt"), "utf8"), "now has content");

// --- view offset/limit window ---
await writeFile(file("many.ts"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
view = await call({ action: "view", path: "many.ts", offset: 2490, limit: 5 });
const manyText = view.content[0].text;
assert.ok(manyText.includes("line 2490"));
assert.ok(!manyText.includes("line 2489"));
assert.ok(manyText.includes("… 6 more lines below"));
assert.equal(parseView(manyText).size, 5);
// edit a line inside the window
hashes = parseView(manyText);
await call({ action: "replace", path: "many.ts", edits: [{ hash: hashes.get(2493), newText: "line 2493 changed" }] });
assert.equal((await readFile(file("many.ts"), "utf8")).split("\n")[2492], "line 2493 changed");
// edit the final line via a window that ends at EOF (no trailing note)
view = await call({ action: "view", path: "many.ts", offset: 2496, limit: 5 });
assert.ok(!view.content[0].text.includes("more lines below"));
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "many.ts", edits: [{ hash: hashes.get(2500), newText: "line 2500 changed" }] });
assert.equal((await readFile(file("many.ts"), "utf8")).split("\n")[2499], "line 2500 changed");

// --- single edit object (not array) is wrapped ---
await call({ action: "view", path: "many.ts" });
view = await call({ action: "view", path: "many.ts", offset: 1, limit: 3 });
hashes = parseView(view.content[0].text);
await call({ action: "replace", path: "many.ts", edits: { hash: hashes.get(1), newText: "line 1 changed" } });
assert.equal((await readFile(file("many.ts"), "utf8")).split("\n")[0], "line 1 changed");


// --- file_path alias maps to path ---
await writeFile(file("alias.ts"), "x\n");
await call({ action: "view", file_path: "alias.ts" });
view = await call({ action: "view", file_path: "alias.ts" });
hashes = parseView(view.content[0].text);
await call({ action: "replace", file_path: "alias.ts", edits: [{ hash: hashes.get(1), newText: "y" }] });
assert.equal(await readFile(file("alias.ts"), "utf8"), "y\n");

// --- legacy find-and-replace edit calls get a migration error ---
await expectError(/no longer does find-and-replace/, async () => {
	await call({ path: "alias.ts", oldText: "y", newText: "z" });
});

await rm(dir, { recursive: true, force: true });
console.log("\nALL TESTS PASSED");
