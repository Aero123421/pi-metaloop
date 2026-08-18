/**
 * Flat, width-aware TUI panel for meta-loop.
 *
 * No box drawing. Hierarchy comes from indent, weight and color, so nothing can
 * fall out of alignment when the terminal is resized, and a full-width Japanese
 * goal cannot push a border off the edge. Every column is measured in display
 * cells rather than code points for the same reason.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { runElapsed, ticketCounts, type PersistedRun } from "./board-store.ts";

export type PanelDetail = "compact" | "normal" | "full";

export const PANEL_DETAIL_ORDER: PanelDetail[] = ["compact", "normal", "full"];

export function nextDetail(cur: PanelDetail): PanelDetail {
	const i = PANEL_DETAIL_ORDER.indexOf(cur);
	return PANEL_DETAIL_ORDER[(i + 1) % PANEL_DETAIL_ORDER.length]!;
}

type Tone = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text" | "borderMuted" | "borderAccent";

/** One piece of a row. Kept unrendered until layout is done so widths stay measurable. */
interface Seg {
	s: string;
	tone?: Tone;
	bold?: boolean;
}

const MIN_WIDTH = 44;
const MAX_WIDTH = 120;
const DEFAULT_WIDTH = 80;

function fg(theme: Theme, tone: Tone, s: string): string {
	return theme.fg(tone as any, s);
}

/** theme.bold exists on the real Theme; guard so plain stubs still render. */
function strong(theme: Theme, s: string): string {
	const b = (theme as any).bold;
	if (typeof b !== "function") return s;
	try {
		return b.call(theme, s);
	} catch {
		return s;
	}
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

/** Terminal cells a string occupies: CJK counts double, combining marks zero. */
export function dispWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		if (cp === 0x200d || cp === 0xfe0f) continue;
		if (cp >= 0x0300 && cp <= 0x036f) continue;
		w += isWide(cp) ? 2 : 1;
	}
	return w;
}

function padTo(s: string, n: number): string {
	const w = dispWidth(s);
	return w >= n ? s : s + " ".repeat(n - w);
}

function trunc(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	if (n <= 0) return "";
	if (dispWidth(t) <= n) return t;
	let out = "";
	let w = 0;
	for (const ch of t) {
		const cw = dispWidth(ch);
		if (w + cw > n - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/** Pad or clip to exactly n cells — used for the ticket id column. */
export function padCell(s: string, n: number): string {
	return padTo(trunc(s, n), n);
}

function segsWidth(segs: Seg[]): number {
	let w = 0;
	for (const seg of segs) w += dispWidth(seg.s);
	return w;
}

function paint(theme: Theme, segs: Seg[]): string {
	let out = "";
	for (const seg of segs) {
		if (!seg.s) continue;
		const colored = seg.tone ? fg(theme, seg.tone, seg.s) : seg.s;
		out += seg.bold ? strong(theme, colored) : colored;
	}
	return out;
}

/** Left segments, then right segments flushed to `width`. */
function spread(theme: Theme, left: Seg[], right: Seg[], width: number): string {
	if (right.length === 0) return paint(theme, left);
	const gap = width - segsWidth(left) - segsWidth(right);
	if (gap < 2) return paint(theme, left);
	return paint(theme, left) + " ".repeat(gap) + paint(theme, right);
}

/** Unicode block progress bar */
export function progressBar(done: number, total: number, width = 16, theme?: Theme): string {
	const t = Math.max(0, total);
	const d = Math.max(0, Math.min(done, t || done));
	const ratio = t === 0 ? 0 : d / t;
	const filled = Math.round(ratio * width);
	const empty = Math.max(0, width - filled);
	const label = t === 0 ? "—/—" : `${d}/${t}`;
	if (!theme) return `${"█".repeat(filled)}${"░".repeat(empty)} ${label}`;
	const complete = t > 0 && d === t;
	return (
		fg(theme, complete ? "success" : "accent", "█".repeat(filled)) +
		fg(theme, "dim", "░".repeat(empty)) +
		" " +
		fg(theme, complete ? "success" : "text", label)
	);
}

function mlTone(status: string, phase: string): Tone {
	// A parked run needs the eye: nothing moves until someone answers.
	if (phase === "awaiting-approval") return "warning";
	if (status === "running" || phase === "executing" || phase === "planning") return "accent";
	if (status === "done" || phase === "done") return "success";
	if (status === "incomplete" || phase === "incomplete") return "warning";
	if (status === "stopped" || phase === "stopped") return "muted";
	if (status === "error" || phase === "plan_failed" || phase === "degraded") return "error";
	return "muted";
}

export function ticketIcon(status: string): string {
	switch (status) {
		case "done":
			return "✓";
		case "running":
			return "●";
		case "partial":
			return "◐";
		case "failed":
		case "cancelled":
			return "✗";
		case "blocked":
			return "■";
		default:
			return "○";
	}
}

function ticketTone(status: string): Tone {
	switch (status) {
		case "done":
			return "success";
		case "running":
			return "accent";
		case "partial":
			return "warning";
		case "failed":
		case "cancelled":
		case "blocked":
			return "error";
		default:
			return "dim";
	}
}

function verdictTone(v: string): Tone {
	return v === "green" ? "success" : v === "yellow" ? "warning" : "error";
}

function spinnerFrame(tick: number): string {
	return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][tick % 10]!;
}

export interface LiveOverlay {
	label: string;
	activity: string;
}

export interface PanelInput {
	theme: Theme;
	detail: PanelDetail;
	tick: number;
	/** Force show finished panel (e.g. after /tasks) */
	forceShow?: boolean;
	ml?: PersistedRun | null;
	live?: LiveOverlay | null;
	/** Hide finished ML panel after this many ms (default 120s) */
	hideFinishedAfterMs?: number;
	/** Terminal columns; clamped into a readable range. */
	width?: number;
}

function panelWidth(input: PanelInput): number {
	const raw = input.width ?? DEFAULT_WIDTH;
	if (!Number.isFinite(raw)) return DEFAULT_WIDTH;
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(raw)));
}

