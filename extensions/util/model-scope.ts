import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORIGINAL = Symbol.for("pi-warehouse.model-scope");
type ScopePrototype = {
	getModelScopeNotice(): string | undefined;
	[ORIGINAL]?: () => string | undefined;
};

/** Pi has no setting that hides only this notice. Leave model scoping intact. */
export function patchModelScopeNotice(): (() => void) | undefined {
	const proto = InteractiveMode.prototype as unknown as ScopePrototype;
	if (typeof proto.getModelScopeNotice !== "function") return;
	const original = (proto[ORIGINAL] ??= proto.getModelScopeNotice);
	function getModelScopeNotice(): undefined {
		return undefined;
	}
	proto.getModelScopeNotice = getModelScopeNotice;
	return () => {
		if (proto.getModelScopeNotice === getModelScopeNotice) proto.getModelScopeNotice = original;
	};
}

export function installModelScopeNotice(pi: ExtensionAPI): void {
	// Both renderers show the notice before session_start, so patch during loading.
	const unpatch = patchModelScopeNotice();
	pi.on("session_start", (_event, ctx) => {
		if (!unpatch && ctx.mode === "tui") {
			ctx.ui.notify("Model scope notice cleanup is not compatible with this Pi version.", "warning");
		}
	});
	pi.on("session_shutdown", () => unpatch?.());
}
