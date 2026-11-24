/**
 * Tests for extensions/tools/background-process.ts.
 *
 * The extension factory runs against a fake ExtensionAPI, so the whole process
 * lifecycle, error paths, log tails, widget, and shutdown cleanup are exercised
 * without a pi process. Run with: node test/background-process.test.ts
 */
import { createRequire, registerHooks } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

// Pi supplies these dependencies to extensions; the configuration has no package.json.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const aliases = new Map([
	["typebox", hostRequire.resolve("typebox")],
	["@earendil-works/pi-ai", new URL("core/extensions/pi-ai-extension-view.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href],
]);
registerHooks({ resolve(specifier, context, nextResolve) {
	return nextResolve(aliases.get(specifier) ?? specifier, context);
} });
const { default: createExtension } = await import("../extensions/tools/background-process.ts");

const tools: any[] = [];
const handlers = new Map<string, (...args: any[]) => any>();
createExtension({
	registerTool: (tool: any) => tools.push(tool),
	on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
} as any);

assert.equal(tools.length, 1, "registers exactly one tool");
const tool = tools[0];
assert.equal(tool.name, "background-process");
assert.equal(tool.parameters.properties.timeoutSeconds.maximum, 24 * 60 * 60);
assert.equal(tool.parameters.properties.outputLines.maximum, 500);

const widgets: { content: any; options?: any }[] = [];
const ctx = {
	cwd: process.cwd(),
	mode: "tui",
	ui: { setWidget: (_id: string, content: any, options?: any) => widgets.push({ content, options }) },
};
const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text };
const logDirs = new Set<string>();

handlers.get("session_start")!({}, ctx);

