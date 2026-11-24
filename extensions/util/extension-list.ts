import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORIGINAL = Symbol.for("pi-warehouse.extension-list");

type ExtensionEntry = { path: string };
type ListMethods = {
	getCompactExtensionLabels(extensions: ExtensionEntry[]): string[];
	formatExtensionDisplayPath(path: string): string;
};
type ListPrototype = ListMethods & { [ORIGINAL]?: ListMethods };

function withoutSuffix(label: string): string {
	return label.replace(/\.(?:ts|js)$/, "");
}

/** Pi has no resource-list hook. Patch only its extension label formatters. */
export function patchExtensionList(): (() => void) | undefined {
	const proto = InteractiveMode.prototype as unknown as ListPrototype;
	if (typeof proto.getCompactExtensionLabels !== "function" || typeof proto.formatExtensionDisplayPath !== "function") return;
	const original = (proto[ORIGINAL] ??= {
		getCompactExtensionLabels: proto.getCompactExtensionLabels,
		formatExtensionDisplayPath: proto.formatExtensionDisplayPath,
	});

	function getCompactExtensionLabels(this: ListMethods, extensions: ExtensionEntry[]): string[] {
		return original.getCompactExtensionLabels.call(this, extensions).map(withoutSuffix);
	}

	function formatExtensionDisplayPath(this: ListMethods, path: string): string {
		return withoutSuffix(original.formatExtensionDisplayPath.call(this, path));
	}

	proto.getCompactExtensionLabels = getCompactExtensionLabels;
	proto.formatExtensionDisplayPath = formatExtensionDisplayPath;
	return () => {
		// A shutdown from an older runtime must not remove the new runtime's patch.
		if (proto.getCompactExtensionLabels === getCompactExtensionLabels) proto.getCompactExtensionLabels = original.getCompactExtensionLabels;
		if (proto.formatExtensionDisplayPath === formatExtensionDisplayPath) proto.formatExtensionDisplayPath = original.formatExtensionDisplayPath;
	};
}

export function installExtensionList(pi: ExtensionAPI): void {
	let unpatch: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unpatch?.();
		unpatch = patchExtensionList();
		if (!unpatch) ctx.ui.notify("Extension label cleanup is not compatible with this Pi version.", "warning");
	});
	pi.on("session_shutdown", () => {
		unpatch?.();
		unpatch = undefined;
	});
}
