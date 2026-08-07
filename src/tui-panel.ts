/**
 * Colored / structured TUI panel for meta-loop + sfh (0.2.3).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { runElapsed, ticketCounts, type PersistedRun } from "./board-store.ts";
import { formatElapsed as sfhElapsed, type SfhStatus } from "./sfh.ts";

export type PanelDetail = "compact" | "normal" | "full";

export const PANEL_DETAIL_ORDER: PanelDetail[] = ["compact", "normal", "full"];

export function nextDetail(cur: PanelDetail): PanelDetail {
	const i = PANEL_DETAIL_ORDER.indexOf(cur);
	return PANEL_DETAIL_ORDER[(i + 1) % PANEL_DETAIL_ORDER.length]!;
}

type Tone = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text" | "borderMuted" | "borderAccent";

function fg(theme: Theme, tone: Tone, s: string): string {
	return theme.fg(tone as any, s);
}

function bg(theme: Theme, key: string, s: string): string {
	try {
		return (theme as any).bg?.(key, s) ?? s;
	} catch {
		return s;
	}
}

function pad(s: string, n: number): string {
	if (s.length >= n) return s.slice(0, n);
	return s + " ".repeat(n - s.length);
}

function trunc(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	if (t.length <= n) return t;
	return t.slice(0, Math.max(0, n - 1)) + "…";
}

/** Unicode block progress bar */
export function progressBar(done: number, total: number, width = 16, theme?: Theme): string {
	const t = Math.max(0, total);
	const d = Math.max(0, Math.min(done, t || done));
	const ratio = t === 0 ? 0 : d / t;
	const filled = Math.round(ratio * width);
	const empty = Math.max(0, width - filled);
	const bar = "█".repeat(filled) + "░".repeat(empty);
	const label = t === 0 ? "—/—" : `${d}/${t}`;
	if (!theme) return `[${bar}] ${label}`;
	return (
		fg(theme, "dim", "[") +
		fg(theme, d === t && t > 0 ? "success" : "accent", "█".repeat(filled)) +
		fg(theme, "muted", "░".repeat(empty)) +
		fg(theme, "dim", "] ") +
		fg(theme, t > 0 && d === t ? "success" : "text", label)
	);
}

function mlTone(status: string, phase: string): Tone {
	if (status === "running" || phase === "executing" || phase === "planning") return "accent";
	if (status === "done" || phase === "done") return "success";
	if (status === "incomplete" || phase === "incomplete") return "warning";
	if (status === "stopped" || phase === "stopped") return "muted";
	if (status === "error" || phase === "plan_failed" || phase === "degraded") return "error";
	return "muted";
}

function sfhTone(state: string): Tone {
	switch (state) {
		case "running":
			return "accent";
		case "done":
			return "success";
		case "stuck":
			return "warning";
		case "failed":
		case "stopped":
		case "interrupted":
			return "error";
		default:
			return "muted";
	}
}

function badge(theme: Theme, tone: Tone, label: string): string {
	const inner = ` ${label} `;
	// Prefer bg chips when theme supports them
	if (tone === "success") return bg(theme, "toolSuccessBg", fg(theme, "success", inner));
	if (tone === "error") return bg(theme, "toolErrorBg", fg(theme, "error", inner));
	if (tone === "accent") return bg(theme, "toolPendingBg", fg(theme, "accent", inner));
	if (tone === "warning") return fg(theme, "warning", `[${label}]`);
	return fg(theme, tone, `[${label}]`);
}

function ticketIcon(status: string): string {
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
	sfh?: SfhStatus | null;
	/** Hide finished ML panel after this many ms (default 120s) */
	hideFinishedAfterMs?: number;
}

function sfhIsLive(s: SfhStatus | null | undefined): boolean {
	return Boolean(s && (s.state === "running" || s.state === "stuck"));
}

