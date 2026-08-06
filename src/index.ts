/**
 * pi-metaLoop extension entry.
 *
 * Primary stays the user's single point of contact. Short tasks are handled
 * normally. For long tasks the primary calls the `orchestrate` tool, which
 * runs plan -> supervision -> workers -> automatic re-checks in isolated pi
 * subprocesses.
 *
 * Also monitors sfh (SimpleFlowHarness) runs in the current project and
 * surfaces their status in the TUI (footer + widget + /sfh).
 *
 * Nesting guard: when PI_META_LOOP_DEPTH >= 1 (we are inside a spawned role
 * subprocess, or a pi process launched by sfh), this extension registers
 * nothing — no orchestrate, no sfh delegation. Recursion is impossible.
 */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { runSupervisedTask } from "./runtime.ts";
import { activeRuns, formatElapsed, listRuns, type SfhStatus } from "./sfh.ts";
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
	return `supervised ${board.phase}  ${total} tasks  ●${running} ✓${done}  review:${verdict}`;
}

/**
 * Digest of the Primary conversation so far. Input material for the
 * Supervisor and Orchestrator to judge alignment. Not passed to Workers.
 */
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

// ---------- sfh status rendering ----------

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
	if (s.state === "stuck") lines.push(theme.fg("warning", "stuck: 人間の介入待ち（sfh stop / 直接対応）"));
	return lines;
}

// ---------- extension ----------