/** Whether the below-editor widget should be visible. */
export function shouldShowPanel(input: PanelInput): boolean {
	if (input.forceShow) return Boolean(input.ml);
	if (!input.ml) return false;
	if (input.ml.status === "running") return true;
	// recent terminal outcome stays visible briefly, then the panel hides itself
	const hideAfter = input.hideFinishedAfterMs ?? 90_000;
	const end = Date.parse(input.ml.finishedAt || input.ml.updatedAt || "");
	if (!Number.isFinite(end)) return input.ml.status !== "done" && input.ml.status !== "stopped";
	return Date.now() - end < hideAfter;
}

/** Non-zero ticket counters only — a row of `✗0 ■0` is noise, not status. */
function counterSegs(c: ReturnType<typeof ticketCounts>): Seg[] {
	const out: Seg[] = [];
	const push = (glyph: string, n: number, tone: Tone) => {
		if (n <= 0) return;
		if (out.length > 0) out.push({ s: " " });
		out.push({ s: `${glyph}${n}`, tone });
	};
	push("✓", c.done, "success");
	push("◐", c.partial, "warning");
	push("●", c.running, "accent");
	push("○", c.pending, "dim");
	push("■", c.blocked, "error");
	push("✗", c.failed, "error");
	return out;
}

/** Same counters as the panel, uncolored — for notify() output. */
export function countersText(c: ReturnType<typeof ticketCounts>): string {
	return counterSegs(c)
		.map((seg) => seg.s)
		.join("");
}

