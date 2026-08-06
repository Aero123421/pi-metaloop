/**
 * Supervised runtime.
 *
 * Flow: plan (Orchestrator step 1) -> initial supervision -> execute tickets.
 * The Supervisor runs automatically (hook-style): periodic interval, worker
 * start threshold, consecutive failures, blocked tickets. Its interventions
 * are prompt injections into the Orchestrator only — never directly into
 * Workers. Red verdicts stop execution.
 *
 * The discussion with Primary (intent, decisions, constraints) is passed to
 * the Orchestrator and the Supervisor so they can judge alignment. Workers
 * stay lightweight: goal + ticket only.
 */
import type { MetaLoopConfig } from "./config.ts";
import { loadStandards, resolveSfhBranchAccess, resolveSfhBranchEffort, resolveSfhBranchModel, resolveSfhIntegrateAccess, resolveSfhIntegrateEffort, resolveSfhIntegrateModel, assertSfhToolAllowed } from "./config.ts";
import { detectSfh, generateFlowYaml, renderBranchPrompt, renderIntegrationPrompt, runSfhFlow, sanitizeId, writeFlowFile, type FlowSpec } from "./sfh-exec.ts";
import { extractJson, loadRole, runRole } from "./spawn.ts";
import { checkAutoTriggers, evaluateTriggers, type RuntimeEvent, type SupervisorStats } from "./triggers.ts";
import type { OrchestrateInput, TaskBoard, Ticket, Verdict } from "./types.ts";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeHooks {
	onPhase?: (board: TaskBoard, label: string) => void;
	signal?: AbortSignal;
}

export interface RuntimeResult {
	board: TaskBoard;
	summary: string;
	verdicts: Verdict[];
}

function notify(hooks: RuntimeHooks, board: TaskBoard, label: string) {
	board.phase = (label.split(":")[0] as TaskBoard["phase"]) ?? board.phase;
	hooks.onPhase?.(board, label);
}

function userRequest(input: OrchestrateInput): string {
	const parts = [`## ユーザーの要求（原文）\n${input.goal}`];
	if (input.discussion) parts.push(`## Primary との議論（ここまでの会話で合意した文脈）\n${input.discussion}`);
	if (input.context) parts.push(`## 補足コンテキスト\n${input.context}`);
	if (input.constraints) parts.push(`## 制約（forbidden に反映すべき事項）\n${input.constraints}`);
	return parts.join("\n\n");
}

function toTicket(t: any, i: number, previous?: Ticket): Ticket {
	return {
		id: t.id ?? previous?.id ?? `task-${i + 1}`,
		goal: t.goal ?? "",
		deliverables: t.deliverables ?? [],
		acceptance: t.acceptance ?? [],
		allowed_scope: t.allowed_scope ?? [],
		forbidden: t.forbidden ?? [],
		dependencies: t.dependencies ?? [],
		context: t.context,
		execution: t.execution === "sfh" ? "sfh" : "native",
		branches:
			Array.isArray(t.branches) && t.branches.length > 0
				? t.branches.map((b: any, j: number) => ({
						id: String(b.id ?? `branch-${j + 1}`),
						tool: typeof b.tool === "string" ? b.tool : undefined,
						model: typeof b.model === "string" ? b.model : undefined,
						effort: typeof b.effort === "string" ? b.effort : undefined,
						access: typeof b.access === "string" ? b.access : undefined,
						prompt: String(b.prompt ?? ""),
					}))
				: undefined,
		integration:
			t.integration && Array.isArray(t.integration.acceptance)
				? { acceptance: t.integration.acceptance.map(String), output: t.integration.output }
				: undefined,
		status: previous && previous.status !== "pending" && previous.status !== "running" ? previous.status : "pending",
		report: previous?.report,
		error: previous?.error,
	};
}

function formatBoard(board: TaskBoard): string {
	const lines = [
		`goal: ${board.goal}`,
		`phase: ${board.phase}`,
		"",
		"tickets:",
		...board.tickets.map(
			(t) =>
				`  - [${t.status}] ${t.id}: ${t.goal}${t.report ? `\n      report: ${t.report.slice(0, 300)}` : ""}${t.error ? `\n      error: ${t.error.slice(0, 300)}` : ""}`,
		),
	];
	return lines.join("\n");
}

