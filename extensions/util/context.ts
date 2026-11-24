/**
 * context — current context-window usage, inspired by Claude Code's /context.
 *
 * The total comes from pi's provider usage when available. Pi does not expose
 * provider-tokenized per-section counts, so the category split uses the same
 * conservative character/message estimates as pi's compaction logic.
 */

import { homedir } from "node:os";
import {
	buildSessionContext,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	formatSkillsForPrompt,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandDef } from "./types.ts";

type UsageCategoryId = "system" | "tools" | "context-files" | "skills" | "messages";
type DisplayCategoryId = UsageCategoryId | "free" | "buffer";

interface RawDetail {
	label: string;
	tokens: number;
}

interface UsageDetail {
	label: string;
	tokens: number;
}

interface RawCategory {
	id: UsageCategoryId;
	label: string;
	color: ThemeColor;
	tokens: number;
	details: RawDetail[];
	countLabel?: string;
}

interface UsageCategory extends Omit<RawCategory, "details"> {
	details: UsageDetail[];
}

interface DisplayCategory {
	id: DisplayCategoryId;
	label: string;
	color: ThemeColor;
	tokens: number;
	countLabel?: string;
}

interface ContextSnapshot {
	model: string;
	contextWindow: number;
	usedTokens: number;
	usageCategories: UsageCategory[];
	freeTokens: number;
	bufferTokens: number;
	reserveTokens: number;
	autoCompactEnabled: boolean;
	totalIsReported: boolean;
}

const GRID_CELLS = 100;
const GRID_COLUMNS = 10;
const GRID_ROWS = GRID_CELLS / GRID_COLUMNS;

function estimateCharacterTokens(characters: number): number {
	return Math.ceil(characters / 4);
}

