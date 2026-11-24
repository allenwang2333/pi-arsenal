/**
 * Tests for the theme-colored fullscreen selection.
 *
 * Run with: node test/selection.test.ts
 */
import assert from "node:assert/strict";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installSelectionTheme, patchSelectionHighlight } from "../extensions/util/selection.ts";

const SELECTED_BG = "\x1b[48;2;215;208;196m";
const theme: any = { getBgAnsi: (color: string) => (color === "selectedBg" ? SELECTED_BG : "") };

// Drive Pi's own selection pass with a selection on screen row 0, columns 2 through 6.
function select(line: string): string {
	const screen = Object.create(TuiAltScreen.prototype);
	screen.terminal = { columns: 40 };
	screen.selectionAnchor = { row: 0, col: 2 };
	screen.selectionFocus = { row: 0, col: 6 };
	return screen.applySelection([line])[0];
}

const proto = TuiAltScreen.prototype as any;
const original = proto.applySelectionHighlight;
const line = "ab\x1b[31mcd ef\x1b[39m\x1b[48;5;236mgh\x1b[49m";
assert.match(select(line), /\x1b\[7m/, "Pi reverses the selection by default");

const unpatch = patchSelectionHighlight(theme);
const patched = select(line);
assert.doesNotMatch(patched, /\x1b\[7m/, "no reverse video");
assert.ok(patched.startsWith(`ab${SELECTED_BG}`), "the selection starts on selectedBg");
// The red foreground stays, and selectedBg comes back after it.
// The red foreground stays, and selectedBg comes back after it. The space
// inside the selection stays on selectedBg until the selection ends.
assert.ok(patched.includes(`\x1b[31m${SELECTED_BG}cd ef\x1b[49m`), "foreground kept, blanks painted");
// The text after the selection gets its own background back.
const after = patched.slice(patched.lastIndexOf("\x1b[49m", patched.indexOf("gh")));
assert.ok(after.includes("\x1b[48;5;236m") && after.indexOf("\x1b[48;5;236m") < after.indexOf("gh"), "after keeps its bg");
assert.equal(patched.replace(/\x1b\[[0-9;:]*m/g, ""), "abcd efgh", "text is unchanged");

unpatch();
assert.equal(proto.applySelectionHighlight, original, "undo restores Pi's highlight");

// Install patches at TUI session start and undoes at shutdown.
const handlers = new Map<string, (event: unknown, ctx: any) => void>();
installSelectionTheme({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);
handlers.get("session_start")!({}, { mode: "print", ui: { theme } });
assert.equal(proto.applySelectionHighlight, original, "no patch outside the TUI");
handlers.get("session_start")!({}, { mode: "tui", ui: { theme } });
assert.notEqual(proto.applySelectionHighlight, original, "patched in the TUI");
handlers.get("session_start")!({}, { mode: "tui", ui: { theme } });
handlers.get("session_shutdown")!({}, {});
assert.equal(proto.applySelectionHighlight, original, "shutdown restores Pi's highlight");

console.log("selection tests passed");