function pickNext(board: TaskBoard): Ticket | null {
	for (const t of board.tickets) {
		if (t.status !== "pending") continue;
		const deps = board.tickets.filter((d) => t.dependencies.includes(d.id));
		if (deps.some((d) => d.status === "failed" || d.status === "blocked")) {
			t.status = "blocked";
			t.error = `依存チケット ${deps.filter((d) => d.status === "failed" || d.status === "blocked").map((d) => d.id).join(", ")} が完了していない`;
			continue;
		}
		if (deps.every((d) => d.status === "done" || d.status === "partial")) return t;
	}
	return null;
}

/** Validate ticket shape before execution. Returns error message or null. */
export function validateTicket(ticket: Ticket): string | null {
	if (ticket.execution === "sfh") {
		if (!ticket.branches || ticket.branches.length === 0) {
			return 'execution: "sfh" ですが branches が空です。並列ブランチを定義するか execution を native にしてください';
		}
		if (!ticket.integration?.acceptance || ticket.integration.acceptance.length === 0) {
			return 'execution: "sfh" には integration.acceptance（統合約）が必須です';
		}
		for (const b of ticket.branches) {
			if (!String(b.id || "").trim()) return "branch.id が空です";
			if (!String(b.prompt || "").trim()) return `branch "${b.id}" の prompt が空です`;
		}
	}
	return null;
}

function scopeGuardPath(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "scope-guard.ts");
}

