/**
 * Shared pieces for the todo and background-process panels: a left click on
 * the panel toggles its finished rows, and a dim row says how many are hidden.
 */

import { MouseRegion, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export function clickToToggle(child: Component, toggle: () => void): Component {
	return new MouseRegion(child, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		toggle();
		return { handled: true };
	});
}

export function hiddenRow(theme: Theme, count: number, noun: string): string {
	return theme.fg("dim", `${count} ${noun} hidden (click to show)`);
}

/** Tree connectors: `├─` on every row, `└─` on the last one. */
export function treeRows(theme: Theme, rows: string[]): string[] {
	return rows.map((row, index) => `${theme.fg("dim", index === rows.length - 1 ? "└─" : "├─")} ${row}`);
}