export default function (pi: ExtensionAPI) {
	// Nesting guard: subprocesses never re-orchestrate.
	const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
	if (depth >= 1) return;

	let currentBoard: TaskBoard | null = null;
	let lastVerdicts: Verdict[] = [];

	// ---------- sfh monitor ----------
	let sfhTimer: ReturnType<typeof setInterval> | undefined;
	const sfhLastStates = new Map<string, string>();

	const stopSfhPoller = () => {
		if (sfhTimer) {
			clearInterval(sfhTimer);
			sfhTimer = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		stopSfhPoller();
		sfhLastStates.clear();
		sfhTimer = setInterval(() => {
			try {
				const theme = ctx.ui.theme;
				const runs = activeRuns(ctx.cwd);
				if (runs.length === 0) {
					if (sfhLastStates.size > 0) {
						sfhLastStates.clear();
						ctx.ui.setStatus(SFH_KEY, "");
						ctx.ui.setWidget(SFH_KEY, []);
					}
					return;
				}
				const run = runs[0];
				const s = run.status;
				if (!s) return;

				const prev = sfhLastStates.get(run.runDir);
				if (prev && prev !== s.state) {
					const severity = s.state === "done" ? "info" : s.state === "stuck" ? "warning" : "error";
					ctx.ui.notify(`sfh:${s.flow} → ${s.state}`, severity);
				}
				if (!prev && s.state === "stuck") {
					ctx.ui.notify(`sfh:${s.flow} が stuck（人間の介入待ち）です`, "warning");
				}
				sfhLastStates.set(run.runDir, s.state);

				ctx.ui.setStatus(SFH_KEY, sfhFooter(s, theme));
				ctx.ui.setWidget(SFH_KEY, sfhWidgetLines(s, theme));
			} catch {
				// Never let the poller crash the session.
			}
		}, SFH_POLL_MS);
	});

	pi.on("session_shutdown", () => {
		stopSfhPoller();
	});

	pi.registerCommand("sfh", {
		description: "sfh の実行状況を表示（/sfh stop で最新 run を停止）",
		handler: async (args, ctx) => {
			if (args.trim() === "stop") {
				try {
					const r = spawnSync("sfh", ["stop"], { cwd: ctx.cwd, timeout: 30_000 });
					const out = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`.trim();
					ctx.ui.notify(out ? out.slice(0, 300) : `sfh stop: exit ${r.status}`, r.status === 0 ? "info" : "error");
				} catch {
					ctx.ui.notify("sfh stop に失敗（sfh はインストールされていますか？）", "error");
				}
				return;
			}

			const runs = listRuns(ctx.cwd, 10);
			if (runs.length === 0) {
				ctx.ui.notify("このプロジェクトに .sfh/runs の記録はありません", "info");
				return;
			}
			const items = runs.map((r) => {
				const s = r.status;
				const core = s ? `${s.state}  ${s.flow}  step:${s.current_step}  $${(s.cost_usd ?? 0).toFixed(2)}  ${formatElapsed(s.elapsed_sec)}` : "(no status.json)";
				return `${r.id}  ${core}`;
			});
			const choice = await ctx.ui.select("sfh run を選択:", items);
			if (!choice) return;
			const picked = runs[items.indexOf(choice)];
			const s = picked?.status;
			if (!s) {
				ctx.ui.notify(`${picked?.id}: status.json が読めません`, "warning");
				return;
			}
			const details = [
				`run: ${picked.id}`,
				`flow: ${s.flow}   state: ${s.state}`,
				`current_step: ${s.current_step}   steps_done: ${s.steps_done}`,
				`cost: $${(s.cost_usd ?? 0).toFixed(2)}   elapsed: ${formatElapsed(s.elapsed_sec)}`,
				s.fanout_total > 0 ? `fanout: ${s.fanout_completed}/${s.fanout_total}` : "",
				Object.keys(s.active_members ?? {}).length > 0 ? `members: ${JSON.stringify(s.active_members)}` : "",
				s.error ? `error: ${s.error}` : "",
				`dir: ${s.run_dir ?? picked.runDir}`,
				"",
				"停止は /sfh stop（最新の run が対象）",
			].filter(Boolean);
			ctx.ui.notify(details.join("\n"), s.state === "stuck" ? "warning" : "info");
		},
	});

	// ---------- orchestrate ----------

	pi.registerTool({
		name: "orchestrate",
		label: "Supervised Task",
		description: [
			"長期・大規模タスク専用の監督付き実行。",
			"Orchestrator が作業票に分解し、Supervisor が初期監査（green/yellow/red）と自動再監査を行い、",
			"Worker が限定スコープで実装する。役ごとにモデルを分けられる。",
			"短いタスク・質問・git確認・議論には使わないこと。自分が直接処理すること。",
			"使用するのは: 複数ファイル/複数関心にまたがる実装、設計判断を伴う改修、",
			"成果物が複数ある作業、ユーザーが明示的に分業を求めた場合。",
		].join("\n"),
		parameters: Type.Object({
			goal: Type.String({ description: "ユーザーの要求。原文をそのまま渡す" }),
			context: Type.Optional(Type.String({ description: "補足コンテキスト（関連ファイル、決定事項）" })),
			constraints: Type.Optional(Type.String({ description: "制約・禁止事項（forbidden）" })),
			max_tasks: Type.Optional(Type.Number({ description: "チケット上限（デフォルトは config）" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			if (!config.enabled) {
				return {
					content: [{ type: "text", text: "pi-metaLoop は無効化されています (config/meta-loop.json の enabled: false)。通常どおり自分で処理してください。" }],
					details: {},
				};
			}
			if (params.max_tasks) config.limits.maxTasks = params.max_tasks;

			ctx.ui.setStatus(STATUS_KEY, "supervised: planning...");
			try {
				const result = await runSupervisedTask(
					{ goal: params.goal, context: params.context, constraints: params.constraints, discussion: collectDiscussion(ctx) },
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
				ctx.ui.setStatus(STATUS_KEY, boardLine(result.board) || "supervised: done");
				return {
					content: [{ type: "text", text: result.summary }],
					details: { board: result.board, verdicts: result.verdicts },
				};
			} catch (err) {
				ctx.ui.setStatus(STATUS_KEY, "supervised: error");
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `orchestrate の実行に失敗しました: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "現在の supervised task ボードを表示",
		handler: async (_args, ctx) => {
			if (!currentBoard) {
				ctx.ui.notify("実行中の supervised task はありません", "info");
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
			if (currentBoard.verdict) {
				lines.push("", `最新 verdict: ${currentBoard.verdict.verdict}`);
				if (currentBoard.verdict.required_actions.length > 0) {
					lines.push(`required: ${currentBoard.verdict.required_actions.join(" / ")}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("verdicts", {
		description: "Supervisor の判定履歴を表示",
		handler: async (_args, ctx) => {
			if (lastVerdicts.length === 0) {
				ctx.ui.notify("まだ判定はありません", "info");
				return;
			}
			const lines = lastVerdicts.map((v, i) => {
				const obs = v.observations.length > 0 ? ` — ${v.observations[0]}` : "";
				return `#${i + 1} ${v.verdict}${obs}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