/** Whether the below-editor widget should be visible. */
export function shouldShowPanel(input: PanelInput): boolean {
	if (input.forceShow) return Boolean(input.ml || input.sfh);
	// Live sfh alone is enough; terminal sfh alone is not (avoids ghost FAILED).
	if (sfhIsLive(input.sfh)) return true;
	if (!input.ml) return false;
	if (input.ml.status === "running") return true;
	// recent terminal ML outcome (sfh terminal only tags along if ML also showing)
	const hideAfter = input.hideFinishedAfterMs ?? 90_000;
	const end = Date.parse(input.ml.finishedAt || input.ml.updatedAt || "");
	if (!Number.isFinite(end)) return input.ml.status !== "done" && input.ml.status !== "stopped";
	return Date.now() - end < hideAfter;
}

export function buildFooterLine(input: PanelInput): string {
	const { theme } = input;
	const parts: string[] = [];

	if (input.ml && (input.ml.status === "running" || shouldShowPanel(input))) {
		const c = ticketCounts(input.ml.board);
		const tone = mlTone(input.ml.status, input.ml.board.phase);
		const spin = input.ml.status === "running" ? spinnerFrame(input.tick) + " " : "";
		const v = input.ml.board.verdict?.verdict;
		parts.push(
			fg(theme, tone, `${spin}ML`) +
				fg(theme, "dim", " ") +
				fg(theme, tone, input.ml.status) +
				fg(theme, "dim", "/") +
				fg(theme, tone, input.ml.board.phase) +
				fg(theme, "dim", " ") +
				fg(theme, "text", `${c.done + c.partial}/${c.total || 0}`) +
				fg(theme, "success", ` ✓${c.done}`) +
				fg(theme, "accent", ` ●${c.running}`) +
				fg(theme, "error", ` ■${c.blocked}`) +
				fg(theme, "error", ` ✗${c.failed}`) +
				(v ? fg(theme, v === "green" ? "success" : v === "yellow" ? "warning" : "error", ` v:${v}`) : "") +
				fg(theme, "dim", ` ${runElapsed(input.ml)}`),
		);
	}

	// Caller should pass only live or freshly-finished sfh (see pickSfhForPanel).
	if (input.sfh) {
		const t = sfhTone(input.sfh.state);
		const spin = sfhIsLive(input.sfh) ? spinnerFrame(input.tick + 3) + " " : "";
		const fan =
			input.sfh.fanout_total > 0
				? fg(theme, "dim", ` ${input.sfh.fanout_completed}/${input.sfh.fanout_total}`)
				: "";
		parts.push(
			fg(theme, t, `${spin}SFH`) +
				fg(theme, "dim", " ") +
				fg(theme, t, input.sfh.state) +
				fg(theme, "text", ` ${trunc(input.sfh.current_step || input.sfh.flow, 28)}`) +
				fan +
				fg(theme, "dim", ` $${(input.sfh.cost_usd ?? 0).toFixed(2)} ${sfhElapsed(input.sfh.elapsed_sec)}`),
		);
	}

	return parts.join(fg(theme, "borderMuted", " │ "));
}

