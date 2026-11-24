/**
 * Tests for the Claude Code-style skill, `!` command, compaction, and branch rows.
 *
 * Run with: node test/claude-messages.test.ts
 */
import assert from "node:assert/strict";
import {
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	getMarkdownTheme,
	initTheme,
	SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installClaudeMessages, renderDynamicWorkflowMessage, renderWorkflowMessage } from "../extensions/util/claude-messages.ts";
const BULLET = process.platform === "darwin" ? "⏺" : "●";
const plain: any = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const tagged: any = {
	...plain,
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
};
// Pi's own components and Markdown read the global theme.
initTheme("dark", false);

type Handler = (event: unknown, ctx: any) => void;
function runtime() {
	const handlers = new Map<string, Handler[]>();
	installClaudeMessages({ on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]) } as any);
	return (event: string, mode = "tui", theme = plain) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event }, { mode, ui: { theme } });
	};
}

const strip = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const ui: any = { requestRender() {} };
const tokens = (123456).toLocaleString();

const skill = (pad = 1) =>
	new SkillInvocationMessageComponent(
		{ name: "pi-warehouse", location: "/skills/pi-warehouse/SKILL.md", content: "# Title\n\nBody text.", userMessage: undefined },
		getMarkdownTheme(),
		pad,
	);
const compaction = (pad = 1) =>
	new CompactionSummaryMessageComponent({ tokensBefore: 123456, summary: "## Goal\n\nShip it." } as any, getMarkdownTheme(), pad);
const branch = (pad = 1) =>
	new BranchSummaryMessageComponent({ summary: "Tried option A." } as any, getMarkdownTheme(), pad);
function bash(
	output: string | undefined,
	exitCode: number | "running" = 0,
	options: { command?: string; pad?: number; dim?: boolean; cancelled?: boolean; fullOutputPath?: string } = {},
) {
	const component = new BashExecutionComponent(options.command ?? "git status", ui, options.dim ?? false, options.pad ?? 1);
	if (output) component.appendOutput(output);
	if (exitCode !== "running") {
		const truncated = options.fullOutputPath ? { truncated: true } : undefined;
		component.setComplete(exitCode, options.cancelled ?? false, truncated as any, options.fullOutputPath);
	}
	return component;
}
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const piRows = () => ({
	skill: strip(skill().render(60)),
	compaction: strip(compaction().render(60)),
	branch: strip(branch().render(60)),
	bash: strip(bash("On branch main").render(60)),
});

// --- Pi's own rows, before any patch. ---
const pi = piRows();
assert.ok(pi.skill.some((line) => line.startsWith(" [skill] pi-warehouse")));
assert.ok(pi.compaction.includes(" [compaction]"));
assert.ok(pi.branch.includes(" [branch]"));
assert.ok(pi.bash.includes(" $ git status") && pi.bash.some((line) => line.startsWith("───")));

// --- Other modes keep Pi's rows. ---
const emit = runtime();
emit("session_start", "print");
assert.deepEqual(piRows(), pi);
console.log("MODES: print mode keeps Pi's rows");

emit("session_start");

// --- /skill:name ---
const collapsedSkill = skill();
assert.deepEqual(strip(collapsedSkill.render(60)), [
	` ${BULLET} Skill(pi-warehouse)`,
	"   ⎿  Successfully loaded skill (ctrl+o to expand)",
]);
assert.equal(strip(skill(0).render(60))[0], `${BULLET} Skill(pi-warehouse)`);
collapsedSkill.setExpanded(true);
assert.deepEqual(strip(collapsedSkill.render(60)), [
	` ${BULLET} Skill(pi-warehouse)`,
	"   ⎿  Successfully loaded skill",
	"      Title",
	"",
	"      Body text.",
]);
// A click toggles the row, as in Pi's component.
const click = { type: "click", button: "left", x: 3, y: 0, width: 60, height: 5 };
assert.ok((collapsedSkill as any).handleMouse(click)?.handled);
assert.equal(collapsedSkill.render(60).length, 2);
console.log("SKILL: Claude Skill row, expand, click, outputPad");

