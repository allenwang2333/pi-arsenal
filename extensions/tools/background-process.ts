/**
 * background-process — start bounded background commands and inspect them later.
 *
 * A command starts in its own process group and this tool returns immediately,
 * so pi can answer new prompts while it runs. A rpiv-todo-style panel above the
 * editor shows processes collapsed by default behind a hidden count.
 * Clicking the panel expands all rows. Processes are scoped to the current pi
 * session and stop on shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { clickToToggle, hiddenRow, treeRows } from "../util/clickable-panel.ts";

const DEFAULT_TIMEOUT_SECONDS = 5 * 60;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_LOG_BYTES = 20 * 1024;
const WIDGET_UPDATE_MS = 5_000;
const WIDGET_ID = "background-process";

type ProcessStatus = "running" | "stopping" | "completed" | "failed" | "timed_out" | "cancelled";

// Glyph and color per status, mirroring the rpiv-todo overlay's task rows.
const STATUS_GLYPH: Record<ProcessStatus, string> = {
	running: "◐",
	stopping: "◐",
	completed: "✓",
	failed: "✗",
	timed_out: "✗",
	cancelled: "⊘",
};

const STATUS_COLOR: Record<ProcessStatus, "warning" | "success" | "error" | "muted"> = {
	running: "warning",
	stopping: "warning",
	completed: "success",
	failed: "error",
	timed_out: "error",
	cancelled: "muted",
};

type BackgroundProcess = {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	timeoutMs: number;
	child: ChildProcess;
	stdoutPath: string;
	stderrPath: string;
	status: ProcessStatus;
	timedOut: boolean;
	stopRequested: boolean;
	// Finished before a turn ended: hidden from the panel, still available to status and list.
	dismissed: boolean;
	timeout?: NodeJS.Timeout;
	forceKill?: NodeJS.Timeout;
	finishedAt?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	error?: string;
};

const schema = Type.Object({
	action: StringEnum(["start", "status", "list", "stop"] as const, {
		description: "start a command, inspect one command, list commands, or stop one command",
	}),
	command: Type.Optional(Type.String({ description: "Shell command to run; required for action=start" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for action=start; defaults to the project directory" })),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
			description: `Maximum runtime for action=start; defaults to ${DEFAULT_TIMEOUT_SECONDS} seconds`,
		}),
	),
	processId: Type.Optional(Type.String({ description: "Background process ID; required for action=status and action=stop" })),
	outputLines: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 500, description: "Log lines to show per stream when checking status" }),
	),
});

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function readLogTail(path: string, maxLines: number): Promise<string> {
	try {
		const info = await stat(path);
		const bytes = Math.min(info.size, MAX_LOG_BYTES);
		if (bytes === 0) return "(no output yet)";

		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(bytes);
			await handle.read(buffer, 0, bytes, info.size - bytes);
			const prefix = info.size > bytes ? "[earlier output omitted]\n" : "";
			return prefix + buffer.toString("utf8").split(/\r?\n/).slice(-maxLines).join("\n");
		} finally {
			await handle.close();
		}
	} catch (error) {
		return `(log unavailable: ${error instanceof Error ? error.message : String(error)})`;
	}
}

function terminate(process: BackgroundProcess, signal: NodeJS.Signals): void {
	if (process.child.exitCode !== null) return;
	try {
		// detached gives POSIX children their own process group, including shell descendants.
		if (globalThis.process.platform !== "win32" && process.child.pid) {
			globalThis.process.kill(-process.child.pid, signal);
		} else {
			process.child.kill(signal);
		}
	} catch {
		// The process may have exited between the check and kill.
	}
}

function currentStatus(process: BackgroundProcess): ProcessStatus {
	if (process.finishedAt) return process.status;
	if (process.timedOut) return "timed_out";
	if (process.stopRequested) return "stopping";
	return "running";
}

// One overlay row: glyph, id, status, runtime, then the command as quiet context.
function formatProcessRow(process: BackgroundProcess, theme: Theme): string {
	const status = currentStatus(process);
	const runtime = formatDuration((process.finishedAt ?? Date.now()) - process.startedAt);
	let row = `${theme.fg(STATUS_COLOR[status], STATUS_GLYPH[status])} ${theme.fg("dim", process.id)} ${theme.fg(STATUS_COLOR[status], status)} ${theme.fg("muted", `· ${runtime}`)}`;
	const command = process.command.replace(/\s+/g, " ").trim();
	if (command) {
		const text = theme.fg("dim", command);
		row += ` — ${status === "completed" ? theme.strikethrough(text) : text}`;
	}
	return row;
}

function snapshot(process: BackgroundProcess) {
	const status = currentStatus(process);
	return {
		id: process.id,
		status,
		isRunning: !process.finishedAt,
		pid: process.child.pid,
		command: process.command,
		cwd: process.cwd,
		startedAt: new Date(process.startedAt).toISOString(),
		finishedAt: process.finishedAt ? new Date(process.finishedAt).toISOString() : undefined,
		runtime: formatDuration((process.finishedAt ?? Date.now()) - process.startedAt),
		timeout: formatDuration(process.timeoutMs),
		exitCode: process.exitCode,
		exitSignal: process.exitSignal,
		error: process.error,
		stdoutPath: process.stdoutPath,
		stderrPath: process.stderrPath,
	};
}

export default function (pi: ExtensionAPI) {
	const processes = new Map<string, BackgroundProcess>();
	let expanded = false;
	let sequence = 0;
	let shuttingDown = false;
	let uiContext: ExtensionContext | undefined;
	let widgetTimer: NodeJS.Timeout | undefined;

	function stopWidgetTimer(): void {
		if (!widgetTimer) return;
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	}

	function clearProcessWidget(): void {
		stopWidgetTimer();
		expanded = false;
		if (uiContext?.mode === "tui") uiContext.ui.setWidget(WIDGET_ID, undefined);
	}

	// Show processes collapsed by default behind a hint; clicking expands all rows.
	function refreshProcessWidget(): void {
		if (shuttingDown || uiContext?.mode !== "tui") return;

		const running = [...processes.values()].filter((process) => !process.finishedAt);
		const finished = [...processes.values()].filter((process) => process.finishedAt && !process.dismissed);
		if (running.length + finished.length === 0) {
			clearProcessWidget();
			return;
		}

		uiContext.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => {
				const active = running.length > 0;
				const headingColor = active ? "accent" : "dim";
				const total = running.length + finished.length;
				const heading = `${theme.fg(headingColor, active ? "●" : "○")} ${theme.fg(headingColor, `Background Processes (${finished.length}/${total})`)}`;
				let rowTexts: string[];
				if (!expanded) {
					rowTexts = [
						hiddenRow(
							theme,
							running.length > 0 ? running.length : finished.length,
							running.length > 0 ? "running" : "finished",
						),
					];
				} else {
					rowTexts = [...running, ...finished].map((process) => formatProcessRow(process, theme));
				}
				const rows = treeRows(theme, rowTexts);
				return clickToToggle(
					{
						render: (width: number) => [heading, ...rows, ""].map((line) => truncateToWidth(line, width, "…")),
						invalidate: () => {},
					},
					() => {
						expanded = !expanded;
						refreshProcessWidget();
					},
				);
			},
			{ placement: "aboveEditor" },
		);

		if (running.length === 0) {
			stopWidgetTimer();
		} else if (!widgetTimer) {
			widgetTimer = setInterval(refreshProcessWidget, WIDGET_UPDATE_MS);
			widgetTimer.unref();
		}
	}

	function requestStop(process: BackgroundProcess, timedOut = false): void {
		if (process.finishedAt) return;
		process.stopRequested = true;
		process.timedOut ||= timedOut;
		refreshProcessWidget();
		terminate(process, "SIGTERM");
		process.forceKill = setTimeout(() => terminate(process, "SIGKILL"), 5_000);
		process.forceKill.unref();
	}

	function finish(
		process: BackgroundProcess,
		status: "completed" | "failed" | "timed_out" | "cancelled",
		exitCode?: number | null,
		exitSignal?: NodeJS.Signals | null,
		error?: string,
	): void {
		if (process.finishedAt) return;
		if (process.timeout) clearTimeout(process.timeout);
		if (process.forceKill) clearTimeout(process.forceKill);
		process.status = process.timedOut ? "timed_out" : process.stopRequested ? "cancelled" : status;
		process.exitCode = exitCode;
		process.exitSignal = exitSignal;
		process.error = error;
		process.finishedAt = Date.now();
		refreshProcessWidget();
	}

	async function start(command: string, cwd: string, timeoutSeconds: number): Promise<BackgroundProcess> {
		// Fail fast with the cwd in the message: spawn alone reports only ENOENT for a missing directory.
		try {
			if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
		}
		const id = `bg_${++sequence}`;
		const directory = await mkdtemp(join(tmpdir(), "pi-background-"));
		const stdoutPath = join(directory, "stdout.log");
		const stderrPath = join(directory, "stderr.log");
		const stdout = createWriteStream(stdoutPath);
		const stderr = createWriteStream(stderrPath);
		const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		const background: BackgroundProcess = {
			id,
			command,
			cwd,
			startedAt: Date.now(),
			timeoutMs: timeoutSeconds * 1000,
			child,
			stdoutPath,
			stderrPath,
			status: "running",
			timedOut: false,
			stopRequested: false,
			dismissed: false,
		};
		processes.set(id, background);
		refreshProcessWidget();

		child.stdout?.pipe(stdout);
		child.stderr?.pipe(stderr);
		child.on("error", (error) => finish(background, "failed", undefined, undefined, `spawn failed in ${cwd}: ${error.message}`));
		child.on("close", (code, signal) => {
			stdout.end();
			stderr.end();
			finish(background, code === 0 ? "completed" : "failed", code, signal);
		});
		background.timeout = setTimeout(() => requestStop(background, true), background.timeoutMs);
		background.timeout.unref();
		return background;
	}

	pi.on("agent_settled", () => {
		for (const process of processes.values()) if (process.finishedAt) process.dismissed = true;
		refreshProcessWidget();
	});

	pi.on("session_start", (_event, ctx) => {
		uiContext = ctx;
		shuttingDown = false;
	});

	pi.registerTool(
		defineTool({
			name: "background-process",
			label: "Background Process",
			description:
				"Start a shell command without waiting for it, with a required bounded timeout (default 5 minutes), then inspect its output/status or stop it. In TUI mode, a rpiv-todo-style panel above the editor shows background processes collapsed by default; click the panel to expand running and finished rows. Commands are stopped when the pi session ends.",
			promptSnippet: "Run bounded shell commands in the background and later inspect or stop them",
			promptGuidelines: [
				"Use background-process action=start for commands that may take a while when the user should be able to continue the conversation. Give every background-process start a suitable timeoutSeconds.",
				"Background-process completion status is TUI-only. Use action=status only when asked for progress or completion; do not poll it repeatedly or claim completion without checking its status.",
			],
			parameters: schema,

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (params.action === "start") {
					if (!params.command?.trim()) throw new Error("action=start requires a non-empty command");
					const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
					const cwd = resolve(ctx.cwd, params.cwd ?? ".");
					const process = await start(params.command, cwd, timeoutSeconds);
					const data = snapshot(process);
					return {
						content: [{ type: "text", text: `Started ${process.id} (PID ${process.child.pid ?? "pending"}) in the background. Timeout: ${formatDuration(process.timeoutMs)}.` }],
						details: data,
					};
				}

				if (params.action === "list") {
					const entries = [...processes.values()].map(snapshot);
					return {
						content: [{ type: "text", text: entries.length ? entries.map((item) => `${item.id}: ${item.status} (${item.runtime}) — ${item.command}`).join("\n") : "No background processes have been started in this session." }],
						details: { processes: entries },
					};
				}

				if (!params.processId) throw new Error(`action=${params.action} requires processId`);
				const process = processes.get(params.processId);
				if (!process) throw new Error(`Unknown background process: ${params.processId}`);

				if (params.action === "stop") {
					requestStop(process);
					return {
						content: [{ type: "text", text: process.finishedAt ? `${process.id} has already finished (${currentStatus(process)}).` : `Requested stop for ${process.id}. Check its status shortly to confirm it has exited.` }],
						details: snapshot(process),
					};
				}

				const outputLines = params.outputLines ?? 80;
				const [stdout, stderr] = await Promise.all([
					readLogTail(process.stdoutPath, outputLines),
					readLogTail(process.stderrPath, outputLines),
				]);
				const data = snapshot(process);
				return {
					content: [{
						type: "text",
						text: `${process.id}: ${data.status}${data.isRunning ? " (still running)" : ""}\nRuntime: ${data.runtime} / timeout ${data.timeout}\nExit: ${data.exitCode ?? "not available"}${data.exitSignal ? ` (${data.exitSignal})` : ""}${data.error ? `\nError: ${data.error}` : ""}\n\nstdout (tail):\n${stdout}\n\nstderr (tail):\n${stderr}`,
					}],
					details: data,
				};
			},
		}),
	);

	pi.on("session_shutdown", (_event, ctx) => {
		uiContext = ctx;
		shuttingDown = true;
		clearProcessWidget();
		for (const process of processes.values()) {
			requestStop(process);
			// Pi may exit before the graceful-kill timer can fire, so do not leave
			// a detached process group behind after this session is gone.
			terminate(process, "SIGKILL");
		}
	});
}
