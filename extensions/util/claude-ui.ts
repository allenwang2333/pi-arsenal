/**
 * Claude Code-style chrome for Pi.
 *
 * This leaves the active theme alone. It changes the startup header (Clawd
 * beside the Pi version, model, and cwd), the `❯` prompt and its gray border,
 * earlier user messages (a `❯` column on one background row), the
 * hidden thinking label, and the working spinner: Claude's glyphs in Claude
 * orange, a random Claude verb, elapsed time, output tokens, thinking effort,
 * and the interrupt key.
 */

import { homedir } from "node:os";
import { sep } from "node:path";
import {
	AssistantMessageComponent,
	CustomEditor,
	keyText,
	UserMessageComponent,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type MarkdownTransformer,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	MouseRegion,
	Spacer,
	Text,
	rgbColor,
	truncateToWidth,
	type Component,
	type EditorTheme,
	type MarkdownTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const PROMPT = "❯ ";
const PROMPT_WIDTH = 2;
const CLAUDE_ORANGE = rgbColor(215, 119, 87);
// Claude Code plays these forward then back, with ✻ for ✽ in Ghostty.
const SPINNER_GLYPHS =
	process.env.TERM === "xterm-ghostty" ? ["·", "✢", "✳", "✶", "✻", "✻"] : ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...SPINNER_GLYPHS, ...[...SPINNER_GLYPHS].reverse()];
const SPINNER_INTERVAL_MS = 120;
// Claude Code 2.1's spinner verbs.
const SPINNER_VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming", "Beboppin'", "Befuddling",
	"Billowing", "Blanching", "Bloviating", "Boogieing", "Boondoggling", "Booping", "Bootstrapping", "Brewing",
	"Bunning", "Burrowing", "Calculating", "Canoodling", "Caramelizing", "Cascading", "Catapulting", "Cerebrating",
	"Channeling", "Choreographing", "Churning", "Clauding", "Coalescing", "Cogitating", "Combobulating", "Composing",
	"Computing", "Concocting", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching",
	"Crystallizing", "Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying", "Discombobulating",
	"Doing", "Doodling", "Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning",
	"Fermenting", "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing",
	"Fluttering", "Forging", "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping", "Garnishing",
	"Generating", "Gesticulating", "Germinating", "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing",
	"Hatching", "Herding", "Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining", "Improvising",
	"Incubating", "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning", "Kerfuffling", "Kneading",
	"Leavening", "Levitating", "Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting",
	"Moonwalking", "Moseying", "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting", "Newspapering", "Noodling",
	"Nucleating", "Onioning", "Orbiting", "Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing",
	"Philosophizing", "Photosynthesizing", "Polishing", "Pollinating", "Pondering", "Pontificating", "Pouncing",
	"Precipitating", "Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering", "Puzzling",
	"Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting", "Ruminating",
	"Sautéing", "Scampering", "Schlepping", "Scurrying", "Seasoning", "Shenaniganing", "Shimmying", "Simmering",
	"Skedaddling", "Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting",
	"Stewing", "Sublimating", "Swirling", "Swooping", "Symbioting", "Synthesizing", "Tempering", "Thinking",
	"Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring", "Transmogrifying", "Transmuting",
	"Twisting", "Undulating", "Unfurling", "Unraveling", "Vibing", "Waddling", "Wandering", "Warping",
	"Whatchamacalliting", "Whirlpooling", "Whirring", "Whisking", "Wibbling", "Working", "Wrangling", "Zesting",
	"Zigzagging",
];
const CLAWD = [" ▐▛███▜▌", "▝▜█████▛▘", "  ▘▘ ▝▝"];
const CLAWD_WIDTH = 9;
// Shell-integration marks that Pi puts around each user message.
const PROMPT_ZONE_START = "\x1b]133;A\x07";
const PROMPT_ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
const USER_MESSAGE_PATCH = Symbol.for("pi-warehouse.claude-ui.user-message");