function estimateTextTokens(text: string): number {
	return estimateCharacterTokens(text.length);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/** Allocate an integer total proportionally while preserving the exact sum. */
function allocateInteger(total: number, weights: number[]): number[] {
	const target = Math.max(0, Math.round(total));
	const safeWeights = weights.map((weight) => Math.max(0, weight));
	const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
	if (safeWeights.length === 0) return [];
	if (weightTotal === 0) return safeWeights.map((_, index) => (index === 0 ? target : 0));

	const exact = safeWeights.map((weight) => (weight / weightTotal) * target);
	const allocated = exact.map(Math.floor);
	const remaining = target - allocated.reduce((sum, value) => sum + value, 0);
	const byRemainder = exact
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

	for (let i = 0; i < remaining; i++) {
		allocated[byRemainder[i % byRemainder.length].index]++;
	}
	return allocated;
}

/** Keep tiny non-zero categories visible in the 100-cell overview. */
function allocateGridCells(weights: number[]): number[] {
	const allocated = allocateInteger(GRID_CELLS, weights);
	for (let index = 0; index < weights.length; index++) {
		if (weights[index] <= 0 || allocated[index] > 0) continue;
		let donor = -1;
		for (let candidate = 0; candidate < allocated.length; candidate++) {
			if (allocated[candidate] > 1 && (donor === -1 || allocated[candidate] > allocated[donor])) {
				donor = candidate;
			}
		}
		if (donor === -1) break;
		allocated[donor]--;
		allocated[index]++;
	}
	return allocated;
}

function formatTokens(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	if (value < 1_000) return value.toLocaleString("en-US");
	if (value < 1_000_000) {
		const thousands = value / 1_000;
		return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`;
	}
	const millions = value / 1_000_000;
	return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`;
}

function formatPercent(tokens: number, contextWindow: number): string {
	if (contextWindow <= 0) return "?";
	return `${((tokens / contextWindow) * 100).toFixed(1)}%`;
}

function sanitizeDisplay(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function shortPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return sanitizeDisplay(`~${path.slice(home.length)}`);
	return sanitizeDisplay(path);
}

function formatContextSection(files: Array<{ path: string; content: string }>): string {
	if (files.length === 0) return "";
	let section = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		section += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	section += "</project_context>\n";
	return section;
}

function contextFileText(file: { path: string; content: string }): string {
	return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function skillText(skill: { name: string; description: string; filePath: string }): string {
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

function messageLabel(role: string): string {
	switch (role) {
		case "user":
			return "User messages";
		case "assistant":
			return "Assistant messages";
		case "toolResult":
			return "Tool results";
		case "bashExecution":
			return "Shell output";
		case "custom":
			return "Extension messages";
		case "branchSummary":
		case "compactionSummary":
			return "Summaries";
		default:
			return role;
	}
}

function buildRawCategories(pi: ExtensionAPI, ctx: ExtensionCommandContext): RawCategory[] {
	const options = ctx.getSystemPromptOptions();
	const systemPrompt = ctx.getSystemPrompt();
	const contextFiles = options.contextFiles ?? [];
	const contextSection = formatContextSection(contextFiles);
	const contextDetails = contextFiles.map((file) => ({
		label: shortPath(file.path),
		tokens: estimateTextTokens(contextFileText(file)),
	}));

	const readEnabled = options.selectedTools === undefined || options.selectedTools.includes("read");
	const visibleSkills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	const activeSkills = readEnabled ? visibleSkills : [];
	const skillsSection = readEnabled ? formatSkillsForPrompt(options.skills ?? []) : "";
	const skillDetails = activeSkills.map((skill) => ({
		label: sanitizeDisplay(skill.name),
		tokens: estimateTextTokens(skillText(skill)),
	}));

	// These sections are part of getSystemPrompt(). Subtract them so they are
	// not counted twice when shown as their own categories.
	const baseSystemChars = Math.max(0, systemPrompt.length - contextSection.length - skillsSection.length);

	const activeNames = pi.getActiveTools();
	const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const toolDetails: RawDetail[] = [];
	for (const name of activeNames) {
		const tool = toolsByName.get(name);
		if (!tool) continue;
		const serialized = safeJson({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		});
		toolDetails.push({ label: sanitizeDisplay(tool.name), tokens: estimateTextTokens(serialized) });
	}

	const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const messageGroups = new Map<string, { count: number; tokens: number }>();
	for (const message of sessionContext.messages) {
		const label = messageLabel(message.role);
		const current = messageGroups.get(label) ?? { count: 0, tokens: 0 };
		current.count++;
		current.tokens += estimateTokens(message);
		messageGroups.set(label, current);
	}
	const messageDetails = [...messageGroups.entries()].map(([label, group]) => ({
		label: `${label} (${group.count})`,
		tokens: group.tokens,
	}));

	return [
		{
			id: "system",
			label: "System prompt",
			color: "accent",
			tokens: estimateCharacterTokens(baseSystemChars),
			details: [],
		},
		{
			id: "tools",
			label: "Tool definitions",
			color: "syntaxType",
			tokens: toolDetails.reduce((sum, detail) => sum + detail.tokens, 0),
			details: toolDetails,
			countLabel: `${toolDetails.length} tool${toolDetails.length === 1 ? "" : "s"}`,
		},
		{
			id: "context-files",
			label: "Context files",
			color: "syntaxString",
			tokens: estimateTextTokens(contextSection),
			details: contextDetails,
			countLabel: `${contextFiles.length} file${contextFiles.length === 1 ? "" : "s"}`,
		},
		{
			id: "skills",
			label: "Skills",
			color: "warning",
			tokens: estimateTextTokens(skillsSection),
			details: skillDetails,
			countLabel: `${activeSkills.length} skill${activeSkills.length === 1 ? "" : "s"}`,
		},
		{
			id: "messages",
			label: "Messages",
			color: "success",
			tokens: messageDetails.reduce((sum, detail) => sum + detail.tokens, 0),
			details: messageDetails,
			countLabel: `${sessionContext.messages.length} message${sessionContext.messages.length === 1 ? "" : "s"}`,
		},
	];
}

function buildSnapshot(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextSnapshot | undefined {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const rawCategories = buildRawCategories(pi, ctx);
	const rawTotal = rawCategories.reduce((sum, category) => sum + category.tokens, 0);
	const reportedTokens = usage?.tokens;
	const totalIsReported = typeof reportedTokens === "number" && reportedTokens > 0;
	const usedTokens = totalIsReported ? Math.round(reportedTokens) : rawTotal;
	const categoryTokens = allocateInteger(
		usedTokens,
		rawCategories.map((category) => category.tokens),
	);
	const usageCategories = rawCategories.map((category, index): UsageCategory => {
		const tokens = categoryTokens[index];
		const detailTokens = allocateInteger(
			tokens,
			category.details.map((detail) => detail.tokens),
		);
		return {
			...category,
			tokens,
			details: category.details.map((detail, detailIndex) => ({
				label: detail.label,
				tokens: detailTokens[detailIndex],
			})),
		};
	});

	let autoCompactEnabled = true;
	let reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		autoCompactEnabled = settings.getCompactionEnabled();
		reserveTokens = settings.getCompactionReserveTokens();
	} catch {
		// Keep pi's defaults when settings cannot be read.
	}
	reserveTokens = autoCompactEnabled ? Math.max(0, Math.min(contextWindow, reserveTokens)) : 0;
	const remaining = Math.max(0, contextWindow - usedTokens);
	const bufferTokens = Math.min(reserveTokens, remaining);
	const freeTokens = Math.max(0, remaining - bufferTokens);
	const model = ctx.model
		? sanitizeDisplay(`${ctx.model.provider}/${ctx.model.id}`)
		: "No active model";

	return {
		model,
		contextWindow,
		usedTokens,
		usageCategories,
		freeTokens,
		bufferTokens,
		reserveTokens,
		autoCompactEnabled,
		totalIsReported,
	};
}

function getDisplayCategories(snapshot: ContextSnapshot): DisplayCategory[] {
	const categories: DisplayCategory[] = snapshot.usageCategories.map((category) => ({
		id: category.id,
		label: category.label,
		color: category.color,
		tokens: category.tokens,
		countLabel: category.countLabel,
	}));
	categories.push({ id: "free", label: "Free space", color: "dim", tokens: snapshot.freeTokens });
	if (snapshot.autoCompactEnabled) {
		categories.push({
			id: "buffer",
			label: "Compaction buffer",
			color: "muted",
			tokens: snapshot.bufferTokens,
		});
	}
	return categories;
}

function cell(category: DisplayCategory, theme: Theme): string {
	if (category.id === "free") return theme.fg("dim", "□");
	if (category.id === "buffer") return theme.fg("muted", "▒");
	return theme.fg(category.color, "■");
}

function bullet(category: DisplayCategory, theme: Theme): string {
	if (category.id === "free") return theme.fg("dim", "○");
	if (category.id === "buffer") return theme.fg("muted", "◆");
	return theme.fg(category.color, "●");
}

function buildGrid(categories: DisplayCategory[], theme: Theme): string[] {
	const counts = allocateGridCells(categories.map((category) => category.tokens));
	const cells = categories.flatMap((category, index) =>
		Array.from({ length: counts[index] }, () => cell(category, theme)),
	);
	while (cells.length < GRID_CELLS) cells.push(theme.fg("dim", "□"));

	const rows: string[] = [];
	for (let row = 0; row < GRID_ROWS; row++) {
		rows.push(cells.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS).join(" "));
	}
	return rows;
}

function detailLine(detail: UsageDetail, contextWindow: number, width: number, theme: Theme): string {
	const value = `${formatTokens(detail.tokens)} (${formatPercent(detail.tokens, contextWindow)})`;
	const prefix = "  ";
	const labelWidth = Math.max(4, width - prefix.length - value.length - 1);
	const label = truncateToWidth(detail.label, labelWidth);
	const padding = " ".repeat(Math.max(1, width - prefix.length - visibleWidth(label) - value.length));
	return truncateToWidth(`${prefix}${label}${padding}${theme.fg("dim", value)}`, width);
}

function buildReport(snapshot: ContextSnapshot, theme: Theme, width: number, expanded: boolean): string[] {
	const lines: string[] = [];
	const percent = formatPercent(snapshot.usedTokens, snapshot.contextWindow);
	const source = snapshot.totalIsReported ? "" : theme.fg("warning", " · estimated");
	lines.push(
		theme.bold(snapshot.model) +
			` · ${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.contextWindow)} tokens (${percent})` +
			source,
	);

	const overTokens = Math.max(0, snapshot.usedTokens - snapshot.contextWindow);
	const intoBuffer = Math.max(
		0,
		snapshot.reserveTokens - Math.max(0, snapshot.contextWindow - snapshot.usedTokens),
	);
	if (overTokens > 0) {
		lines.push(theme.fg("error", `Context is ${formatTokens(overTokens)} tokens over the model limit. Run /compact or /new.`));
	} else if (snapshot.autoCompactEnabled && intoBuffer > 0) {
		lines.push(theme.fg("warning", `${formatTokens(intoBuffer)} tokens into the automatic compaction buffer.`));
	}
	lines.push("");

	const categories = getDisplayCategories(snapshot);
	const grid = buildGrid(categories, theme);
	const legend = categories.map((category) => {
		const count = category.countLabel ? theme.fg("dim", ` · ${category.countLabel}`) : "";
		return (
			`${bullet(category, theme)} ${category.label}: ${formatTokens(category.tokens)} tokens ` +
			`(${formatPercent(category.tokens, snapshot.contextWindow)})${count}`
		);
	});
	const gridWidth = Math.max(...grid.map(visibleWidth));
	const legendWidth = Math.max(...legend.map(visibleWidth));
	if (gridWidth + 4 + legendWidth <= width) {
		const rowCount = Math.max(grid.length, legend.length);
		for (let index = 0; index < rowCount; index++) {
			const left = grid[index] ?? " ".repeat(gridWidth);
			const right = legend[index] ?? "";
			lines.push(`${left}${" ".repeat(gridWidth - visibleWidth(left) + 4)}${right}`);
		}
	} else {
		lines.push(...grid, "", ...legend);
	}

	if (expanded) {
		lines.push("", theme.bold("Per-item estimates"));
		for (const category of snapshot.usageCategories) {
			if (category.details.length === 0) continue;
			lines.push("", theme.fg(category.color, category.label));
			for (const detail of [...category.details].sort((a, b) => b.tokens - a.tokens)) {
				lines.push(detailLine(detail, snapshot.contextWindow, width, theme));
			}
		}
	} else {
		lines.push("", theme.fg("dim", "Run /context all for per-tool and per-file estimates."));
	}

	lines.push(
		"",
		theme.fg(
			"dim",
			snapshot.totalIsReported
				? "The total uses pi's provider usage; category sizes are estimates."
				: "No provider usage is available yet; values use pi's token estimates.",
		),
	);
	return lines;
}

function oneLineSummary(snapshot: ContextSnapshot): string {
	const qualifier = snapshot.totalIsReported ? "" : " (estimated)";
	return (
		`context: ${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.contextWindow)} tokens ` +
		`(${formatPercent(snapshot.usedTokens, snapshot.contextWindow)})${qualifier}`
	);
}

export function contextCommand(pi: ExtensionAPI): CommandDef {
	return {
		description: "Show current context-window usage and breakdown",
		getArgumentCompletions: (prefix: string) => {
			const value = prefix.trim().toLowerCase();
			return value === "" || "all".startsWith(value) ? [{ value: "all", label: "all" }] : null;
		},
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument && argument !== "all") {
				ctx.ui.notify("usage: /context [all]", "error");
				return;
			}

			const snapshot = buildSnapshot(pi, ctx);
			if (!snapshot) {
				ctx.ui.notify("context: no active model with a context window", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(oneLineSummary(snapshot), "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let scroll = 0;
				let maxScroll = 0;
				const bodyRows = Math.max(8, Math.min(24, tui.terminal.rows - 6));

				return {
					render: (renderWidth) => {
						const width = Math.max(1, renderWidth);
						const contentWidth = Math.max(1, width - 2);
						const report = buildReport(snapshot, theme, contentWidth, argument === "all");
						maxScroll = Math.max(0, report.length - bodyRows);
						scroll = Math.min(scroll, maxScroll);
						const visible = report.slice(scroll, scroll + bodyRows);
						const border = theme.fg("accent", "─".repeat(width));
						const footer =
							maxScroll > 0
								? `${scroll + 1}-${Math.min(report.length, scroll + bodyRows)}/${report.length} · ↑↓/PgUp/PgDn scroll · esc close`
								: "esc close";
						return [
							border,
							truncateToWidth(` ${theme.fg("accent", theme.bold("Context Usage"))}`, width),
							...visible.map((line) => truncateToWidth(` ${line}`, width)),
							truncateToWidth(` ${theme.fg("dim", footer)}`, width),
							border,
						];
					},
					invalidate: () => {},
					handleInput: (data) => {
						if (matchesKey(data, "escape") || matchesKey(data, "q")) {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
						else if (matchesKey(data, "down")) scroll = Math.min(maxScroll, scroll + 1);
						else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - bodyRows);
						else if (matchesKey(data, "pageDown")) scroll = Math.min(maxScroll, scroll + bodyRows);
						else if (matchesKey(data, "home")) scroll = 0;
						else if (matchesKey(data, "end")) scroll = maxScroll;
						else return;
						tui.requestRender();
					},
				};
			});
		},
	};
}