// --- Compaction and branch summaries ---
const compacted = compaction();
assert.deepEqual(strip(compacted.render(80)), [` ✻ Conversation compacted from ${tokens} tokens (ctrl+o to expand)`]);
assert.equal(strip(compaction(0).render(80))[0], `✻ Conversation compacted from ${tokens} tokens (ctrl+o to expand)`);
compacted.setExpanded(true);
assert.deepEqual(strip(compacted.render(80)), [
	` ✻ Conversation compacted from ${tokens} tokens`,
	"   ⎿  Goal",
	"",
	"      Ship it.",
]);
assert.ok((compacted as any).handleMouse({ ...click, height: 4 })?.handled);
assert.equal(compacted.render(80).length, 1);

const branched = branch();
assert.deepEqual(strip(branched.render(60)), [" ✻ Branch summary (ctrl+o to expand)"]);
branched.setExpanded(true);
assert.deepEqual(strip(branched.render(60)), [" ✻ Branch summary", "   ⎿  Tried option A."]);
console.log("SUMMARY: compaction and branch rows, expand, click, outputPad");

// --- ! commands ---
assert.deepEqual(strip(bash("On branch main\nnothing to commit\n").render(60)), [
	"",
	" ! git status",
	"   ⎿  On branch main",
	"      nothing to commit",
]);
assert.deepEqual(strip(bash(numbered(10)).render(60)), [
	"",
	" ! git status",
	"   ⎿  line 1",
	"      line 2",
	"      line 3",
	"      … +7 lines (ctrl+o to expand)",
]);
const long = bash(numbered(10));
long.setExpanded(true);
assert.equal(strip(long.render(60)).length, 12);
assert.equal(strip(long.render(60))[11], "      line 10");
assert.deepEqual(strip(bash(undefined).render(60)), ["", " ! git status", "   ⎿  (No content)"]);
assert.equal(strip(bash("x", 0, { pad: 0 }).render(60))[1], "! git status");

// Running output keeps the tail; Pi's spinner is gone.
const running = bash(undefined, "running");
assert.deepEqual(strip(running.render(60)), ["", " ! git status", "   ⎿  Running…"]);
running.appendOutput(numbered(10));
assert.deepEqual(strip(running.render(60)).slice(2), [
	"   ⎿  … +7 lines (ctrl+o to expand)",
	"      line 8",
	"      line 9",
	"      line 10",
]);
running.setComplete(0, false);

assert.deepEqual(strip(bash("fatal: not a git repository", 128).render(60)).slice(2), [
	"   ⎿  fatal: not a git repository",
	"      Exit code 128",
]);
assert.deepEqual(strip(bash("partial", 0, { cancelled: true }).render(60)).slice(2), [
	"   ⎿  partial",
	"      Interrupted",
]);
assert.equal(
	strip(bash("big", 0, { fullOutputPath: "/tmp/pi-bash.log" }).render(60)).at(-1),
	"      Full output: /tmp/pi-bash.log",
);
console.log("BASH: output fold, expand, running tail, exit code, cancel, truncation");

// Colors: `!` in bashMode (dim for `!!`), a full-width background, red output on failure.
emit("session_start", "tui", tagged);
const head = bash("ok").render(60)[1]!;
assert.ok(head.startsWith("[userMessageBg] <bashMode>! </bashMode><userMessageText>git status</userMessageText>"));
assert.ok(head.endsWith("[/userMessageBg]"));
assert.ok(bash("ok", 0, { dim: true }).render(60)[1]!.includes("<dim>! </dim>"));
assert.ok(bash("boom", 1).render(60)[2]!.includes("<error>boom</error>"));
assert.ok(bash("ok").render(60)[2]!.includes("<toolOutput>ok</toolOutput>"));
emit("session_start");

// Long commands wrap under the command text and fill the row.
const wrapped = bash("ok", 0, { command: "echo " + "word ".repeat(20) }).render(40);
assert.ok(strip(wrapped)[2]!.startsWith("   ") && !strip(wrapped)[2]!.startsWith("   ⎿"));
for (const line of wrapped.slice(1, 4)) assert.equal(visibleWidth(line), 40);
console.log("BASH: colors, `!!` dim prompt, wrapped commands");