class ClaudeStyleEditor extends CustomEditor {
	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, theme: Theme) {
		super(tui, editorTheme, keybindings, { paddingX: PROMPT_WIDTH });
		// Pi recolors the border for each thinking level. Claude Code keeps it gray, with a
		// separate color for `!` commands. Editor declares borderColor as a field, so the
		// accessor must be defined on the instance to ignore Pi's assignments.
		Object.defineProperty(this, "borderColor", {
			configurable: true,
			get: () => (text: string) =>
				theme.fg(this.getText().trimStart().startsWith("!") ? "bashMode" : "border", text),
			set: () => {},
		});
	}

	// Pi copies the editorPaddingX setting onto custom editors. Keep room for the prompt.
	setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(PROMPT_WIDTH, padding));
	}

	render(width: number): string[] {
		const lines = super.render(width);
		// Row 0 is the top border. Row 1 is the first text row and starts with the left padding.
		const first = lines[1];
		if (width > 2 * PROMPT_WIDTH && first?.startsWith(" ".repeat(PROMPT_WIDTH))) {
			lines[1] = this.borderColor(PROMPT) + first.slice(PROMPT_WIDTH);
		}
		return lines;
	}
}

/** Fields of Pi's UserMessageComponent. They are private in its type declarations. */
type UserMessageFields = {
	text: string;
	markdownTheme: MarkdownTheme;
	outputPad: number;
	markdownTransformers: readonly MarkdownTransformer[];
};

/**
 * Claude Code's user message: a dim `❯` column, the text beside it with a hanging
 * indent, one background, and no blank rows above or below.
 */
export function renderUserMessage(message: UserMessageFields, width: number, theme: Theme): string[] {
	const pad = Math.max(0, message.outputPad);
	// One column of right padding, as in Claude Code.
	const textWidth = width - pad - PROMPT_WIDTH - 1;
	if (textWidth < 1) return [];
	const markdown = new Markdown(
		message.text,
		0,
		0,
		message.markdownTheme,
		{
			color: (text) => theme.fg("userMessageText", text),
			bgColor: (text) => theme.bg("userMessageBg", text),
		},
		{
			preserveOrderedListMarkers: true,
			preserveBackslashEscapes: true,
			transform: (source, availableWidth) =>
				message.markdownTransformers.reduce((current, transformer) => {
					try {
						const next = transformer(current, { messageType: "user", isStreaming: false, availableWidth });
						return typeof next === "string" ? next : current;
					} catch {
						return current;
					}
				}, source),
		},
	);
	const body = markdown.render(textWidth);
	if (body.length === 0) return [];
	const lines = body.map((line, index) => {
		const prompt = index === 0 ? theme.fg("dim", PROMPT) : " ".repeat(PROMPT_WIDTH);
		return theme.bg("userMessageBg", " ".repeat(pad) + prompt) + line + theme.bg("userMessageBg", " ");
	});
	lines[0] = PROMPT_ZONE_START + lines[0];
	lines[lines.length - 1] = PROMPT_ZONE_END + lines[lines.length - 1];
	return lines;
}

type UserMessagePrototype = {
	render(width: number): string[];
	invalidate(): void;
	[USER_MESSAGE_PATCH]?: { render(width: number): string[]; invalidate(): void };
};

/**
 * Pi has no hook for user message layout, so this replaces the component's render.
 * In the bundled CLI the extension imports the same class Pi draws with. Returns the undo.
 */
export function patchUserMessages(theme: Theme): () => void {
	const proto = UserMessageComponent.prototype as unknown as UserMessagePrototype;
	const original = (proto[USER_MESSAGE_PATCH] ??= { render: proto.render, invalidate: proto.invalidate });
	const cache = new WeakMap<object, { width: number; pad: number; lines: string[] }>();

	function render(this: UserMessageFields, width: number): string[] {
		const cached = cache.get(this);
		if (cached?.width === width && cached.pad === this.outputPad) return cached.lines;
		const lines = renderUserMessage(this, width, theme);
		cache.set(this, { width, pad: this.outputPad, lines });
		return lines;
	}
	function invalidate(this: UserMessageFields): void {
		cache.delete(this);
		original.invalidate.call(this);
	}

	proto.render = render;
	proto.invalidate = invalidate;
	return () => {
		// After a reload the new runtime patches again. Leave its patch in place.
		if (proto.render !== render) return;
		proto.render = original.render;
		proto.invalidate = original.invalidate;
	};
}

