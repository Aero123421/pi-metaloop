/**
 * pi-metaLoop extension entry.
 *
 * Primary stays the user's single point of contact. Short tasks are handled
 * normally. For long tasks the primary calls the `orchestrate` tool, which
 * runs plan -> alignment review -> workers -> triggers in isolated pi
 * subprocesses.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { runSupervisedTask } from "./runtime.ts";
import type { TaskBoard, Verdict } from "./types.ts";

const STATUS_KEY = "meta-loop";

function boardLine(board: TaskBoard | null): string {
	if (!board) return "";
	const done = board.tickets.filter((t) => t.status === "done").length;
	const running = board.tickets.filter((t) => t.status === "running").length;
	const total = board.tickets.length;
	const verdict = board.verdict?.verdict ?? "-";
	return `supervised ${board.phase}  ${total} tasks  ●${running} ✓${done}  review:${verdict}`;
}

/**
 * Primary との会話（orchestrate 起動前まで）をダイジェスト化する。
 * Supervisor と Orchestrator が「何を合意したか」を洞察するための材料。
 * Worker には渡さない。
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

export default function (pi: ExtensionAPI) {
	let currentBoard: TaskBoard | null = null;
	let lastVerdicts: Verdict[] = [];

	pi.registerTool({
		name: "orchestrate",
		label: "Supervised Task",
		description: [
			"長期・大規模タスク専用の監督付き実行。",
			"Orchestrator が作業票に分解し、Supervisor が初期監査（green/yellow/red）を行い、",
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