// --- Every row fits the width. ---
const narrow = [
	...skill().render(20),
	...compaction().render(20),
	...branch().render(20),
	...bash("z".repeat(90), 0, { command: "y".repeat(50), fullOutputPath: "/" + "p".repeat(40) }).render(20),
];
for (const line of narrow) assert.ok(visibleWidth(line) <= 20, `too wide: ${JSON.stringify(line)}`);
assert.deepEqual(bash("x").render(4), [""]);
console.log("WIDTH: rows fit narrow terminals");

// --- Workflow custom message ---
const workflowMessage = {
	role: "custom" as const,
	customType: "warehouse-workflow",
	display: true,
	details: { workflowId: "resume-tailoring", stepId: "resume-builder", stepTitle: "Resume Builder" },
	content: "Run workflow resume-tailoring, step resume-builder only.\nRequest: improve general resume",
	timestamp: Date.now(),
};
const workflowRow = renderWorkflowMessage(workflowMessage as any, { expanded: false, outputPad: 1 }, plain)!;
assert.deepEqual(strip(workflowRow.render(80)), [
	` ${BULLET} Workflow(resume-tailoring / resume-builder)`,
	"   ⎿  Resume Builder selected (ctrl+o to expand)",
]);
const expandedWorkflow = renderWorkflowMessage(workflowMessage as any, { expanded: true, outputPad: 1 }, plain)!;
assert.deepEqual(strip(expandedWorkflow.render(80)), [
	` ${BULLET} Workflow(resume-tailoring / resume-builder)`,
	"   ⎿  Resume Builder selected",
	"      Run workflow resume-tailoring, step resume-builder only.",
	"      Request: improve general resume",
]);
const rawWorkflow = renderWorkflowMessage({ ...workflowMessage, details: undefined, content: "plain" } as any, { expanded: false, outputPad: 0 }, plain)!;
assert.equal(strip(rawWorkflow.render(80))[0], `${BULLET} Workflow`);
console.log("WORKFLOW: Claude-style Workflow row, expand, missing details, outputPad");

const reportMessage = {
	role: "custom",
	customType: "dynamic-workflow",
	display: true,
	details: { skill: "research", summary: "Report from 3 workers in 2m 5s (1 failed)", conclusion: "Use X.\nThen test Y." },
	content: "Dynamic workflow report.\nFINAL",
	timestamp: Date.now(),
};
assert.deepEqual(strip(renderDynamicWorkflowMessage(reportMessage as any, { expanded: false, outputPad: 1 }, plain)!.render(80)), [
	` ${BULLET} DynamicWorkflow(research)`,
	"   ⎿  Report from 3 workers in 2m 5s (1 failed) (ctrl+o to expand)",
	"      Use X.",
	"      Then test Y.",
]);
assert.deepEqual(strip(renderDynamicWorkflowMessage(reportMessage as any, { expanded: true, outputPad: 1 }, plain)!.render(80)), [
	` ${BULLET} DynamicWorkflow(research)`,
	"   ⎿  Report from 3 workers in 2m 5s (1 failed)",
	"      Dynamic workflow report.",
	"      FINAL",
]);
assert.deepEqual(strip(renderDynamicWorkflowMessage({ ...reportMessage, details: undefined } as any, { expanded: false, outputPad: 0 }, plain)!.render(80)), [
	`${BULLET} DynamicWorkflow`,
	"  ⎿  Report (ctrl+o to expand)",
]);
console.log("DYNAMIC WORKFLOW: report row with visible conclusion, expand, missing details");

// --- Reload: the old runtime's shutdown keeps the new runtime's patch. ---
const reloaded = runtime();
reloaded("session_start");
emit("session_shutdown");
assert.notDeepEqual(piRows(), pi);
reloaded("session_shutdown");
reloaded("session_shutdown");
assert.deepEqual(piRows(), pi);
console.log("UNDO: reload keeps the new patch; shutdown restores Pi's rows");

console.log("\nALL TESTS PASSED");