const ASSISTANT_MESSAGE_PATCH = Symbol.for("pi-warehouse.claude-ui.hidden-thinking");
type AssistantUpdateContent = AssistantMessageComponent["updateContent"];
type AssistantMessagePrototype = {
	updateContent: AssistantUpdateContent;
	[ASSISTANT_MESSAGE_PATCH]?: AssistantUpdateContent;
};

export function patchHiddenThinkingBlocks(): () => void {
	const proto = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototype;
	const original = (proto[ASSISTANT_MESSAGE_PATCH] ??= proto.updateContent);
	// Pi wraps hidden thinking in a Text-backed MouseRegion; visible thinking uses Markdown.
	const isHiddenThinking = (child: Component | undefined) =>
		child instanceof MouseRegion && (child as unknown as { child: Component }).child instanceof Text;

	function updateContent(this: { contentContainer: Container }, ...args: Parameters<AssistantUpdateContent>): void {
		original.call(this, ...args);
		const children = this.contentContainer.children;
		const visible = children.filter((child, index) => {
			if (isHiddenThinking(child)) return false;
			// Keep spacers before standalone error Text, but remove those attached to hidden thinking.
			return !(child instanceof Spacer && isHiddenThinking(children[index - 1]) && !(children[index + 1] instanceof Text));
		});
		if (visible.length === children.length) return;
		this.contentContainer.clear();
		for (let index = 0; index < visible.length; index++) {
			const child = visible[index]!;
			if (child instanceof Spacer && (visible[index - 1] instanceof Spacer || index === visible.length - 1)) continue;
			this.contentContainer.addChild(child);
		}
	}

	proto.updateContent = updateContent;
	return () => {
		if (proto.updateContent === updateContent) proto.updateContent = original;
	};
}

type HeaderInfo = { model: string; cwd: string };

function formatCwd(cwd: string): string {
	const home = homedir();
	return cwd === home || cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
}

function headerInfo(ctx: ExtensionContext): HeaderInfo {
	const model = ctx.model;
	const cwd = formatCwd(ctx.cwd);
	if (!model) return { model: "No model selected", cwd };
	return { model: `${model.name || model.id} · ${ctx.modelRegistry.getProviderDisplayName(model.provider)}`, cwd };
}

// The header is a session-start snapshot. A changed line above the viewport
// makes Pi redraw the whole screen, so it never updates afterwards.
function createHeader(theme: Theme, info: HeaderInfo) {
	return {
		render(width: number): string[] {
			const text = [
				theme.bold("Pi") + theme.fg("dim", ` v${VERSION}`),
				theme.fg("dim", info.model),
				theme.fg("dim", info.cwd),
			];
			const showClawd = width >= CLAWD_WIDTH + 24;
			return text.map((line, index) => {
				const art = showClawd ? `${theme.style(CLAWD[index]!.padEnd(CLAWD_WIDTH), { fg: CLAUDE_ORANGE })}  ` : "";
				return truncateToWidth(` ${art}${line}`, width, "…");
			});
		},
		invalidate() {},
	};
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type WorkingProgress = { tokens: number; estimated: boolean; thinking: boolean };

function workingMessage(
	theme: Theme,
	verb: string,
	elapsedMs: number,
	progress: WorkingProgress,
	effort: string | undefined,
): string {
	const key = keyText("app.interrupt") || "escape";
	const parts: string[] = [];
	if (elapsedMs >= 1000) parts.push(formatElapsed(elapsedMs));
	if (progress.tokens > 0) parts.push(`↓ ${progress.estimated ? "~" : ""}${progress.tokens} tokens`);
	if (progress.thinking) parts.push(`still thinking${effort && effort !== "off" ? ` with ${effort} effort` : ""}`);
	parts.push(`${key === "escape" ? "esc" : key} to interrupt`);
	// Pi wraps the message in one color, so each part sets its own.
	return `${theme.style(`${verb}…`, { fg: CLAUDE_ORANGE })} ${theme.fg("dim", `(${parts.join(" · ")})`)}`;
}

export function installClaudeInput(pi: ExtensionAPI): void {
	let unpatchUserMessages: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unpatchUserMessages?.();
		unpatchUserMessages = patchUserMessages(ctx.ui.theme);
		ctx.ui.setEditorComponent(
			(tui, editorTheme, keybindings) => new ClaudeStyleEditor(tui, editorTheme, keybindings, ctx.ui.theme),
		);
	});
	pi.on("session_shutdown", () => {
		unpatchUserMessages?.();
		unpatchUserMessages = undefined;
	});
}

