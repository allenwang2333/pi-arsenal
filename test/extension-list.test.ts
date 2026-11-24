/** Run with: node test/extension-list.test.ts */
import assert from "node:assert/strict";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installExtensionList, patchExtensionList } from "../extensions/util/extension-list.ts";

initTheme("dark", false);
const proto = InteractiveMode.prototype as any;
const originalCompact = proto.getCompactExtensionLabels;
const originalExpanded = proto.formatExtensionDisplayPath;
const entries = [
	{ path: "/tmp/extensions/index.ts" },
	{ path: "/tmp/extensions/herdr-agent-state.ts" },
	{ path: "/tmp/other/helper.js" },
	{ path: "/tmp/node_modules/example/extensions/provider.ts", sourceInfo: { source: "npm:example", scope: "user" } },
	{ path: "/tmp/hidden.ts", hidden: true },
];
const mode: any = Object.create(proto);
const fields = {
	options: {},
	settingsManager: { getQuietStartup: () => false },
	loadedResourcesContainer: new Container(),
	session: {
		resourceLoader: {
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getExtensions: () => ({ extensions: entries, errors: [] }),
			getSystemPromptSource: () => undefined,
			getAppendSystemPromptSources: () => [],
			getAgentsFiles: () => ({ agentsFiles: [] }),
		},
		promptTemplates: [],
		extensionRunner: {
			getCommandDiagnostics: () => [],
			getShortcutDiagnostics: () => [],
			getRegisteredCommands: () => [],
		},
	},
};
for (const [key, value] of Object.entries(fields)) Object.defineProperty(mode, key, { value, writable: true });

// Reproduce the original suffixes, then exercise Pi's actual startup list.
assert.ok(mode.getCompactExtensionLabels(entries).includes("herdr-agent-state.ts"));
const undo = patchExtensionList();
assert.ok(undo);
assert.deepEqual(mode.getCompactExtensionLabels(entries).slice(0, 4), [
	"extensions", "herdr-agent-state", "helper", "example:provider",
]);
assert.deepEqual(mode.getCompactExtensionLabels([]), []);
assert.equal(mode.formatExtensionDisplayPath("/tmp/foo.ts/bar.js"), "/tmp/foo.ts/bar");
assert.equal(mode.formatExtensionDisplayPath("/tmp/extensions/index.ts"), "/tmp/extensions");
assert.equal(mode.formatExtensionDisplayPath("/tmp/no-suffix"), "/tmp/no-suffix");
for (const expanded of [false, true]) {
	mode.toolOutputExpanded = expanded;
	mode.showLoadedResources();
	const text = mode.loadedResourcesContainer.render(160).map(stripTerminalSequences).join("\n");
	assert.match(text, /\[Extensions\]/);
	assert.match(text, /herdr-agent-state/);
	assert.match(text, /helper/);
	assert.match(text, /example/);
	assert.doesNotMatch(text, /\.ts|\.js|hidden|claude-spinner/);
	for (const width of [1, 4, 12, 40, 80]) {
		for (const line of mode.loadedResourcesContainer.render(width)) assert.ok(visibleWidth(line) <= width);
	}
	mode.loadedResourcesContainer.invalidate();
	assert.doesNotMatch(mode.loadedResourcesContainer.render(160).join("\n"), /\.ts|\.js/);
}
undo();
assert.equal(proto.getCompactExtensionLabels, originalCompact);
assert.equal(proto.formatExtensionDisplayPath, originalExpanded);

// Reload must not stack wrappers or let an old runtime undo a newer patch.
const older = patchExtensionList()!;
const newer = patchExtensionList()!;
older();
assert.ok(mode.getCompactExtensionLabels(entries).includes("herdr-agent-state"));
newer();
assert.equal(proto.getCompactExtensionLabels, originalCompact);
assert.equal(proto.formatExtensionDisplayPath, originalExpanded);

const handlers = new Map<string, any>();
installExtensionList({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
for (const mode of ["print", "json", "rpc"]) {
	handlers.get("session_start")({}, { mode });
	assert.equal(proto.getCompactExtensionLabels, originalCompact);
}
handlers.get("session_start")({}, { mode: "tui" });
assert.notEqual(proto.getCompactExtensionLabels, originalCompact);
handlers.get("session_shutdown")();
assert.equal(proto.getCompactExtensionLabels, originalCompact);

const saved = proto.formatExtensionDisplayPath;
proto.formatExtensionDisplayPath = undefined;
assert.equal(patchExtensionList(), undefined, "Unsupported Pi versions must not be patched");
const warnings: any[] = [];
handlers.get("session_start")({}, { mode: "tui", ui: { notify: (...args: any[]) => warnings.push(args) } });
assert.equal(warnings[0][1], "warning");
proto.formatExtensionDisplayPath = saved;
handlers.get("session_shutdown")();
console.log("PASS: compact and expanded extension names, grouping, widths, reload, modes, and compatibility");
