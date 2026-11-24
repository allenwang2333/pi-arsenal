import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageCommand } from "../extensions/util/usage.ts";

const root = await mkdtemp(join(tmpdir(), "pi-usage-bridge-"));
const previousRoot = process.env.PI_SESSION_DIR;
const projectDir = join(root, "project");
const sessionFile = join(projectDir, "session.jsonl");
const now = new Date().toISOString();
const catalogModel = {
	id: "claude-test",
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const googleModel = {
	id: "gemini-test",
	cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
};
const tieredModel = {
	id: "gemini-tiered",
	cost: {
		...googleModel.cost,
		tiers: [{ inputTokensAbove: 200_000, input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }],
	},
};
const lookups: string[] = [];
const modelRegistry = {
	find: (provider: string, model: string) => {
		lookups.push(`${provider}/${model}`);
		if (provider === "anthropic" && model === catalogModel.id) return catalogModel;
		if (provider === "google" && model === googleModel.id) return googleModel;
		if (provider === "google" && model === tieredModel.id) return tieredModel;
		return undefined;
	},
};

function assistant(provider: string, model: string, usage: object, timestamp = now) {
	return { type: "message", timestamp, message: { role: "assistant", provider, model, usage } };
}

async function save(entries: object[]) {
	const raw = [JSON.stringify({ type: "session", cwd: "/tmp/bridge-project" }), ...entries.map((e) => JSON.stringify(e))].join("\n");
	await writeFile(sessionFile, raw);
	return raw;
}

async function summary(args = "") {
	const notices: Array<{ message: string; kind: string }> = [];
	await usageCommand.handler(args, {
		mode: "json",
		modelRegistry,
		sessionManager: { getSessionDir: () => projectDir },
		ui: { notify: (message: string, kind: string) => notices.push({ message, kind }) },
	} as any);
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.kind, "info");
	return notices[0]!.message;
}

async function report(args = "") {
	const lines = new Set<string>();
	await usageCommand.handler(args, {
		mode: "tui",
		modelRegistry,
		sessionManager: { getSessionDir: () => projectDir },
		ui: {
			notify: (message: string) => assert.fail(message),
			custom: async (factory: any) => {
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					() => {},
				);
				for (let i = 0; i < 10; i++) {
					for (const line of component.render(200)) lines.add(line.trim());
					component.handleInput("\x1b[6~");
				}
			},
		},
	} as any);
	return [...lines].join("\n");
}