async function call(params: any) {
	const result = await tool.execute("test-id", params, undefined, undefined, ctx);
	if (params.action === "start") logDirs.add(dirname(result.details.stdoutPath));
	return result;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Poll status until the process has finished, then return the final status. */
async function finish(processId: string, timeoutMs = 5000) {
	let status: any;
	await waitUntil(`${processId} to finish`, async () => {
		status = await call({ action: "status", processId });
		return !status.details.isRunning;
	}, timeoutMs);
	return status;
}

function widgetText(): string | null {
	const content = widgets.at(-1)?.content;
	return content ? content({}, theme).render(120).join("\n") : null;
}

try {
	// --- happy path: start returns immediately, output is captured ---
	let res = await call({ action: "start", command: "echo hello; sleep 0.3; echo done", timeoutSeconds: 30 });
	assert.equal(res.details.status, "running");
	assert.equal(res.details.isRunning, true);
	assert.ok(res.details.pid > 0);
	const happyId = res.details.id;
	let status = await finish(happyId);
	assert.equal(status.details.status, "completed");
	assert.equal(status.details.exitCode, 0);
	assert.match(status.content[0].text, /hello/);
	assert.match(status.content[0].text, /done/);
	console.log("HAPPY PATH: completed, exit 0, output captured");

	// --- non-zero exit: failed, exit code and both streams kept ---
	res = await call({ action: "start", command: "echo out; echo err >&2; exit 3", timeoutSeconds: 10 });
	status = await finish(res.details.id);
	assert.equal(status.details.status, "failed");
	assert.equal(status.details.exitCode, 3);
	assert.match(status.content[0].text, /out/);
	assert.match(status.content[0].text, /err/);
	console.log("NON-ZERO EXIT: failed, exit 3, streams split");

	// --- timeout: SIGTERM at the limit, process group gone ---
	res = await call({ action: "start", command: "sleep 30", timeoutSeconds: 1 });
	const timeoutPid = res.details.pid;
	status = await finish(res.details.id);
	assert.equal(status.details.status, "timed_out");
	assert.equal(status.details.exitSignal, "SIGTERM");
	await waitUntil("timed-out process to exit", () => !isAlive(timeoutPid));
	console.log("TIMEOUT: timed_out, SIGTERM, process gone");

	// --- stop cancels the group, including a grandchild ---
	res = await call({ action: "start", command: "sleep 60 & echo grandchild=$!; wait", timeoutSeconds: 60 });
	const cancelId = res.details.id;
	let grandchild = 0;
	await waitUntil("grandchild pid", async () => {
		status = await call({ action: "status", processId: cancelId });
		const match = status.content[0].text.match(/grandchild=(\d+)/);
		if (!match) return false;
		grandchild = Number(match[1]);
		return true;
	});
	assert.ok(isAlive(grandchild), "grandchild should be running");
	status = await call({ action: "stop", processId: cancelId });
	assert.match(status.content[0].text, /Requested stop/);
	status = await finish(cancelId);
	assert.equal(status.details.status, "cancelled");
	await waitUntil("process group to exit", () => !isAlive(grandchild));
	console.log("STOP: cancelled, grandchild killed");

	// --- stopping an already-finished process is a no-op ---
	status = await call({ action: "stop", processId: happyId });
	assert.match(status.content[0].text, /already finished/);

	// --- bad cwd fails fast with the directory in the message ---
	const missingDir = join(tmpdir(), `pi-bg-missing-${Date.now()}`);
	await expectError(/Working directory does not exist/, () =>
		call({ action: "start", command: "echo x", cwd: missingDir }),
	);
	const fileDir = await mkdtemp(join(tmpdir(), "pi-bg-file-"));
	await writeFile(join(fileDir, "file.txt"), "x");
	await expectError(/not a directory/, () =>
		call({ action: "start", command: "echo x", cwd: join(fileDir, "file.txt") }),
	);
	await rm(fileDir, { recursive: true, force: true });
	console.log("BAD CWD: rejected up front");

	// --- spawn failure is reported with the cwd ---
	const savedShell = process.env.SHELL;
	process.env.SHELL = "/nonexistent-pi-shell-xyz";
	try {
		res = await call({ action: "start", command: "echo x", timeoutSeconds: 10 });
	} finally {
		process.env.SHELL = savedShell;
	}
	status = await finish(res.details.id);
	assert.equal(status.details.status, "failed");
	assert.match(status.details.error, /spawn failed in/);
	console.log("SPAWN FAILURE: reported with cwd");

	// --- invalid arguments ---
	await expectError(/requires a non-empty command/, () => call({ action: "start" }));
	await expectError(/Unknown background process/, () => call({ action: "status", processId: "bg_999" }));
	await expectError(/requires processId/, () => call({ action: "status" }));

	// --- large output is truncated with a marker ---
	res = await call({ action: "start", command: "for i in $(seq 1 3000); do echo line $i; done", timeoutSeconds: 30 });
	status = await finish(res.details.id);
	assert.equal(status.details.status, "completed");
	status = await call({ action: "status", processId: res.details.id, outputLines: 3 });
	assert.match(status.content[0].text, /\[earlier output omitted\]/);
	assert.match(status.content[0].text, /line 3000/);
	console.log("LARGE OUTPUT: truncated with marker");

	// --- list reports every process in order ---
	const list = await call({ action: "list" });
	assert.ok(list.details.processes.length >= 6);
	assert.match(list.content[0].text, /bg_1: completed/);
	console.log("LIST: reports all processes");

	// --- widget: collapsed by default behind running count hint; click expands ---
	res = await call({ action: "start", command: "sleep 0.4", timeoutSeconds: 10 });
	const widgetId = res.details.id;
	assert.equal(widgets.at(-1)?.options?.placement, "aboveEditor");
	assert.match(widgetText() ?? "", /● Background Processes \(\d+\/\d+\)/);
	assert.match(widgetText() ?? "", /1 running hidden \(click to show\)/);
	assert.ok(!widgetText()?.includes(`${widgetId} running`), "running row hidden while collapsed");
	for (const line of widgets.at(-1)!.content({}, theme).render(30)) {
		assert.ok(visibleWidth(line) <= 30, `widget line exceeds width: ${line}`);
	}
	await finish(widgetId);
	await waitUntil("finished row to be hidden", () => (widgetText() ?? "").includes("finished hidden"));
	const hidden = widgetText() ?? "";
	assert.ok(!hidden.includes(`${widgetId} completed`), "completed row is hidden");
	assert.match(hidden, /\d+ finished hidden \(click to show\)/);
	assert.match(hidden, /└─ \d+ finished hidden/, "hint is the last row");
	console.log("WIDGET: collapsed by default, finished hidden with a hint");

	// --- a left click expands rows (completed and failed); another collapses them ---
	res = await call({ action: "start", command: "exit 3", timeoutSeconds: 10 });
	const failedId = res.details.id;
	await finish(failedId);
	const click = { type: "click", button: "left", x: 1, y: 0, width: 60, height: 5 };
	const panel = () => widgets.at(-1)!.content({}, theme);
	assert.ok(!(widgetText() ?? "").includes(failedId), "failed row is hidden");
	assert.equal(panel().handleMouse({ ...click, button: "right" }), undefined, "only left click toggles");
	assert.ok(panel().handleMouse(click)?.handled);
	const shown = widgetText() ?? "";
	assert.match(shown, new RegExp(`${widgetId} completed`));
	assert.match(shown, new RegExp(`${failedId} failed`));
	assert.ok(!shown.includes("click to show"), "no hint while finished rows show");
	assert.ok(panel().handleMouse(click)?.handled);
	assert.ok(!(widgetText() ?? "").includes(failedId), "second click hides finished rows again");
	console.log("CLICK: rows toggle between collapsed and expanded");

	// --- running processes when collapsed show running hint; clicking shows all ---
	res = await call({ action: "start", command: "sleep 30", timeoutSeconds: 60 });
	const longId = res.details.id;
	const mixed = widgetText() ?? "";
	assert.match(mixed, /1 running hidden \(click to show\)/);
	assert.ok(panel().handleMouse(click)?.handled);
	assert.match(widgetText() ?? "", new RegExp(`${longId} running`));
	assert.ok(panel().handleMouse(click)?.handled);
	assert.ok(!widgetText()?.includes(`${longId} running`));
	await call({ action: "stop", processId: longId });
	await finish(longId);
	console.log("MIXED: running processes collapsed by default and expandable");

	// --- a finished turn hides finished rows; running rows stay; status still works ---
	res = await call({ action: "start", command: "sleep 30", timeoutSeconds: 60 });
	const keepId = res.details.id;
	handlers.get("agent_settled")!({ aborted: false }, ctx);
	assert.match(widgetText() ?? "", /Background Processes \(0\/1\)/);
	assert.ok(panel().handleMouse(click)?.handled);
	assert.match(widgetText() ?? "", new RegExp(`${keepId} running`));
	assert.ok(!widgetText()?.includes(`${happyId} `), "dismissed row is hidden even when expanded");
	assert.ok(panel().handleMouse(click)?.handled);
	status = await call({ action: "status", processId: happyId });
	assert.equal(status.details.status, "completed", "status still reports dismissed processes");
	await call({ action: "stop", processId: keepId });
	await finish(keepId);
	assert.match(widgetText() ?? "", /Background Processes \(1\/1\)/, "finished row shows until the turn ends");
	handlers.get("agent_settled")!({ aborted: false }, ctx);
	assert.equal(widgetText(), null, "panel goes away when every row is dismissed");
	console.log("TURN END: finished processes dismissed after each turn");

	// --- session shutdown kills running processes ---
	handlers.get("session_start")!({}, ctx);
	res = await call({ action: "start", command: "sleep 60", timeoutSeconds: 300 });
	const shutdownPid = res.details.pid;
	assert.ok(isAlive(shutdownPid));
	handlers.get("session_shutdown")!({}, ctx);
	await waitUntil("shutdown to kill the process", () => !isAlive(shutdownPid));
	console.log("SHUTDOWN: running process killed");
} finally {
	// Never leave detached processes or temp log dirs behind, even on failure.
	handlers.get("session_shutdown")!({}, ctx);
	for (const dir of logDirs) await rm(dir, { recursive: true, force: true });
}

console.log("\nALL TESTS PASSED");
