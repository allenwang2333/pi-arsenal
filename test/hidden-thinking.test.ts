/** Run with: node test/hidden-thinking.test.ts */
import assert from "node:assert/strict";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { MouseRegion, stripTerminalSequences } from "@earendil-works/pi-tui";
import { patchHiddenThinkingBlocks } from "../extensions/util/claude-ui.ts";

initTheme("dark", false);
const thinking = (text: string) => ({ type: "thinking", thinking: text });
const text = (value: string) => ({ type: "text", text: value });
const tool = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } };
const message = (content: any[], stopReason = "stop") => ({ role: "assistant", content, stopReason, errorMessage: "Request failed" });
const component = (content: any[], hide = true, stopReason = "stop") =>
	new AssistantMessageComponent(message(content, stopReason) as any, hide, getMarkdownTheme(), "");
const rows = (view: AssistantMessageComponent, width = 40) =>
	view.render(width).map((line) => stripTerminalSequences(line).trimEnd());
const content = [thinking("Private reasoning"), text("Result")];
const originalHiddenRows = rows(component(content));
const originalUpdate = AssistantMessageComponent.prototype.updateContent;
const markdown = "First paragraph.\n\nSecond paragraph.\n\n```text\none\n\ntwo\n```";
const originalMarkdownRows = rows(component([text(markdown)]));
const originalVisibleRows = rows(component(content, false));
const errorRows = new Map(["error", "aborted", "length"].map((reason) => [reason, rows(component([], true, reason))]));

let undo = patchHiddenThinkingBlocks();
try {
	assert.deepEqual(rows(component(content)), ["", " Result"]);
	assert.deepEqual(rows(component([thinking("Reasoning only")])), []);
	assert.deepEqual(rows(component([thinking("Reasoning before a tool"), tool])), []);
	assert.deepEqual(rows(component([thinking("A"), thinking("B"), text("Result")])), ["", " Result"]);
	assert.deepEqual(rows(component([thinking("A"), tool, thinking("B"), text("Result")])), ["", " Result"]);
	assert.deepEqual(rows(component([text("First"), thinking("Hidden"), text("Second")])), ["", " First", " Second"]);
	assert.deepEqual(rows(component([text(markdown)])), originalMarkdownRows);
	assert.deepEqual(rows(component(content, false)), originalVisibleRows);
	for (const reason of ["error", "aborted", "length"]) {
		assert.deepEqual(rows(component([thinking("Hidden")], true, reason)), errorRows.get(reason));
		assert.deepEqual(rows(component([text("Partial"), thinking("Hidden")], true, reason)), rows(component([text("Partial")], true, reason)));
	}

	const streaming = component([]);
	const raw = message([thinking("Reasoning in progress")]);
	streaming.updateContent(raw as any, true);
	assert.deepEqual(rows(streaming), []);
	assert.equal((streaming as any).lastMessage, raw, "reasoning must remain in the original message");
	streaming.updateContent(message(content) as any, true);
	assert.deepEqual(rows(streaming), ["", " Result"]);
	streaming.invalidate();
	assert.deepEqual(rows(streaming), ["", " Result"]);
	streaming.setOutputPad(0);
	assert.deepEqual(rows(streaming), ["", "Result"]);
	for (const width of [8, 20, 40, 80]) assert.equal(rows(streaming, width).filter((line) => !line).length, 1);
	streaming.setHideThinkingBlock(false);
	assert.ok(rows(streaming).some((line) => line.includes("Private reasoning")));
	streaming.setHideThinkingBlock(true);
	assert.deepEqual(rows(streaming), ["", "Result"]);

	// Hiding one visible run must not change the indices of later reasoning runs.
	const mixed = component([thinking("First reasoning"), text("Between"), thinking("Second reasoning")], false);
	const regions = (mixed as any).contentContainer.children.filter((child: unknown) => child instanceof MouseRegion);
	assert.equal(regions.length, 2);
	regions[0].handleMouse({ type: "click", button: "left", x: 0, y: 0, width: 40, height: 1 });
	assert.ok(!rows(mixed).some((line) => line.includes("First reasoning")));
	assert.ok(rows(mixed).some((line) => line.includes("Second reasoning")));
	mixed.setHideThinkingBlock(false);
	assert.ok(rows(mixed).some((line) => line.includes("First reasoning")));

	const previousUndo = undo;
	undo = patchHiddenThinkingBlocks();
	previousUndo();
	assert.deepEqual(rows(component(content)), ["", " Result"], "old runtime cleanup must leave the new patch intact");
} finally {
	undo();
}
assert.equal(AssistantMessageComponent.prototype.updateContent, originalUpdate);
assert.deepEqual(rows(component(content)), originalHiddenRows);
console.log("PASS: hidden reasoning uses no rows; Markdown, errors, streaming, toggles, mouse controls, and reload cleanup preserved");
