/**
 * usage — token and cost usage across sessions.
 *
 * `/usage` aggregates provider-reported usage from every saved session. It
 * includes every provider and model recorded by Pi, with API-equivalent cost
 * estimates for zero-cost Claude bridge and Antigravity records.
 *
 * Usage:
 *
 *   /usage                     # all local session usage
 *   /usage 7                   # local usage from the last 7 days
 *   /usage today               # local usage from today
 *
 * Sessions are read from `~/.pi/agent/sessions` (override with the
 * `PI_SESSION_DIR` environment variable).
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";
import type { CommandDef } from "./types.ts";

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	estimatedCost: number;
}

function emptyTokens(): Tokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, estimatedCost: 0 };
}

function addUsage(t: Tokens, usage: any, estimatedCost = 0): boolean {
	if (!usage || typeof usage !== "object") return false;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const cost = usage.cost?.total ?? 0;
	// Skip records that reported nothing (aborted/error messages, zero-cost
	// provider reports) — matches pi's own usage-breakdown filtering.
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) return false;
	t.input += input;
	t.output += output;
	t.cacheRead += cacheRead;
	t.cacheWrite += cacheWrite;
	t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
	t.cost += cost;
	t.estimatedCost += estimatedCost;
	return true;
}

interface ProjectAgg {
	cwd: string;
	tokens: Tokens;
	sessions: number;
}

interface Collected {
	totals: Tokens;
	sessions: number;
	messages: number;
	byModel: Map<string, Tokens>;
	byProject: Map<string, ProjectAgg>;
	byMonth: Map<string, Tokens>;
	byDay: Map<string, Tokens>;
	unpricedModels: Set<string>;
}

function entryTime(entry: any): number {
	if (typeof entry?.timestamp === "string") {
		const t = new Date(entry.timestamp).getTime();
		if (!Number.isNaN(t)) return t;
	}
	return 0;
}
function collectSessions(
	root: string,
	sinceMs: number,
	registry: ExtensionCommandContext["modelRegistry"],
): Collected {
	const out: Collected = {
		totals: emptyTokens(),
		sessions: 0,
		messages: 0,
		byModel: new Map(),
		byProject: new Map(),
		byMonth: new Map(),
		byDay: new Map(),
		unpricedModels: new Set(),
	};

	let dirs: string[] = [];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return out;
	}

	for (const dirName of dirs) {
		let files: string[] = [];
		try {
			files = readdirSync(join(root, dirName)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			let headerCwd: string | undefined;
			let fileUsed = false;

			let raw: string;
			try {
				raw = readFileSync(join(root, dirName, file), "utf8");
			} catch {
				continue;
			}

			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (!entry || typeof entry !== "object") continue;

				if (entry.type === "session") {
					headerCwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
					continue;
				}

				const time = entryTime(entry);
				if (time <= 0 || (sinceMs > 0 && time < sinceMs)) continue;

				let usage: any;
				let modelKey: string | undefined;

				if (entry.type === "message") {
					const msg = entry.message;
					if (msg?.role === "assistant") {
						usage = msg.usage;
						const provider = typeof msg.provider === "string" ? msg.provider : "unknown";
						const model = typeof msg.model === "string" ? msg.model : "unknown";
						modelKey = `${provider}/${model}`;
					} else if (msg?.role === "toolResult" && msg.usage) {
						usage = msg.usage;
						modelKey = "tools/summaries";
					}
				} else if (entry.type === "usage") {
					usage = entry.usage;
					modelKey = `${entry.provider}/${entry.model}`;
				} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
					usage = entry.usage;
					modelKey = "tools/summaries";
				}

				if (!usage) continue;
				let estimatedCost = 0;
				let unpriced = false;
				const [provider, modelId] = modelKey?.split("/") ?? [];
				const catalogProvider = provider === "claude-bridge" ? "anthropic"
					: provider === "antigravity" ? (modelId?.startsWith("claude-") ? "anthropic" : "google")
					: undefined;
				if (catalogProvider && (usage.cost?.total ?? 0) === 0) {
					const model = registry.find(catalogProvider, modelId!);
					if (model && (model.cost.input + model.cost.output + model.cost.cacheRead + model.cost.cacheWrite) > 0) {
						// Price a copy: subscription providers deliberately persist zero costs.
						usage = {
							...usage,
							input: usage.input ?? 0, output: usage.output ?? 0,
							cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
							cost: { ...usage.cost },
						};
						estimatedCost = calculateCost(model, usage).total;
					} else {
						unpriced = true;
					}
				}
				if (!addUsage(out.totals, usage, estimatedCost)) continue;
				if (unpriced && modelKey) out.unpricedModels.add(modelKey);
				out.messages++;
				fileUsed = true;

				if (modelKey) {
					const agg = out.byModel.get(modelKey) ?? emptyTokens();
					addUsage(agg, usage, estimatedCost);
					out.byModel.set(modelKey, agg);
				}

				const cwd = headerCwd ?? dirName;
				let proj = out.byProject.get(cwd);
				if (!proj) {
					proj = { cwd, tokens: emptyTokens(), sessions: 0 };
					out.byProject.set(cwd, proj);
				}
				addUsage(proj.tokens, usage, estimatedCost);

				const day = localDayKey(time);
				const dayAgg = out.byDay.get(day) ?? emptyTokens();
				addUsage(dayAgg, usage, estimatedCost);
				out.byDay.set(day, dayAgg);

				const month = day.slice(0, 7);
				const monthAgg = out.byMonth.get(month) ?? emptyTokens();
				addUsage(monthAgg, usage, estimatedCost);
				out.byMonth.set(month, monthAgg);
			}

			if (fileUsed) {
				out.sessions++;
				const cwd = headerCwd ?? dirName;
				const proj = out.byProject.get(cwd);
				if (proj) proj.sessions++;
			}
		}
	}

	return out;
}

function localDayKey(ms: number): string {
	const d = new Date(ms);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function fmtCost(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 100) return `$${n.toFixed(2)}`;
	return `$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtUsageCost(tokens: Tokens): string {
	return `${tokens.estimatedCost > 0 ? "~" : ""}${fmtCost(tokens.cost)}`;
}

function costNotes(collected: Collected): string[] {
	const notes: string[] = [];
	if (collected.totals.estimatedCost > 0) {
		notes.push("~ includes API-equivalent estimates at current Anthropic/Google catalog rates; not subscription charges.");
	}
	if (collected.unpricedModels.size > 0) {
		notes.push(`Models without catalog prices remain $0.00: ${[...collected.unpricedModels].sort().join(", ")}`);
	}
	return notes;
}

function shortPath(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return `~${p.slice(home.length)}`;
	return p;
}

/** Right-align a number string in a column; truncate names to fit. */
function col(text: string, width: number, right = false): string {
	if (text.length > width) text = text.slice(0, width - 1) + "…";
	return right ? text.padStart(width) : text.padEnd(width);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const TOK_W = 16;
const COST_W = 10;

function buildReport(collected: Collected, windowLabel: string, theme: Theme): string[] {
	const { totals } = collected;
	const lines: string[] = [];

	lines.push(theme.fg("accent", theme.bold(` Usage — ${windowLabel}`)));
	lines.push(
		theme.fg(
			"muted",
			` ${collected.sessions} session${collected.sessions === 1 ? "" : "s"} · ${fmtTokens(collected.messages)} messages`,
		),
	);
	lines.push("");

	lines.push(
		theme.bold(` Tokens ${col(fmtTokens(totals.total), TOK_W + 2)} `) +
			theme.fg("success", theme.bold(fmtUsageCost(totals))),
	);
	lines.push(
		theme.fg(
			"dim",
			`   input ${fmtTokens(totals.input)} · output ${fmtTokens(totals.output)} · cache read ${fmtTokens(totals.cacheRead)} · cache write ${fmtTokens(totals.cacheWrite)}`,
		),
	);
	for (const note of costNotes(collected)) lines.push(theme.fg("dim", ` ${note}`));
	lines.push("");

	const byModel = [...collected.byModel.entries()].sort(
		(a, b) => b[1].cost - a[1].cost || b[1].total - a[1].total,
	);
	lines.push(theme.fg("accent", ` ${col("BY MODEL", 40)} ${col("TOKENS", TOK_W, true)} ${col("COST", COST_W, true)}`));
	for (const [model, agg] of byModel) {
		lines.push(` ${col(model, 40)} ${col(fmtTokens(agg.total), TOK_W, true)} ${col(fmtUsageCost(agg), COST_W, true)}`);
	}
	if (byModel.length === 0) lines.push(theme.fg("dim", " (no usage recorded)"));
	lines.push("");

	const byProject = [...collected.byProject.entries()].sort(
		(a, b) => b[1].tokens.cost - a[1].tokens.cost || b[1].tokens.total - a[1].tokens.total,
	);
	lines.push(
		theme.fg("accent", ` ${col("BY PROJECT", 40)} ${col("TOKENS", TOK_W, true)} ${col("COST", COST_W, true)} ${col("SESSIONS", 8, true)}`),
	);
	for (const [, agg] of byProject) {
		lines.push(
			` ${col(shortPath(agg.cwd), 40)} ${col(fmtTokens(agg.tokens.total), TOK_W, true)} ${col(fmtUsageCost(agg.tokens), COST_W, true)} ${col(String(agg.sessions), 8, true)}`,
		);
	}
	if (byProject.length === 0) lines.push(theme.fg("dim", " (no usage recorded)"));
	lines.push("");

	const byMonth = [...collected.byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
	lines.push(theme.fg("accent", ` ${col("BY MONTH", 12)} ${col("TOKENS", TOK_W, true)} ${col("COST", COST_W, true)}`));
	for (const [month, agg] of byMonth) {
		lines.push(` ${col(month, 12)} ${col(fmtTokens(agg.total), TOK_W, true)} ${col(fmtUsageCost(agg), COST_W, true)}`);
	}
	if (byMonth.length === 0) lines.push(theme.fg("dim", " (no usage recorded)"));
	lines.push("");

	const byDay = [...collected.byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
	lines.push(theme.fg("accent", ` ${col("BY DAY", 12)} ${col("TOKENS", TOK_W, true)} ${col("COST", COST_W, true)}`));
	for (const [day, agg] of byDay) {
		lines.push(` ${col(day, 12)} ${col(fmtTokens(agg.total), TOK_W, true)} ${col(fmtUsageCost(agg), COST_W, true)}`);
	}
	if (byDay.length === 0) lines.push(theme.fg("dim", " (no usage recorded)"));

	return lines;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const BODY_ROWS = 16;

async function showSessionUsage(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const arg = args.trim().toLowerCase();
	let sinceMs = 0;
	let windowLabel = "all time";

	if (arg) {
		const days = /^(\d+)$/.exec(arg);
		if (days) {
			const n = Number(days[1]);
			sinceMs = Date.now() - n * 86_400_000;
			windowLabel = `last ${n} day${n === 1 ? "" : "s"}`;
		} else if (arg === "today") {
			const now = new Date();
			sinceMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			windowLabel = "today";
		} else {
			ctx.ui.notify("usage: pass a number of days (e.g. `/usage 7`) or `today`", "error");
			return;
		}
	}

	// Sessions root: PI_SESSION_DIR override, else derive from the
	// current session manager, else the default location.
	let root = process.env.PI_SESSION_DIR;
	if (!root) {
		const dir = ctx.sessionManager.getSessionDir();
		if (dir && dir.length > 0) {
			const parent = dir.slice(0, dir.lastIndexOf("/"));
			if (parent.endsWith("/sessions")) root = parent;
		}
	}
	root = root ?? join(homedir(), ".pi", "agent", "sessions");

	const collected = collectSessions(root, sinceMs, ctx.modelRegistry);
	if (collected.totals.total === 0 && collected.totals.cost === 0) {
		ctx.ui.notify(
			`usage: no usage data found in ${root}${windowLabel === "all time" ? "" : ` for ${windowLabel}`}`,
			"warning",
		);
		return;
	}

	if (ctx.mode !== "tui") {
		const { totals } = collected;
		ctx.ui.notify(
			`usage (${windowLabel}): ${fmtTokens(totals.total)} tokens · ${fmtUsageCost(totals)} · ` +
				`${collected.sessions} sessions` + costNotes(collected).map((note) => ` · ${note}`).join(""),
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const report = buildReport(collected, windowLabel, theme);
		let scroll = 0;
		const maxScroll = Math.max(0, report.length - BODY_ROWS);

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("  Token Usage")), 1, 0));
		const body = new Text("", 1, 0);
		const footer = new Text(
			theme.fg("dim", `  ${report.length} lines · ↑↓/PgUp/PgDn scroll · esc close`),
			1,
			0,
		);
		container.addChild(body);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const render = () => {
			body.setText(report.slice(scroll, scroll + BODY_ROWS).join("\n"));
		};
		render();

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, "escape") || matchesKey(data, "q")) {
					done(undefined);
					return;
				}
				if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
				else if (matchesKey(data, "down")) scroll = Math.min(maxScroll, scroll + 1);
				else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - BODY_ROWS);
				else if (matchesKey(data, "pageDown")) scroll = Math.min(maxScroll, scroll + BODY_ROWS);
				else if (matchesKey(data, "home")) scroll = 0;
				else if (matchesKey(data, "end")) scroll = maxScroll;
				else return;
				render();
				tui.requestRender();
			},
		};
	});
}

export const usageCommand: CommandDef = {
	description: "Show token usage and cost across all sessions (ccusage-style)",
	getArgumentCompletions: (prefix: string) => {
		const last = prefix.trim().toLowerCase();
		const matches = last === "" || "today".startsWith(last) ? [{ value: "today", label: "today" }] : [];
		return matches.length > 0 ? matches : null;
	},
	handler: async (args, ctx) => showSessionUsage(args, ctx),
};