export function installClaudeSpinner(pi: ExtensionAPI): void {
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let unpatchHiddenThinking: (() => void) | undefined;
	let progress: WorkingProgress = { tokens: 0, estimated: false, thinking: false };
	let streamedCharacters = 0;
	const stopSpinner = () => {
		if (spinnerTimer) clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unpatchHiddenThinking?.();
		unpatchHiddenThinking = patchHiddenThinkingBlocks();
		// Pi draws custom frames verbatim, so they carry their own color.
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => ctx.ui.theme.style(frame, { fg: CLAUDE_ORANGE })),
			intervalMs: SPINNER_INTERVAL_MS,
		});
		// Claude Code omits raw thinking blocks in its normal transcript.
		ctx.ui.setHiddenThinkingLabel("");
	});

	// Keep one verb and elapsed time per run; count output only for the current turn.
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopSpinner();
		progress = { tokens: 0, estimated: false, thinking: false };
		streamedCharacters = 0;
		const verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
		const startedAt = Date.now();
		const update = () => {
			try {
				const effort = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
				ctx.ui.setWorkingMessage(workingMessage(ctx.ui.theme, verb, Date.now() - startedAt, progress, effort));
			} catch {
				// A ctx goes stale after reload or session replacement.
				stopSpinner();
			}
		};
		spinnerTimer = setInterval(update, 1000);
		update();
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !spinnerTimer) return;
		progress = { tokens: 0, estimated: false, thinking: false };
		streamedCharacters = 0;
	});
	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !spinnerTimer || event.message.role !== "assistant") return;
		streamedCharacters = 0;
		progress = { tokens: 0, estimated: false, thinking: false };
	});
	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui" || !spinnerTimer || event.message.role !== "assistant") return;
		const stream = event.assistantMessageEvent;
		switch (stream.type) {
			case "thinking_start":
			case "thinking_delta":
				progress.thinking = true;
				break;
			case "thinking_end":
			case "text_start":
			case "text_delta":
			case "toolcall_start":
			case "toolcall_delta":
			case "done":
			case "error":
				progress.thinking = false;
		}
		// Providers often send usage only at message end. Mark the live fallback as an estimate.
		if ("delta" in stream) streamedCharacters += stream.delta.length;
		const estimate = Math.ceil(streamedCharacters / 4);
		const reported = event.message.usage.output;
		progress.tokens = Math.max(reported, estimate);
		progress.estimated = estimate > reported;
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui" || !spinnerTimer || event.message.role !== "assistant") return;
		const reported = event.message.usage.output;
		progress = {
			tokens: reported > 0 ? reported : Math.ceil(streamedCharacters / 4),
			estimated: reported <= 0 && streamedCharacters > 0,
			thinking: false,
		};
		streamedCharacters = 0;
	});
	pi.on("agent_end", stopSpinner);
	pi.on("session_shutdown", () => {
		stopSpinner();
		unpatchHiddenThinking?.();
		unpatchHiddenThinking = undefined;
	});
}

export function installClaudeUi(pi: ExtensionAPI): void {
	installClaudeInput(pi);
	installClaudeSpinner(pi);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const info = headerInfo(ctx);
		ctx.ui.setHeader((_tui, theme) => createHeader(theme, info));
	});
}
