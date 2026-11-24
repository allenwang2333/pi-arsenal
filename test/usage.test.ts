import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageCommand } from "../extensions/util/usage.ts";

const sessionRoot = await mkdtemp(join(tmpdir(), "pi-usage-sessions-"));
const previousSessionRoot = process.env.PI_SESSION_DIR;
try {
	process.env.PI_SESSION_DIR = sessionRoot;
	const projectDir = join(sessionRoot, "project");
	await mkdir(projectDir);
	await writeFile(
		join(projectDir, "session.jsonl"),
		[
			JSON.stringify({ type: "session", cwd: "/tmp/project" }),
			JSON.stringify({
				type: "message",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					provider: "other-provider",
					model: "other-model",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}),
		].join("\n"),
	);

	const sessionNotifications: Array<{ message: string; kind: string }> = [];
	await usageCommand.handler("", {
		mode: "json",
		sessionManager: { getSessionDir: () => projectDir },
		ui: {
			notify: (message: string, kind: string) => sessionNotifications.push({ message, kind }),
		},
	} as any);
	assert.equal(sessionNotifications[0]?.kind, "info");
	assert.match(sessionNotifications[0]?.message ?? "", /15 tokens/);
	assert.match(sessionNotifications[0]?.message ?? "", /1 sessions/);
} finally {
	if (previousSessionRoot === undefined) delete process.env.PI_SESSION_DIR;
	else process.env.PI_SESSION_DIR = previousSessionRoot;
	await rm(sessionRoot, { recursive: true, force: true });
}

console.log("USAGE TESTS PASSED");