export async function runSupervisedTask(
	input: OrchestrateInput,
	cwd: string,
	config: MetaLoopConfig,
	hooks: RuntimeHooks,
): Promise<RuntimeResult> {
	const board: TaskBoard = {
		goal: input.goal,
		planSummary: "",
		openQuestions: [],
		tickets: [],
		phase: "planning",
		reviewCount: 0,
	};
	const verdicts: Verdict[] = [];
	const guidanceLog: string[] = [];

	const orchestrator = loadRole("orchestrator", config.roles.orchestrator);
	const supervisor = loadRole("supervisor", config.roles.supervisor);
	const worker = loadRole("worker", config.roles.worker);

	const stats: SupervisorStats = {
		workerStarts: 0,
		startsSinceReview: 0,
		lastReviewAt: Date.now(),
		consecutiveFailures: 0,
	};

	const cap = config.limits.perTaskOutputCap;

	// 点検基準（役割と分離）: Supervisor は判定根拠、Orchestrator はチケット設計に使う。
	const standardsRaw = loadStandards(cwd);
	const orchestratorStandards = standardsRaw
		? `\n\n## 実装基準（チケットの acceptance / forbidden / context に反映すべき事項）\n${standardsRaw}`
		: "";
	const supervisorStandards = standardsRaw ? `\n\n## 点検基準（判定根拠）\n${standardsRaw}` : "";

	// ---------- Orchestrator steps (plan / revise) ----------

	async function orchestratorPlan(): Promise<boolean> {
		const prompt = [
			"以下のユーザー要求を実行可能な作業票に分解してください。",
			`上限は ${config.limits.maxTasks} チケット。`,
			"",
			userRequest(input),
			orchestratorStandards,
		].join("\n");
		const run = await runRole(orchestrator, prompt, { cwd, signal: hooks.signal, outputCap: cap });
		const plan = extractJson<{ summary?: string; open_questions?: string[]; tasks?: any[] }>(run.output);
		if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
			board.planSummary = `[plan failed] ${run.output.slice(0, 500)}`;
			return false;
		}
		board.planSummary = plan.summary ?? "";
		board.openQuestions = plan.open_questions ?? [];
		board.tickets = plan.tasks.slice(0, config.limits.maxTasks).map((t, i) => toTicket(t, i));
		return true;
	}

	async function orchestratorRevise(guidance: string[], reason: string): Promise<void> {
		const prompt = [
			`Supervisor が作業中に以下のガイダンスを挿入しました（理由: ${reason}）。`,
			"これを踏まえて、未完了部分の計画を修正してください。",
			"完了済み(done/partial)・失敗(failed/blocked)のチケットはそのまま残し、pending のものだけ修正・再構成して構いません。",
			"修正後のチケット全リスト JSON のみを再出力してください。",
			"",
			"## 挿入されたガイダンス",
			guidance.map((g) => `- ${g}`).join("\n"),
			"",
			"## 現在のボード",
			formatBoard(board),
			"",
			userRequest(input),
			orchestratorStandards,
		].join("\n");
		const run = await runRole(orchestrator, prompt, { cwd, signal: hooks.signal, outputCap: cap });
		const revised = extractJson<any>(run.output);
		const tasks = Array.isArray(revised) ? revised : revised?.tasks;
		if (!Array.isArray(tasks) || tasks.length === 0) return;
		const byId = new Map(board.tickets.map((t) => [t.id, t]));
		board.tickets = tasks.slice(0, config.limits.maxTasks * 2).map((t: any, i: number) => {
			const prev = t.id ? byId.get(t.id) : undefined;
			return toTicket(t, i, prev);
		});
		if (revised && !Array.isArray(revised) && revised.summary) board.planSummary = revised.summary;
	}

	// ---------- Supervision ----------

	async function runSupervision(stage: "initial" | "mid", reason: string): Promise<Verdict | null> {
		notify(hooks, board, stage === "initial" ? "initial-review: Supervisor が初回監査中" : `final-review: Supervisor 自動監査（${reason}）`);
		const header =
			stage === "initial"
				? "これは初回監査です。まだ実装は始まっていません。要求→分解→委任への変換が正しいかを見てください。"
				: `これは実行中に自動起動された監査です。起動理由: ${reason}。マクロ（意図整合）〜ミクロ（個別チケット）まで俯瞰してください。`;
		const task = [
			header,
			"",
			userRequest(input),
			"",
			"## 現在のボード",
			formatBoard(board),
			"",
			"## 実行統計",
			`worker 起動数: ${stats.workerStarts} / 前回監査以降: ${stats.startsSinceReview} / 連続失敗: ${stats.consecutiveFailures}`,
			...(guidanceLog.length > 0 ? ["", "## これまでに注入したガイダンス履歴", ...guidanceLog.map((g) => `- ${g}`)] : []),
			supervisorStandards,
		].join("\n");
		const run = await runRole(supervisor, task, { cwd, signal: hooks.signal, outputCap: cap });
		stats.lastReviewAt = Date.now();
		stats.startsSinceReview = 0;
		return extractJson<Verdict>(run.output);
	}

	/** Apply a verdict. Returns "stopped" on red. Yellow injects guidance into the Orchestrator. */
	async function applyVerdict(verdict: Verdict, reason: string): Promise<"stopped" | "continue"> {
		board.reviewCount++;
		board.verdict = verdict;
		verdicts.push(verdict);

		if (verdict.verdict === "red") {
			for (const t of board.tickets) if (t.status === "pending") t.status = "blocked";
			board.phase = "stopped";
			notify(hooks, board, "stopped: Supervisor が Red 判定");
			return "stopped";
		}

		const guidance = [...(verdict.required_actions ?? []), ...(verdict.orchestrator_guidance ?? [])].filter(Boolean);
		if (verdict.verdict === "yellow" && guidance.length > 0) {
			guidanceLog.push(...guidance);
			notify(hooks, board, "revision: guidance を Orchestrator に注入中");
			await orchestratorRevise(guidance, reason);
		}
		return "continue";
	}

	async function superviseIfTriggered(reason: string): Promise<"stopped" | "continue"> {
		const verdict = await runSupervision("mid", reason);
		if (!verdict) return "continue";
		return applyVerdict(verdict, reason);
	}

	// ---------- Group tickets (sfh delegation or native fallback) ----------

	async function executeGroupTicket(ticket: Ticket): Promise<void> {
		const ex = config.executor;
		const branches = ticket.branches ?? [];
		const binary = ex.sfhEnabled ? detectSfh(ex.sfhBinary) : null;

		if (!ex.sfhEnabled) {
			ticket.status = "blocked";
			ticket.error = "executor.sfhEnabled=false です。グループチケットは実行できません";
			return;
		}
		if (!binary) {
			ticket.status = "blocked";
			ticket.error = [
				"sfh（SimpleFlowHarness）がインストールされていません。必須依存です。",
				"Windows PowerShell: irm https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.ps1 | iex",
				"macOS/Linux: curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.sh | sh",
			].join("\n");
			return;
		}

		{
			const flowName = `meta-loop-${sanitizeId(ticket.id)}`;
			// tool allow-list
			for (const b of branches) {
				const err = assertSfhToolAllowed(b.tool, config);
				if (err) {
					ticket.status = "blocked";
					ticket.error = err;
					return;
				}
			}
			const integrateModel = resolveSfhIntegrateModel(config);
			const defaultModel = config.executor.sfhModel?.trim() || undefined;
			const defaultEffort = config.executor.sfhEffort?.trim() || undefined;
			const defaultAccess = config.executor.sfhAccess?.trim() || "read";
			const spec: FlowSpec = {
				name: flowName,
				branches: branches.map((b) => ({
					id: sanitizeId(b.id),
					tool: b.tool,
					model: resolveSfhBranchModel(b, config),
					effort: resolveSfhBranchEffort(b, config),
					access: resolveSfhBranchAccess(b, config),
					prompt: renderBranchPrompt(b, ticket, input.goal),
				})),
				integrationPrompt: renderIntegrationPrompt(ticket, input.goal),
				integrationModel: integrateModel,
				integrationEffort: resolveSfhIntegrateEffort(config),
				integrationAccess: resolveSfhIntegrateAccess(config),
				defaultModel,
				defaultEffort,
				defaultAccess,
				timeoutSec: ex.timeoutSec,
				maxParallel: ex.maxParallel,
			};
			const flowFile = writeFlowFile(cwd, ticket.id, generateFlowYaml(spec));
			const result = await runSfhFlow({ binary, flowFile, flowName, cwd, signal: hooks.signal });
			if (result.exitCode === 0) {
				ticket.status = "done";
				const meta = [
					"executor: sfh",
					result.costUsd !== undefined ? `cost: $${result.costUsd.toFixed(2)}` : "",
					result.elapsedSec !== undefined ? `elapsed: ${result.elapsedSec}s` : "",
					result.runDir ? `run_dir: ${result.runDir}` : "",
				]
						.filter(Boolean)
						.join("  ");
				ticket.report = `${meta}\n\n${result.stdout.slice(0, cap)}`;
				ticket.status = "failed";
				ticket.error = `sfh exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-1000)}`;
			}
		}
	}

	// ---------- 1. Plan ----------
	notify(hooks, board, "planning: Orchestrator が分解中");
	if (!(await orchestratorPlan())) {
		board.phase = "stopped";
		return {
			board,
			verdicts,
			summary: `Orchestrator が有効な計画を返さなかったため停止しました。\n\n${board.planSummary}`,
		};
	}

	// ---------- 2. Initial supervision ----------
	const initial = await runSupervision("initial", "初期監査");
	if (initial && (await applyVerdict(initial, "初期監査")) === "stopped") {
		return {
			board,
			verdicts,
			summary: [
				"## RED: Supervisor が計画を停止しました",
				"",
				`観察: ${initial.observations.join(" / ")}`,
				`リスク: ${initial.risk.join(" / ")}`,
				`必須対応: ${initial.required_actions.join(" / ")}`,
				"",
				"Primary がユーザーと認識を合わせたうえで再計画してください。",
			].join("\n"),
		};
	}

	// ---------- 3. Execute with automatic Supervisor hooks ----------
	board.phase = "executing";
	let stopped = false;

	while (!stopped && !hooks.signal?.aborted) {
		const ticket = pickNext(board);
		if (!ticket) break;

		// Automatic hook-style check before starting the next ticket.
		const auto = checkAutoTriggers(stats, config);
		if (auto.review) {
			if ((await superviseIfTriggered(auto.reason!)) === "stopped") {
				stopped = true;
				break;
			}
			// The Orchestrator may have revised the tickets; re-pick.
			continue;
		}

		ticket.status = "running";
		stats.workerStarts++;
		stats.startsSinceReview++;

		const validationError = validateTicket(ticket);
		if (validationError) {
			ticket.status = "blocked";
			ticket.error = validationError;
			notify(hooks, board, `executing: ${ticket.id} 検証失敗`);
			// treat as failure for consecutive-failure tracking
			stats.consecutiveFailures++;
			const trigger = evaluateTriggers(board, { kind: "worker_failed", ticket, consecutiveFailures: stats.consecutiveFailures }, config);
			if (trigger.review) {
				if ((await superviseIfTriggered(trigger.reason!)) === "stopped") {
					stopped = true;
					break;
				}
			}
			continue;
		}

		const isGroup = ticket.execution === "sfh" && Array.isArray(ticket.branches) && ticket.branches.length > 0;
		if (isGroup) {
			notify(hooks, board, `executing: ${ticket.id}（sfh グループ・${ticket.branches!.length} ブランチ）`);
			await executeGroupTicket(ticket);
		} else {
			notify(hooks, board, `executing: ${ticket.id} 実行中`);

			const workerTask = [
				"以下の作業票を実行してください。",
				"",
				"## 作業票",
				"```json",
				JSON.stringify(ticket, null, 2),
				"```",
				"",
				`## ユーザーの要求（原文）\n${input.goal}`,
			].join("\n");

			const useGuard = (ticket.allowed_scope?.length ?? 0) > 0 || (ticket.forbidden?.length ?? 0) > 0;
			const run = await runRole(worker, workerTask, {
				cwd,
				signal: hooks.signal,
				outputCap: cap,
				extraArgs: useGuard ? ["-e", scopeGuardPath()] : undefined,
				extraEnv: useGuard
					? {
							PI_META_LOOP_ALLOWED_SCOPE: JSON.stringify(ticket.allowed_scope ?? []),
							PI_META_LOOP_FORBIDDEN: JSON.stringify(ticket.forbidden ?? []),
							PI_META_LOOP_CWD: cwd,
						}
					: undefined,
			});
			const report = extractJson<{ status?: string }>(run.output);

			if (run.exitCode !== 0 && !report) {
				ticket.status = "failed";
				ticket.error = run.output.slice(0, 1000);
			} else if (report?.status === "done") {
				ticket.status = "done";
				ticket.report = run.output.slice(0, 2000);
			} else if (report?.status === "partial") {
				ticket.status = "partial";
				ticket.report = run.output.slice(0, 2000);
			} else {
				ticket.status = "blocked";
				ticket.report = run.output.slice(0, 2000);
			}
		}

		// Event-driven triggers (failures, blocks).
		const ok = ticket.status === "done" || ticket.status === "partial";
		stats.consecutiveFailures = ok ? 0 : stats.consecutiveFailures + 1;
		const event: RuntimeEvent = ok
			? { kind: "worker_failed", ticket, consecutiveFailures: 0 } // unused on success; keeps types simple below
			: { kind: "worker_failed", ticket, consecutiveFailures: stats.consecutiveFailures };
		if (!ok) {
			const trigger = evaluateTriggers(board, event, config);
			if (trigger.review) {
				if ((await superviseIfTriggered(trigger.reason!)) === "stopped") {
					stopped = true;
					break;
				}
			}
		}
	}

	// ---------- 4. Final summary ----------
	board.phase = stopped ? "stopped" : "done";
	notify(hooks, board, `${board.phase}: 結果を集約中`);
	const doneCount = board.tickets.filter((t) => t.status === "done").length;
	const partialCount = board.tickets.filter((t) => t.status === "partial").length;
	const failedCount = board.tickets.filter((t) => t.status === "failed" || t.status === "blocked").length;

	const summary = [
		`## Supervised Task ${board.phase === "stopped" ? "停止" : "完了"} (done:${doneCount} partial:${partialCount} 失敗/未達:${failedCount}, supervisions:${board.reviewCount}, workers:${stats.workerStarts})`,
		"",
		`計画: ${board.planSummary}`,
		...(board.openQuestions.length > 0 ? [`未解決の質問: ${board.openQuestions.join(" / ")}`] : []),
		...(verdicts.some((v) => v.verdict !== "green")
			? [`Supervisor 判定: ${verdicts.map((v) => v.verdict).join(" → ")}`]
			: []),
		"",
		...board.tickets.map((t) => `- [${t.status}] ${t.id}: ${t.goal}${t.status !== "done" && t.error ? ` (${t.error.slice(0, 200)})` : ""}`),
		"",
		"各チケットの報告と変更ファイルの一覧を確認し、必要に応じてテストを実行してからユーザーへ報告してください。",
	].join("\n");

	return { board, verdicts, summary };
}
