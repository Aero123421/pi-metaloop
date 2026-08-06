/**
 * pi-meta-loop extension entry (0.2.0-alpha).
 */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import {
	createEscalationStats,
	escalationMessage,
	noteToolCall,
	promptLooksLong,
	shouldSuggestEscalation,
} from "./escalation.ts";
import { runSupervisedTask } from "./runtime.ts";
import { activeRuns, formatElapsed, listRuns, readStatus, type SfhStatus } from "./sfh.ts";
import type { TaskBoard, Verdict } from "./types.ts";

const STATUS_KEY = "meta-loop";
const SFH_KEY = "sfh";
const SFH_POLL_MS = 2000;

function boardLine(board: TaskBoard | null): string {
	if (!board) return "";
	const done = board.tickets.filter((t) => t.status === "done").length;
	const running = board.tickets.filter((t) => t.status === "running").length;
	const total = board.tickets.length;
	const verdict = board.verdict?.verdict ?? "-";
	return `supervised ${board.phase}  ${total} tasks  ●${running} ✓${done}  verdict:${verdict}`;
}

function collectDiscussion(ctx: ExtensionContext): string {
	try {
		const entries = ctx.sessionManager.getBranch();
		const parts: string[] = [];
		for (const entry of entries.slice(-20)) {
			const msg: any = (entry as any).message;
			if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
			const text = Array.isArray(msg.content)
				? msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join(" ")
				: typeof msg.content === "string"
					? msg.content
					: "";
			const trimmed = text.trim();
			if (trimmed) parts.push(`[${msg.role}] ${trimmed.slice(0, 600)}`);
		}
		return parts.join("\n").slice(-6000);
	} catch {
		return "";
	}
}

function stateColor(state: string): "accent" | "success" | "error" | "warning" | "muted" {
	switch (state) {
		case "running":
			return "accent";
		case "done":
			return "success";
		case "failed":
		case "stopped":
		case "interrupted":
			return "error";
		case "stuck":
			return "warning";
		default:
			return "muted";
	}
}

function stateIcon(state: string): string {
	switch (state) {
		case "running":
			return "●";
		case "done":
			return "✓";
		case "stuck":
			return "▲";
		case "failed":
		case "stopped":
		case "interrupted":
			return "✗";
		default:
			return "○";
	}
}

function sfhFooter(s: SfhStatus, theme: Theme): string {
	const fanout = s.fanout_total > 0 ? `  fanout ${s.fanout_completed}/${s.fanout_total}` : "";
	return (
		theme.fg(stateColor(s.state), stateIcon(s.state)) +
		theme.fg(
			"muted",
			` sfh:${s.flow}  ${s.state}  step:${s.current_step}${fanout}  $${(s.cost_usd ?? 0).toFixed(2)}  ${formatElapsed(s.elapsed_sec)}`,
		)
	);
}

function sfhWidgetLines(s: SfhStatus, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push(
		theme.fg("borderMuted", "── ") +
			theme.fg("accent", `sfh: ${s.flow}`) +
			theme.fg(
				"dim",
				`  ${s.state} · ${s.steps_done} steps · $${(s.cost_usd ?? 0).toFixed(2)} · ${formatElapsed(s.elapsed_sec)}`,
			),
	);
	lines.push(theme.fg(stateColor(s.state), stateIcon(s.state)) + theme.fg("text", ` ${s.current_step}`));
	const members = Object.entries(s.active_members ?? {});
	if (members.length > 0) {
		lines.push(theme.fg("dim", members.slice(0, 6).map(([name, st]) => `${name}:${st}`).join("  ")));
	}
	if (s.error) lines.push(theme.fg("error", s.error.slice(0, 120)));
	if (s.state === "stuck") lines.push(theme.fg("warning", "stuck: human intervention required (/sfh stop)"));
	return lines;
}