export function buildPanelLines(input: PanelInput): string[] {
	if (!shouldShowPanel(input)) return [];

	const { theme, detail } = input;
	const lines: string[] = [];
	const rule = fg(theme, "borderMuted", "─".repeat(42));

	// ── header
	const hdrBits: string[] = [];
	hdrBits.push(fg(theme, "borderAccent", "╭─"));
	hdrBits.push(fg(theme, "accent", " meta-loop "));
	if (input.sfh) hdrBits.push(fg(theme, "dim", "+") + fg(theme, "warning", " sfh "));
	hdrBits.push(fg(theme, "dim", `· ${detail} · /ml-ui`));
	lines.push(hdrBits.join(""));
	lines.push(rule);

	// ── meta-loop block
	if (input.ml) {
		const run = input.ml;
		const c = ticketCounts(run.board);
		const tone = mlTone(run.status, run.board.phase);
		const spin = run.status === "running" ? spinnerFrame(input.tick) : statusGlyph(run.status);
		const title =
			badge(theme, tone, run.status.toUpperCase()) +
			fg(theme, "dim", " ") +
			fg(theme, tone, run.board.phase) +
			fg(theme, "dim", "  ") +
			fg(theme, "text", runElapsed(run));

		lines.push(fg(theme, tone, `${spin} Supervised`) + fg(theme, "dim", "  ") + title);

		if (detail !== "compact") {
			lines.push(fg(theme, "muted", "  goal ") + fg(theme, "text", trunc(run.goal, detail === "full" ? 100 : 72)));
			const nowLabel = trunc(input.live?.label || run.label || "", 90);
			if (nowLabel) {
				lines.push(
					fg(theme, "muted", "  now  ") +
						(run.status === "running" ? fg(theme, "accent", nowLabel) : fg(theme, "text", nowLabel)),
				);
			}
			lines.push(
				fg(theme, "muted", "  prog ") +
					progressBar(c.done + c.partial, c.total, detail === "full" ? 20 : 14, theme) +
					fg(theme, "dim", "  ") +
					fg(theme, "success", `✓${c.done}`) +
					fg(theme, "warning", ` ◐${c.partial}`) +
					fg(theme, "accent", ` ●${c.running}`) +
					fg(theme, "dim", ` ○${c.pending}`) +
					fg(theme, "error", ` ■${c.blocked}`) +
					fg(theme, "error", ` ✗${c.failed}`),
			);

			if (run.board.verdict) {
				const v = run.board.verdict.verdict;
				const vt = v === "green" ? "success" : v === "yellow" ? "warning" : "error";
				lines.push(
					fg(theme, "muted", "  verd ") +
						badge(theme, vt as Tone, v.toUpperCase()) +
						fg(theme, "dim", `  reviews ${run.board.reviewCount}`),
				);
			}

			// tickets
			const tickets = run.board.tickets ?? [];
			if (tickets.length === 0) {
				if (run.status === "running") {
					lines.push(fg(theme, "dim", "  · planning tickets…"));
				} else if (run.board.phase === "plan_failed" || run.status === "error") {
					lines.push(fg(theme, "error", "  · plan failed — see /tasks or plan-attempt-*.txt"));
				}
			} else {
				const max = detail === "full" ? 12 : detail === "normal" ? 6 : 0;
				if (max > 0) {
					const ordered = [
						...tickets.filter((t) => t.status === "running"),
						...tickets.filter((t) => t.status === "blocked" || t.status === "failed"),
						...tickets.filter((t) => t.status === "partial"),
						...tickets.filter((t) => t.status === "pending"),
						...tickets.filter((t) => t.status === "done"),
					];
					// unique preserve order
					const seen = new Set<string>();
					const list: typeof tickets = [];
					for (const t of ordered) {
						if (seen.has(t.id)) continue;
						seen.add(t.id);
						list.push(t);
						if (list.length >= max) break;
					}
					// If few tickets, show all in id order for stability when not running
					const show = tickets.length <= max ? tickets : list;
					for (const t of show) {
						const tt = ticketTone(t.status);
						const err =
							t.error && (t.status === "blocked" || t.status === "failed")
								? fg(theme, "error", `  ${trunc(t.error, detail === "full" ? 50 : 36)}`)
								: "";
						lines.push(
							fg(theme, tt, `  ${ticketIcon(t.status)} ${pad(t.id, 12)}`) +
								fg(theme, "dim", " ") +
								fg(theme, "text", trunc(t.goal, detail === "full" ? 56 : 40)) +
								err,
						);
					}
					if (tickets.length > show.length) {
						lines.push(fg(theme, "dim", `  … +${tickets.length - show.length} more  (/tasks)`));
					}
				}
			}

			const act = trunc(input.live?.activity || run.activity || "", 88);
			if (act && run.status === "running") {
				lines.push(fg(theme, "dim", "  live ") + fg(theme, "muted", act));
			}
			if (run.error && run.status !== "running" && run.status !== "done") {
				lines.push(fg(theme, "error", "  err  ") + fg(theme, "error", trunc(run.error, 88)));
			}
		} else {
			// compact one-liner under badge
			const c2 = ticketCounts(run.board);
			lines.push(
				fg(theme, "dim", "  ") +
					progressBar(c2.done + c2.partial, c2.total, 10, theme) +
					fg(theme, "dim", "  ") +
					fg(theme, "text", trunc(input.live?.label || run.label || run.goal, 48)),
			);
		}
	}

	// ── sfh block (omit stale terminal while ML is mid-flight without live sfh)
	const showSfh =
		input.sfh &&
		(sfhIsLive(input.sfh) || input.ml?.status !== "running" || input.forceShow);
	if (showSfh && input.sfh) {
		if (input.ml) lines.push(fg(theme, "borderMuted", "┄".repeat(42)));
		const s = input.sfh;
		const t = sfhTone(s.state);
		const spin = s.state === "running" || s.state === "stuck" ? spinnerFrame(input.tick + 3) : stateGlyph(s.state);
		lines.push(
			fg(theme, t, `${spin} sfh`) +
				fg(theme, "dim", "  ") +
				badge(theme, t, s.state.toUpperCase()) +
				fg(theme, "dim", "  ") +
				fg(theme, "text", trunc(s.flow || "flow", 28)) +
				fg(theme, "dim", `  ${sfhElapsed(s.elapsed_sec)}`),
		);

		if (detail !== "compact") {
			lines.push(
				fg(theme, "muted", "  step ") +
					fg(theme, t, trunc(s.current_step || "—", 60)) +
					fg(theme, "dim", `  done ${s.steps_done}`),
			);
			if (s.fanout_total > 0) {
				lines.push(
					fg(theme, "muted", "  fan  ") +
						progressBar(s.fanout_completed, s.fanout_total, 12, theme) +
						fg(theme, "dim", `  $${(s.cost_usd ?? 0).toFixed(2)}`),
				);
			} else {
				lines.push(fg(theme, "muted", "  cost ") + fg(theme, "text", `$${(s.cost_usd ?? 0).toFixed(2)}`));
			}
			const members = Object.entries(s.active_members ?? {});
			if (members.length > 0) {
				const maxM = detail === "full" ? 8 : 4;
				const chunk = members.slice(0, maxM).map(([name, st]) => {
					const mt = sfhTone(String(st));
					return fg(theme, mt, `${name}:${st}`);
				});
				lines.push(fg(theme, "muted", "  mem  ") + chunk.join(fg(theme, "dim", "  ")));
				if (members.length > maxM) {
					lines.push(fg(theme, "dim", `  … +${members.length - maxM} members`));
				}
			}
			if (s.error) lines.push(fg(theme, "error", "  err  ") + fg(theme, "error", trunc(String(s.error), 80)));
			if (s.state === "stuck") {
				lines.push(fg(theme, "warning", "  ⚠ stuck — /sfh stop  or inspect .sfh/runs/"));
			}
		}
	}

	// ── footer help
	lines.push(rule);
	if (input.ml?.status === "running" || input.sfh?.state === "running" || input.sfh?.state === "stuck") {
		lines.push(
			fg(theme, "muted", "  chat OK") +
				fg(theme, "dim", " · ") +
				fg(theme, "accent", "/tasks") +
				fg(theme, "dim", " · ") +
				fg(theme, "warning", "/ml-stop") +
				fg(theme, "dim", " · ") +
				fg(theme, "accent", "/sfh") +
				fg(theme, "dim", " · ") +
				fg(theme, "dim", "/ml-ui"),
		);
	} else {
		lines.push(
			fg(theme, "dim", "  ") +
				outcomeHint(theme, input) +
				fg(theme, "dim", " · ") +
				fg(theme, "muted", "/tasks /ml-runs /ml-ui · auto-hide soon"),
		);
	}
	lines.push(fg(theme, "borderAccent", "╰─"));

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

function stateGlyph(state: string): string {
	switch (state) {
		case "done":
			return "✓";
		case "stuck":
			return "▲";
		case "failed":
		case "stopped":
		case "interrupted":
			return "✗";
		default:
			return "•";
	}
}

function outcomeHint(theme: Theme, input: PanelInput): string {
	if (input.ml?.status === "done") return fg(theme, "success", "finished OK");
	if (input.ml?.status === "incomplete") return fg(theme, "warning", "INCOMPLETE — not full success");
	if (input.ml?.status === "error") return fg(theme, "error", "failed");
	if (input.ml?.status === "stopped") return fg(theme, "muted", "stopped");
	if (input.sfh?.state === "done") return fg(theme, "success", "sfh done");
	if (input.sfh?.state === "failed") return fg(theme, "error", "sfh failed");
	return fg(theme, "muted", "idle");
}