try {
	process.env.PI_SESSION_DIR = root;
	await mkdir(projectDir);
	const raw = await save([
		assistant("other-provider", "paid", { input: 10, output: 5, cost: { total: 0.01 } }),
		assistant("claude-bridge", "claude-test", {
			input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 4_000_000,
			reasoning: 1_000_000, cost: { total: 0 },
		}),
		assistant("claude-bridge", "claude-test", { input: 1_000_000 }),
		assistant("claude-bridge", "claude-test", { input: 10, cost: { total: 7 } }),
		assistant("claude-bridge", "unknown", { input: 13, cost: { total: 0 } }),
		assistant("other-provider", "free", { input: 100, cost: { total: 0 } }),
		assistant("claude-bridge", "claude-test", { input: 1_000_000, cost: { total: 0 } }, "2000-01-01T12:00:00.000Z"),
	]);
	assert.match(await summary("today"), /11,000,138 tokens · ~\$93\.51/);
	assert.match(await summary("1"), /~\$93\.51/);
	assert.match(await summary(), /12,000,138 tokens · ~\$98\.51/);
	assert.match(await summary(), /API-equivalent.*not subscription charges/);
	assert.ok(lookups.includes("anthropic/claude-test"));
	assert.ok(!lookups.some((key) => key.startsWith("claude-bridge/")));

	const rendered = await report("today");
	assert.match(rendered, /claude-bridge\/claude-test\s+11,000,010\s+~\$93\.50/);
	assert.match(rendered, /other-provider\/paid\s+15\s+\$0\.01/);
	assert.match(rendered, /other-provider\/free\s+100\s+\$0\.00/);
	assert.match(rendered, /claude-bridge\/unknown\s+13\s+\$0\.00/);
	assert.match(rendered, /\/tmp\/bridge-project\s+11,000,138\s+~\$93\.51\s+1/);
	assert.match(rendered, /\d{4}-\d{2}-\d{2}\s+11,000,138\s+~\$93\.51/);
	assert.match(rendered, /current Anthropic\/Google catalog rates/);
	assert.match(rendered, /not subscription charges/);
	assert.match(rendered, /without catalog prices.*\$0\.00/);
	const allTime = await report();
	assert.match(allTime, /BY MONTH/);
	assert.match(allTime, /^\d{4}-\d{2}\s+11,000,138\s+~\$93\.51$/m);
	assert.match(allTime, /^2000-01\s+1,000,000\s+~\$5\.00$/m);
	assert.match(allTime, /^2000-01-01\s+1,000,000\s+~\$5\.00$/m);
	assert.equal(await readFile(sessionFile, "utf8"), raw, "estimates must not rewrite sessions");

	await save([assistant("claude-bridge", "unknown", { input: 13, cost: { total: 0 } })]);
	assert.match(await summary(), /13 tokens · \$0\.00/);
	assert.match(await summary(), /without catalog prices/);
	assert.doesNotMatch(await report(), /API-equivalent/);

	await save([assistant("claude-bridge", "claude-test", { input: 10, cost: { total: 7 } })]);
	lookups.length = 0;
	assert.match(await summary(), /10 tokens · \$7\.00/);
	assert.doesNotMatch(await report(), /API-equivalent|without catalog prices/);
	assert.equal(lookups.length, 0, "reported nonzero costs must not be recalculated");

	await save([assistant("antigravity", "gemini-test", {
		input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, reasoning: 1_000_000,
		cost: { total: 0 },
	})]);
	assert.match(await summary(), /6,000,000 tokens · ~\$6\.65/);
	assert.match(await report(), /antigravity\/gemini-test\s+6,000,000\s+~\$6\.65/);
	assert.match(await report(), /\/tmp\/bridge-project\s+6,000,000\s+~\$6\.65/);
	assert.ok(lookups.includes("google/gemini-test"));

	await save([assistant("antigravity", "gemini-tiered", {
		input: 250_000, output: 100_000, cacheRead: 500_000, cost: { total: 0 },
	})]);
	assert.match(await summary(), /850,000 tokens · ~\$0\.70/);
	await save([assistant("antigravity", "gemini-tiered", { input: 200_000, output: 100_000 })]);
	assert.match(await summary(), /300,000 tokens · ~\$0\.40/);

	await save([assistant("antigravity", "gemini-test", { input: 1_000_000_000 })]);
	assert.match(await report(), /antigravity\/gemini-test\s+1,000,000,000\s+~\$500/);

	await save([assistant("antigravity", "claude-test", { input: 1_000_000 })]);
	assert.match(await summary(), /~\$5\.00/);
	await save([assistant("antigravity", "gemini-test", { input: 10, cost: { total: 2 } })]);
	assert.match(await summary(), /10 tokens · \$2\.00/);
	await save([assistant("antigravity", "gemini-unknown", { input: 10 })]);
	assert.match(await summary(), /without catalog prices.*antigravity\/gemini-unknown/);

	await save([{
		type: "usage", timestamp: now, kind: "cache_warm", provider: "antigravity", model: "gemini-test",
		usage: { cacheRead: 1_000_000 },
	}]);
	assert.match(await summary(), /1,000,000 tokens · ~\$0\.05/);

	await save([assistant("claude-bridge", "claude-test", { input: 1_000_000 })]);
	const secondSession = join(projectDir, "second.jsonl");
	await writeFile(secondSession, [
		JSON.stringify({ type: "session", cwd: "/tmp/bridge-project" }),
		JSON.stringify(assistant("antigravity", "gemini-test", { input: 1_000_000 })),
	].join("\n"));
	const secondProject = join(root, "another-project");
	await mkdir(secondProject);
	await writeFile(join(secondProject, "session.jsonl"), [
		JSON.stringify({ type: "session", cwd: "/tmp/second-project" }),
		JSON.stringify(assistant("claude-bridge", "claude-test", { input: 1_000_000 })),
	].join("\n"));
	assert.match(await summary(), /3,000,000 tokens · ~\$10\.50 · 3 sessions/);
	const projects = await report();
	assert.match(projects, /\/tmp\/bridge-project\s+2,000,000\s+~\$5\.50\s+2/);
	assert.match(projects, /\/tmp\/second-project\s+1,000,000\s+~\$5\.00\s+1/);
	await rm(secondSession);
	await rm(secondProject, { recursive: true });

	await save([assistant("claude-bridge", "claude-test", { input: 0, output: 0, cost: { total: 0 } })]);
	const notices: string[] = [];
	await usageCommand.handler("", {
		mode: "json", modelRegistry,
		ui: { notify: (message: string) => notices.push(message) },
	} as any);
	assert.match(notices[0] ?? "", /no usage data/);
} finally {
	if (previousRoot === undefined) delete process.env.PI_SESSION_DIR;
	else process.env.PI_SESSION_DIR = previousRoot;
	await rm(root, { recursive: true, force: true });
}

console.log("USAGE COST TESTS PASSED");
