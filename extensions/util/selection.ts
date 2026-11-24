/**
 * Theme-colored mouse selection in the fullscreen TUI.
 *
 * Pi highlights a fullscreen selection with reverse video, so selected cells
 * take the text color as their background (black on light themes). This
 * paints the selection with the theme's `selectedBg` and keeps each cell's
 * foreground color.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

const SELECTION_PATCH = Symbol.for("pi-warehouse.selection.highlight");
const SGR = /\x1b\[[0-9;:]*m/g;

type AltScreenPrototype = {
	applySelectionHighlight(text: string): string;
	[SELECTION_PATCH]?: (text: string) => string;
};

/** Pi has no theme token for the selection, so this replaces the highlight. Returns the undo. */
export function patchSelectionHighlight(theme: Theme): () => void {
	const proto = TuiAltScreen.prototype as unknown as AltScreenPrototype;
	const original = (proto[SELECTION_PATCH] ??= proto.applySelectionHighlight);

	function applySelectionHighlight(text: string): string {
		const bg = theme.getBgAnsi("selectedBg");
		// Styles inside the slice can set their own background, so restore ours after each one.
		// The caller replays the line's styles before the text after the selection.
		return `${bg}${text.replace(SGR, (code) => code + bg)}\x1b[49m`;
	}

	proto.applySelectionHighlight = applySelectionHighlight;
	return () => {
		// After a reload the new runtime patches again. Leave its patch in place.
		if (proto.applySelectionHighlight !== applySelectionHighlight) return;
		proto.applySelectionHighlight = original;
	};
}

export function installSelectionTheme(pi: ExtensionAPI): void {
	let unpatch: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unpatch?.();
		unpatch = patchSelectionHighlight(ctx.ui.theme);
	});
	pi.on("session_shutdown", () => {
		unpatch?.();
		unpatch = undefined;
	});
}