export default function (pi: ExtensionAPI) {
	const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
	if (depth >= 1) return;

	let currentBoard: TaskBoard | null = null;
	let lastVerdicts: Verdict[] = [];
	let orchestrateActive = false;
	const escStats = createEscalationStats();

	// ---------- soft escalation ----------
	pi.on("tool_call", async (event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled || orchestrateActive) return;
		noteToolCall(escStats, event.toolName, (event.input ?? {}) as Record<string, unknown>);
		if (!shouldSuggestEscalation(escStats, cfg.escalation)) return;
		escStats.suggested = true;
		const msg = escalationMessage(escStats);
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, "escalation: consider orchestrate");
			ctx.ui.notify(msg, "warning");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled || orchestrateActive || escStats.suggested) return;
		if (!cfg.escalation.enabled) return;
		const longPrompt = promptLooksLong(event.prompt ?? "", cfg.escalation.promptLengthThreshold);
		const byStats = shouldSuggestEscalation(escStats, cfg.escalation);
		if (!longPrompt && !byStats) return;
		escStats.suggested = true;
		const msg = byStats
			? escalationMessage(escStats)
			: [
					"[pi-meta-loop] This request looks like a long task.",
					"If it spans multiple deliverables/modules, consider the `orchestrate` tool.",
					"Skip for simple Q&A or single-file fixes.",
				].join("\n");
		if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		return {
			message: { customType: "meta-loop-escalation", content: msg, display: true },
		};
	});

	// ---------- sfh monitor ----------
	let sfhTimer: ReturnType<typeof setInterval> | undefined;
	const sfhLastStates = new Map<string, string>();
	/** Remember last watched run dirs so we can notify on done/failed after they leave activeRuns */
	const watchedRuns = new Map<string, string>(); // runDir -> lastState

	const stopSfhPoller = () => {
		if (sfhTimer) {
			clearInterval(sfhTimer);
			sfhTimer = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled || !ctx.hasUI) return;
		stopSfhPoller();
		sfhLastStates.clear();
		watchedRuns.clear();
		sfhTimer = setInterval(() => {
			try {
				const theme = ctx.ui.theme;
				// Update watched set from active + previously watched
				const actives = activeRuns(ctx.cwd);
				for (const r of actives) watchedRuns.set(r.runDir, r.status?.state ?? "running");

				// Re-read all watched for terminal transitions
				for (const runDir of [...watchedRuns.keys()]) {
					const s = readStatus(runDir);
					if (!s) continue;
					const prev = sfhLastStates.get(runDir);
					if (prev && prev !== s.state) {
						const severity = s.state === "done" ? "info" : s.state === "stuck" ? "warning" : "error";
						ctx.ui.notify(`sfh:${s.flow} → ${s.state}`, severity);
					}
					if (!prev && s.state === "stuck") {
						ctx.ui.notify(`sfh:${s.flow} is stuck (human intervention)`, "warning");
					}
					sfhLastStates.set(runDir, s.state);
					if (s.state !== "running" && s.state !== "stuck") {
						// terminal — drop after notify
						watchedRuns.delete(runDir);
					}
				}

				const running = actives[0]?.status;
				if (!running) {
					ctx.ui.setStatus(SFH_KEY, "");
					ctx.ui.setWidget(SFH_KEY, []);
					return;
				}
				ctx.ui.setStatus(SFH_KEY, sfhFooter(running, theme));
				ctx.ui.setWidget(SFH_KEY, sfhWidgetLines(running, theme));
			} catch (err) {
				console.error("[pi-meta-loop] sfh poller error", err);
			}
		}, SFH_POLL_MS);
	});

	pi.on("session_shutdown", () => {
		stopSfhPoller();
	});

	pi.registerCommand("sfh", {
		description: "Show sfh run status (/sfh stop stops newest run)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (!cfg.enabled) {
				ctx.ui.notify("pi-meta-loop is disabled", "info");
				return;
			}
			if (args.trim() === "stop") {
				try {
					const bin = cfg.executor.sfhBinary || "sfh";
					const r = spawnSync(bin, ["stop"], { cwd: ctx.cwd, timeout: 30_000 });
					const out = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`.trim();
					ctx.ui.notify(out ? out.slice(0, 300) : `sfh stop: exit ${r.status}`, r.status === 0 ? "info" : "error");
				} catch {
					ctx.ui.notify("sfh stop failed (is sfh installed?)", "error");
				}
				return;
			}
			const runs = listRuns(ctx.cwd, 10);
			if (runs.length === 0) {
				ctx.ui.notify("No .sfh/runs records in this project", "info");
				return;
			}
			const items = runs.map((r) => {
				const s = r.status;
				const core = s
					? `${s.state}  ${s.flow}  step:${s.current_step}  $${(s.cost_usd ?? 0).toFixed(2)}  ${formatElapsed(s.elapsed_sec)}`
					: "(no status.json)";
				return `${r.id}  ${core}`;
			});
			const choice = await ctx.ui.select("Select sfh run:", items);
			if (!choice) return;
			const picked = runs[items.indexOf(choice)];
			const s = picked?.status;
			if (!s) {
				ctx.ui.notify(`${picked?.id}: cannot read status.json`, "warning");
				return;
			}
			ctx.ui.notify(
				[
					`run: ${picked.id}`,
					`flow: ${s.flow}   state: ${s.state}`,
					`step: ${s.current_step}   steps_done: ${s.steps_done}`,
					`cost: $${(s.cost_usd ?? 0).toFixed(2)}   elapsed: ${formatElapsed(s.elapsed_sec)}`,
					s.error ? `error: ${s.error}` : "",
					`dir: ${s.run_dir ?? picked.runDir}`,
					"",
					"Stop newest: /sfh stop",
				]
					.filter(Boolean)
					.join("\n"),
				s.state === "stuck" ? "warning" : "info",
			);
		},
	});

	pi.registerTool({
		name: "orchestrate",
		label: "Supervised Task",
		description: [
			"Long-running / multi-deliverable tasks only.",
			"Orchestrator decomposes into tickets; Supervisor audits (fail-closed); Workers or sfh groups execute.",
			"Do NOT use for short Q&A, git status, or single-file fixes.",
		].join("\n"),
		parameters: Type.Object({
			goal: Type.String({ description: "User request, verbatim" }),
			context: Type.Optional(Type.String({ description: "Extra context" })),
			constraints: Type.Optional(Type.String({ description: "Constraints / forbidden" })),
			max_tasks: Type.Optional(Type.Number({ description: "Ticket cap" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			if (!config.enabled) {
				return {
					content: [{ type: "text", text: "pi-meta-loop is disabled (enabled: false). Handle the task yourself." }],
					details: {},
				};
			}
			if (params.max_tasks) config.limits.maxTasks = params.max_tasks;
			ctx.ui.setStatus(STATUS_KEY, "supervised: planning...");
			orchestrateActive = true;
			try {
				const result = await runSupervisedTask(
					{
						goal: params.goal,
						context: params.context,
						constraints: params.constraints,
						discussion: collectDiscussion(ctx),
					},
					ctx.cwd,
					config,
					{
						signal,
						onPhase: (board, label) => {
							currentBoard = board;
							ctx.ui.setStatus(STATUS_KEY, `${label} | ${boardLine(board)}`);
						},
					},
				);
				currentBoard = result.board;
				lastVerdicts = result.verdicts;
				escStats.suggested = true;
				ctx.ui.setStatus(STATUS_KEY, boardLine(result.board) || "supervised: done");
				return {
					content: [{ type: "text", text: result.summary }],
					details: { board: result.board, verdicts: result.verdicts },
				};
			} catch (err) {
				ctx.ui.setStatus(STATUS_KEY, "supervised: error");
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `orchestrate failed: ${message}` }],
					details: { error: message },
					isError: true,
				};
			} finally {
				orchestrateActive = false;
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Show supervised task board",
		handler: async (_args, ctx) => {
			if (!loadConfig(ctx.cwd).enabled) {
				ctx.ui.notify("pi-meta-loop is disabled", "info");
				return;
			}
			if (!currentBoard) {
				ctx.ui.notify("No active supervised task", "info");
				return;
			}
			const lines = [
				`Goal: ${currentBoard.goal}`,
				`Phase: ${currentBoard.phase}  Reviews: ${currentBoard.reviewCount}`,
				"",
				...currentBoard.tickets.map(
					(t) => `[${t.status}] ${t.id} — ${t.goal}${t.error ? `  (${t.error.slice(0, 80)})` : ""}`,
				),
			];
			if (currentBoard.verdict) lines.push("", `verdict: ${currentBoard.verdict.verdict}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("verdicts", {
		description: "Show Supervisor verdict history",
		handler: async (_args, ctx) => {
			if (!loadConfig(ctx.cwd).enabled) {
				ctx.ui.notify("pi-meta-loop is disabled", "info");
				return;
			}
			if (lastVerdicts.length === 0) {
				ctx.ui.notify("No verdicts yet", "info");
				return;
			}
			ctx.ui.notify(
				lastVerdicts.map((v, i) => `#${i + 1} ${v.verdict}${v.observations[0] ? ` — ${v.observations[0]}` : ""}`).join("\n"),
				"info",
			);
		},
	});
}
