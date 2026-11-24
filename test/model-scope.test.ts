/** Run with: node test/model-scope.test.ts */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { installModelScopeNotice, patchModelScopeNotice } from "../extensions/util/model-scope.ts";

initTheme("dark", false);
const proto = InteractiveMode.prototype as any;
const original = proto.getModelScopeNotice;
const cycle = proto.cycleModel;
const scopedModels = [{ model: { id: "example-model" }, thinkingLevel: "high" }];
const mode: any = Object.create(proto);
Object.defineProperties(mode, {
	session: { value: { scopedModels } },
	options: { value: {} },
	settingsManager: { value: { getQuietStartup: () => false } },
	keybindings: { value: { getKeys: () => ["ctrl+p"] } },
	headerContainer: { value: new Container() },
});
assert.match(stripTerminalSequences(mode.getModelScopeNotice()), /Model scope: example-model:high.*to cycle/);
mode.showFullscreenModelScopeNotice();
assert.equal(mode.headerContainer.children.length, 2);
mode.headerContainer.clear();

const undo = patchModelScopeNotice()!;
assert.ok(undo);
assert.equal(mode.getModelScopeNotice(), undefined, "Regular mode must have no notice to print");
mode.showFullscreenModelScopeNotice();
assert.equal(mode.headerContainer.children.length, 0, "Fullscreen must add neither notice nor spacer");
assert.equal(mode.session.scopedModels, scopedModels);
assert.equal(proto.cycleModel, cycle);
assert.equal(mode.shouldShowStartupDetails(), true, "Resource lists must remain visible");
undo();
assert.equal(proto.getModelScopeNotice, original);

const older = patchModelScopeNotice()!;
const newer = patchModelScopeNotice()!;
older();
assert.equal(mode.getModelScopeNotice(), undefined);
newer();
assert.equal(proto.getModelScopeNotice, original);

const handlers = new Map<string, any>();
installModelScopeNotice({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
assert.equal(mode.getModelScopeNotice(), undefined, "Patch must apply before session_start");
handlers.get("session_shutdown")();
assert.equal(proto.getModelScopeNotice, original);

proto.getModelScopeNotice = undefined;
assert.equal(patchModelScopeNotice(), undefined);
installModelScopeNotice({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
for (const mode of ["print", "json", "rpc"]) handlers.get("session_start")({}, { mode });
const warnings: any[] = [];
handlers.get("session_start")({}, { mode: "tui", ui: { notify: (...args: any[]) => warnings.push(args) } });
assert.equal(warnings[0][1], "warning");
handlers.get("session_shutdown")();
proto.getModelScopeNotice = original;

const registry = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
assert.match(registry, /installModelScopeNotice\(pi\)/);
console.log("PASS: model scope notice hidden, no fullscreen spacer, scoping preserved, reload, and compatibility");