export function buildFooterLine(input: PanelInput): string {
	const { theme } = input;
	const parts: string[] = [];

	if (input.ml && (input.ml.status === "running" || shouldShowPanel(input))) {
		const c = ticketCounts(input.ml.board);
		const tone = mlTone(input.ml.status, input.ml.board.phase);
		const run = input.ml;
		const running = run.status === "running";
		const segs: Seg[] = [
			{ s: running ? `${spinnerFrame(input.tick)} ` : `${statusGlyph(run.status)} `, tone },
			{ s: "meta-loop", tone, bold: true },
			{ s: " " },
			{ s: running ? run.board.phase : run.status, tone },
			{ s: "  " },
			{ s: `${c.done + c.partial}/${c.total || 0}`, tone: "text" },
		];
		const counters = counterSegs(c);
		if (counters.length > 0) segs.push({ s: " " }, ...counters);
		const v = run.board.verdict?.verdict;
		if (v) segs.push({ s: "  audit ", tone: "dim" }, { s: v, tone: verdictTone(v) });
		segs.push({ s: `  ${runElapsed(run)}`, tone: "dim" });
		parts.push(paint(theme, segs));
	}

	return parts.join("");
}

export function buildPanelLines(input: PanelInput): string[] {
	if (!shouldShowPanel(input)) return [];

	const { theme, detail } = input;
	const width = panelWidth(input);
	const lines: string[] = [];
	const compact = detail === "compact";
	const full = detail === "full";

	if (input.ml) {
		const run = input.ml;
		const c = ticketCounts(run.board);
		const tone = mlTone(run.status, run.board.phase);
		const running = run.status === "running";
		const awaiting = run.board.phase === "awaiting-approval";
		const glyph = awaiting ? phaseGlyph(run.board.phase, "◆") : running ? spinnerFrame(input.tick) : statusGlyph(run.status);

		// ── title: what it is, what it is doing, for how long
		const head: Seg[] = [
			{ s: `${glyph} `, tone },
			{ s: "meta-loop", tone, bold: true },
			{ s: "   " },
			{ s: running ? run.board.phase : run.status, tone, bold: true },
			{ s: " · ", tone: "dim" },
			{ s: runElapsed(run), tone: "muted" },
		];
		lines.push(spread(theme, head, compact ? [] : counterSegs(c), width));

		if (compact) {
			const label = trunc(input.live?.label || run.label || run.goal, Math.max(12, width - 26));
			lines.push(
				"  " +
					progressBar(c.done + c.partial, c.total, 10, theme) +
					"  " +
					fg(theme, running ? "text" : "muted", label),
			);
		} else {
			lines.push("  " + fg(theme, "muted", trunc(run.goal, width - 2)));

			const bar = progressBar(c.done + c.partial, c.total, full ? 24 : 18, theme);
			const barWidth = (full ? 24 : 18) + 1 + `${c.done + c.partial}/${c.total || 0}`.length;
			const right: Seg[] = [];
			if (run.board.verdict) {
				const v = run.board.verdict.verdict;
				// This is the Supervisor's audit verdict, NOT the deterministic verify gate
				// (that one lives on ticket.evidence.verify). Keeping the words apart is the
				// whole point of the design; the panel must not blur them.
				right.push({ s: "audit ", tone: "muted" }, { s: v, tone: verdictTone(v), bold: true });
				if (full) right.push({ s: ` · ${run.board.reviewCount} reviews`, tone: "dim" });
			}
			const gap = width - 2 - barWidth - segsWidth(right);
			// An empty bar tells nobody anything before the plan exists.
			if (c.total > 0) {
				lines.push("  " + bar + (right.length > 0 && gap >= 2 ? " ".repeat(gap) + paint(theme, right) : ""));
			} else if (right.length > 0) {
				lines.push("  " + paint(theme, right));
			}

			// ── tickets
			const tickets = run.board.tickets ?? [];
			if (tickets.length === 0) {
				if (running) {
					lines.push("  " + fg(theme, "dim", "planning tickets…"));
				} else if (run.board.phase === "plan_failed" || run.status === "error") {
					lines.push("  " + fg(theme, "error", "plan failed — /tasks or plan-attempt-*.txt"));
				}
			} else {
				const max = full ? 12 : 6;
				const ordered = [
					...tickets.filter((t) => t.status === "running"),
					...tickets.filter((t) => t.status === "blocked" || t.status === "failed"),
					...tickets.filter((t) => t.status === "partial"),
					...tickets.filter((t) => t.status === "pending"),
					...tickets.filter((t) => t.status === "done"),
				];
				const seen = new Set<string>();
				const list: typeof tickets = [];
				for (const t of ordered) {
					if (seen.has(t.id)) continue;
					seen.add(t.id);
					list.push(t);
					if (list.length >= max) break;
				}
				// If they all fit, keep plan order so rows do not jump around.
				const show = tickets.length <= max ? tickets : list;
				const widestId = show.reduce((m, t) => Math.max(m, dispWidth(t.id)), 0);
				// Never let the id column eat the goal: a third of the panel is its ceiling.
				const idCol = Math.max(8, Math.min(20, Math.floor(width / 3), widestId));
				if (show.length > 0) lines.push("");
				for (const t of show) {
					const tt = ticketTone(t.status);
					const done = t.status === "done";
					// Split the row budget so goal + reason can never run past the edge.
					const avail = Math.max(12, width - 6 - idCol);
					const rawErr = (t.status === "blocked" || t.status === "failed") && t.error ? t.error : "";
					const errRoom = rawErr ? avail - 20 : 0;
					const err = errRoom >= 12 ? ` — ${trunc(rawErr, Math.min(errRoom - 3, full ? 44 : 32))}` : "";
					const segs: Seg[] = [
						{ s: "  " },
						{ s: ticketIcon(t.status), tone: tt },
						{ s: " " },
						{ s: padCell(t.id, idCol), tone: done ? "dim" : "muted", bold: t.status === "running" },
						{ s: "  " },
						{ s: trunc(t.goal, avail - dispWidth(err)), tone: done ? "dim" : "text" },
						{ s: err, tone: "error" },
					];
					lines.push(paint(theme, segs));
				}
				if (tickets.length > show.length) {
					lines.push("  " + fg(theme, "dim", `+${tickets.length - show.length} more · /tasks`));
				}
			}

			const act = trunc(input.live?.activity || run.activity || "", width - 4);
			if (act && running) {
				lines.push("  " + fg(theme, "dim", "› ") + fg(theme, "muted", act));
			}
			if (run.error && !running && run.status !== "done") {
				lines.push("  " + fg(theme, "error", trunc(run.error, width - 2)));
			}
		}
	}

	// ── hint row
	const busy = input.ml?.status === "running";
	const left: Seg[] = [];
	if (input.ml?.board.phase === "awaiting-approval") {
		left.push(
			{ s: "awaiting approval", tone: "warning", bold: true },
			{ s: " · ", tone: "dim" },
			{ s: "/ml-approve", tone: "accent" },
			{ s: " · ", tone: "dim" },
			{ s: "/ml-stop", tone: "warning" },
		);
	} else if (busy) {
		left.push(
			{ s: "chat OK", tone: "muted" },
			{ s: " · ", tone: "dim" },
			{ s: "/tasks", tone: "accent" },
			{ s: " · ", tone: "dim" },
			{ s: "/ml-stop", tone: "warning" },
		);
	} else {
		left.push(outcomeSeg(input), { s: " · ", tone: "dim" }, { s: "/tasks /ml-runs", tone: "muted" });
	}
	const hintRight: Seg[] = [
		{ s: detail, tone: "muted" },
		{ s: " › ", tone: "dim" },
		{ s: "/ml-ui", tone: "dim" },
	];
	if (!compact) lines.push("");
	lines.push(spread(theme, [{ s: "  " }, ...left], hintRight, width));

	return lines;
}

function statusGlyph(status: string): string {
	switch (status) {
		case "done":
			return "✓";
		case "incomplete":
			return "◐";
		case "error":
			return "✗";
		case "stopped":
			return "■";
		default:
			return "•";
	}
}

function phaseGlyph(phase: string | undefined, fallback: string): string {
	return phase === "awaiting-approval" ? "◆" : fallback;
}

function outcomeSeg(input: PanelInput): Seg {
	if (input.ml?.status === "done") return { s: "finished OK", tone: "success" };
	if (input.ml?.status === "incomplete") return { s: "incomplete — not full success", tone: "warning" };
	if (input.ml?.status === "error") return { s: "failed", tone: "error" };
	if (input.ml?.status === "stopped") return { s: "stopped", tone: "muted" };
	return { s: "idle", tone: "muted" };
}
