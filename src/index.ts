/**
 * pi-meta-loop extension entry (0.2.6-alpha).
 *
 * - Background orchestrate; STOP file + /ml-stop + bounded force-stop
 * - Cross-process owner lock (PID/heartbeat/lease) + headless STOP poll
 * - Unified panel; sfh ghost runs filtered
 * - Delta-only scope evidence (no cross-ticket false positives)
 */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	acquireOwnerLock,
	createRunId,
	ensureRunDir,
	formatElapsed,
	hasStopRequest,
	listRuns as listMetaRuns,
	readLatestRun,
	readOwnerLock,
	readRun,
	requestStop,
	runStatusFromPhase,
	isOwnerLockStale,
	ticketCounts,
	writeRun,
	type OwnerLockHolder,
	type PersistedRun,
} from "./board-store.ts";
import { loadConfig, resolveMaxTasksCeiling } from "./config.ts";
import {
	createEscalationStats,
	escalationMessage,
	noteToolCall,
	promptLooksLong,
	shouldSuggestEscalation,
} from "./escalation.ts";
import { decideAbortWait, waitForSettlement } from "./orchestration-lifecycle.ts";
import { runSupervisedTask } from "./runtime.ts";
import {
	activeRuns,
	formatElapsed as sfhElapsed,
	listRuns,
	pickSfhForPanel,
	readStatus,
	type SfhStatus,
} from "./sfh.ts";
import {
	buildFooterLine,
	buildPanelLines,
	nextDetail,
	shouldShowPanel,
	type PanelDetail,
} from "./tui-panel.ts";
import type { TaskBoard, Verdict } from "./types.ts";

const STATUS_KEY = "meta-loop";
const WIDGET_KEY = "meta-loop-panel";
/** Legacy keys — always clear so old sessions do not leave ghost widgets */
const LEGACY_WIDGET_KEYS = ["meta-loop", "sfh"];
const SFH_STATUS_KEY = "sfh";
const POLL_MS = 800;
/** abortActive must return even if the run promise hangs (e.g. stuck child). */
const ABORT_WAIT_MS = 20_000;

interface ActiveOrchestration {
	runId: string;
	cwd: string;
	controller: AbortController;
	startedAt: string;
	label: string;
	activity: string;
	board: TaskBoard | null;
	verdicts: Verdict[];
	promise: Promise<void>;
	/** Permanently disabled when the originating session begins shutdown. */
	allowSessionDelivery: boolean;
	originSessionGeneration: number;
	/** Cross-process owner lock; refresh while live, release only from work finally. */
	lock: { refresh: () => void; release: () => void } | null;
}

function formatLockHolder(holder: OwnerLockHolder | null | undefined): string {
	if (!holder) return "(no holder info)";
	return `pid=${holder.pid} host=${holder.hostname} runId=${holder.runId} heartbeat=${holder.heartbeatAt} leaseSec=${holder.leaseSec}`;
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

function collectDiscussion(ctx: ExtensionContext): string {
	try {
		const entries = ctx.sessionManager.getBranch();
		const parts: string[] = [];
		for (const entry of entries.slice(-12)) {
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
			// Keep short — full body goes on role stdin, but discussion still bloats plan prompts
			if (trimmed) parts.push(`[${msg.role}] ${trimmed.slice(0, 400)}`);
		}
		return parts.join("\n").slice(-4000);
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
	if (depth >= 1) return;

	let sessionUi: ExtensionContext | null = null;
	let active: ActiveOrchestration | null = null;
	let lastBoard: TaskBoard | null = null;
	let lastVerdicts: Verdict[] = [];
	let lastRunId: string | null = null;
	let panelDetail: PanelDetail = "normal";
	let panelForceUntil = 0;
	let paintTick = 0;
	let lastSfh: SfhStatus | null = null;
	/** Prevent old-session UI/message API calls while async shutdown drains a run. */
	let shuttingDown = false;
	let sessionGeneration = 0;
	const escStats = createEscalationStats();

	const clearLegacyWidgets = (ui: ExtensionContext) => {
		for (const k of LEGACY_WIDGET_KEYS) {
			try {
				ui.ui.setWidget(k, undefined);
			} catch {
				/* */
			}
		}
		try {
			ui.ui.setStatus(SFH_STATUS_KEY, "");
		} catch {
			/* */
		}
	};

	const resolveMlDisplay = (cwd: string): { display: PersistedRun | null; live: ActiveOrchestration | null } => {
		if (active?.board) {
			const display: PersistedRun = {
				runId: active.runId,
				cwd: active.cwd,
				goal: active.board.goal,
				status: "running",
				label: active.label,
				startedAt: active.startedAt,
				updatedAt: new Date().toISOString(),
				board: active.board,
				verdicts: active.verdicts,
				activity: active.activity,
			};
			return { display, live: active };
		}
		const latest = readLatestRun(cwd);
		return { display: latest, live: null };
	};

	const refreshSfh = (cwd: string): SfhStatus | null => {
		// Live or freshly finished only — do not resurrect old audit failures forever
		const picked = pickSfhForPanel(cwd, { terminalMaxAgeMs: 45_000 });
		lastSfh = picked;
		return picked;
	};

	type AbortActiveResult = {
		runId: string;
		settled: boolean;
		canStartReplacement: boolean;
	};

	const abortActive = async (reason: string): Promise<AbortActiveResult | null> => {
		if (!active) return null;
		const id = active.runId;
		const run = active;
		const pending = run.promise;
		try {
			requestStop(run.cwd, id, reason);
		} catch {
			/* Abort must still reach the child if STOP persistence fails. */
		}
		run.controller.abort();
		run.label = `stopping… (${reason})`;
		try {
			persistActive({ status: "stopped", label: run.label });
		} catch {
			/* */
		}

		const decision = decideAbortWait(await waitForSettlement(pending, ABORT_WAIT_MS));
		// Never release or clear here. Settlement means work's finally already did
		// both; timeout means work may still write or spawn and must remain owner.
		return {
			runId: id,
			settled: decision.settled,
			canStartReplacement: decision.canStartReplacement,
		};
	};

	/** Cooperative STOP file or external stop — checked every poll tick. */
	const checkCooperativeStop = () => {
		if (!active) return;
		if (!hasStopRequest(active.cwd, active.runId)) return;
		if (active.controller.signal.aborted) return;
		active.controller.abort();
		active.label = "stopping… (STOP file)";
		try {
			persistActive({ status: "stopped", label: active.label });
		} catch {
			/* */
		}
	};

	const paint = (ctx?: ExtensionContext | null, opts?: { force?: boolean }) => {
		const ui = ctx ?? sessionUi;
		if (!ui?.hasUI) return;
		clearLegacyWidgets(ui);
		paintTick++;
		const theme = ui.ui.theme;
		const { display, live } = resolveMlDisplay(ui.cwd);
		const sfh = refreshSfh(ui.cwd);
		const force = Boolean(opts?.force) || Date.now() < panelForceUntil;

		const panelInput = {
			theme,
			detail: panelDetail,
			tick: paintTick,
			forceShow: force,
			ml: display,
			live: live ? { label: live.label, activity: live.activity } : null,
			sfh,
			hideFinishedAfterMs: 90_000,
		};

		const footer = buildFooterLine(panelInput);
		ui.ui.setStatus(STATUS_KEY, footer);
		// Keep secondary status empty — everything is in the unified footer/panel
		ui.ui.setStatus(SFH_STATUS_KEY, "");

		if (!shouldShowPanel(panelInput)) {
			ui.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines = buildPanelLines(panelInput);
		ui.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
	};

	const canUseOriginSession = (run: ActiveOrchestration): boolean =>
		run.allowSessionDelivery && !shuttingDown && run.originSessionGeneration === sessionGeneration;

	const persistActive = (patch: Partial<PersistedRun> = {}) => {
		if (!active?.board) return;
		// Heartbeat while work is live (also covers headless paths without UI poller).
		try {
			active.lock?.refresh();
		} catch {
			/* */
		}
		const run: PersistedRun = {
			runId: active.runId,
			cwd: active.cwd,
			goal: active.board.goal,
			status: "running",
			label: active.label,
			startedAt: active.startedAt,
			updatedAt: new Date().toISOString(),
			board: active.board,
			verdicts: active.verdicts,
			activity: active.activity,
			...patch,
		};
		try {
			writeRun(active.cwd, run);
		} catch (err) {
			console.error("[pi-meta-loop] persist failed", err);
		}
		if (canUseOriginSession(active)) paint();
	};

	// ---------- soft escalation ----------
	pi.on("tool_call", async (event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled || active) return;
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
		if (!cfg.enabled || active || escStats.suggested) return;
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

	// ---------- unified poller (meta-loop + sfh → one panel) ----------
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	const sfhLastStates = new Map<string, string>();
	const watchedSfh = new Map<string, string>();

	const stopPollers = () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration++;
		shuttingDown = false;
		sessionUi = ctx;
		const cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled) return;

		// Restore last board into memory for /tasks
		const latest = readLatestRun(ctx.cwd);
		if (latest) {
			lastBoard = latest.board;
			lastVerdicts = latest.verdicts ?? [];
			lastRunId = latest.runId;
			if (ctx.hasUI && latest.status === "running") {
				const holder = readOwnerLock(ctx.cwd);
				const matchingLiveOwner = holder?.runId === latest.runId && !isOwnerLockStale(holder);
				if (!matchingLiveOwner) {
					// Only a run without a live matching owner is crash residue.
					try {
						writeRun(ctx.cwd, {
							...latest,
							status: "stopped",
							label: "interrupted (session restart)",
							finishedAt: new Date().toISOString(),
						});
					} catch {
						/* */
					}
				}
			}
		}

		if (!ctx.hasUI) return;
		clearLegacyWidgets(ctx);
		stopPollers();
		sfhLastStates.clear();
		watchedSfh.clear();
		// Briefly show last outcome on session start, then auto-hide if terminal
		panelForceUntil = Date.now() + 8_000;
		paint(ctx, { force: true });

		pollTimer = setInterval(() => {
			try {
				checkCooperativeStop();
				// Owner-lock heartbeat each poll tick while a run is live.
				try {
					active?.lock?.refresh();
				} catch {
					/* */
				}
				// sfh state-change notifications
				const actives = activeRuns(ctx.cwd);
				for (const r of actives) watchedSfh.set(r.runDir, r.status?.state ?? "running");
				for (const runDir of [...watchedSfh.keys()]) {
					const s = readStatus(runDir);
					if (!s) continue;
					const prev = sfhLastStates.get(runDir);
					if (prev && prev !== s.state) {
						const severity = s.state === "done" ? "info" : s.state === "stuck" ? "warning" : "error";
						ctx.ui.notify(`sfh:${s.flow} → ${s.state}`, severity);
						// keep terminal sfh visible a bit
						panelForceUntil = Math.max(panelForceUntil, Date.now() + 45_000);
					}
					if (!prev && s.state === "stuck") {
						ctx.ui.notify(`sfh:${s.flow} is stuck (human intervention)`, "warning");
					}
					sfhLastStates.set(runDir, s.state);
					if (s.state !== "running" && s.state !== "stuck") watchedSfh.delete(runDir);
				}
				paint(ctx);
			} catch (err) {
				console.error("[pi-meta-loop] poller error", err);
			}
		}, POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		stopPollers();
		// session_shutdown handlers are awaited by pi. Invalidate session-bound API
		// use first. A bounded wait may return before work settles, but ownership and
		// active state then remain until work's finally completes.
		shuttingDown = true;
		if (active) active.allowSessionDelivery = false;
		sessionUi = null;
		await abortActive("session shutdown");
	});

	const startOrchestration = async (
		params: {
			goal: string;
			context?: string;
			constraints?: string;
			max_tasks?: number;
			background: boolean;
			force?: boolean;
			/** Tool abort signal — bound to the run controller when provided. */
			signal?: AbortSignal;
		},
		ctx: ExtensionContext,
	): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) {
			return {
				content: [{ type: "text", text: "pi-meta-loop is disabled (enabled: false). Handle the task yourself." }],
				details: { disabled: true },
			};
		}
		if (active && params.force) {
			const stopped = await abortActive("force new orchestrate");
			if (stopped && !stopped.canStartReplacement) {
				throw new Error(
					`Cannot force a new supervised run: ${stopped.runId} did not settle within ${ABORT_WAIT_MS}ms. ` +
						"Its active state and owner lock were retained; retry only after it finishes.",
				);
			}
			if (ctx.hasUI && stopped) ctx.ui.notify(`Forced stop of ${stopped.runId}`, "warning");
		}
		if (active) {
			const stopPath = `.pi/meta-loop/runs/${active.runId}/STOP`;
			throw new Error(
				[
					`A supervised run is already active: ${active.runId}`,
					`phase/label: ${active.label}`,
					"Stop options:",
					"  1. /ml-stop",
					`  2. Write an empty file: ${stopPath}`,
					"  3. orchestrate again with force=true",
				].join("\n"),
			);
		}
		// Tool input may narrow the configured cap, never raise it.
		if (params.max_tasks != null) {
			config.limits.maxTasks = resolveMaxTasksCeiling(config.limits.maxTasks, params.max_tasks);
		}

		const runId = createRunId();
		const startedAt = new Date().toISOString();
		const controller = new AbortController();

		// Bind tool _signal so host/tool abort stops the run (including pre-aborted).
		let removeToolAbort: (() => void) | undefined;
		if (params.signal) {
			if (params.signal.aborted) {
				controller.abort();
			} else {
				const onToolAbort = () => {
					if (!controller.signal.aborted) controller.abort();
				};
				params.signal.addEventListener("abort", onToolAbort, { once: true });
				removeToolAbort = () => {
					try {
						params.signal?.removeEventListener("abort", onToolAbort);
					} catch {
						/* */
					}
				};
			}
		}

		// Never take over a live owner, even for force-new: a retained lock means
		// another run may still execute. Stale owners remain recoverable normally.
		const lockResult = acquireOwnerLock(ctx.cwd, { runId });
		if (!lockResult.ok) {
			removeToolAbort?.();
			const stopPath = lockResult.holder?.runId
				? `.pi/meta-loop/runs/${lockResult.holder.runId}/STOP`
				: ".pi/meta-loop/runs/<runId>/STOP";
			throw new Error(
				[
					`Cannot start supervised run — owner lock busy (${lockResult.reason}).`,
					`holder: ${formatLockHolder(lockResult.holder)}`,
					"Stop options:",
					"  1. /ml-stop (same process) or write STOP for holder runId",
					`  2. Write an empty file: ${stopPath}`,
					"  3. Retry after the holder settles and releases ownership",
				].join("\n"),
			);
		}
		const ownerLock = { refresh: lockResult.refresh, release: lockResult.release };

		// Pre-aborted tool signal after lock acquire → release and bail.
		if (controller.signal.aborted) {
			try {
				ownerLock.release();
			} catch {
				/* */
			}
			removeToolAbort?.();
			throw new Error(`orchestrate aborted before start (runId=${runId}; tool signal already aborted).`);
		}

		const artifactDir = ensureRunDir(ctx.cwd, runId);
		const seedBoard: TaskBoard = {
			goal: params.goal,
			planSummary: "",
			openQuestions: [],
			tickets: [],
			phase: "planning",
			reviewCount: 0,
		};

		const orch: ActiveOrchestration = {
			runId,
			cwd: ctx.cwd,
			controller,
			startedAt,
			label: "planning: starting",
			activity: "",
			board: seedBoard,
			verdicts: [],
			promise: Promise.resolve(),
			allowSessionDelivery: true,
			originSessionGeneration: sessionGeneration,
			lock: ownerLock,
		};
		active = orch;
		lastRunId = runId;
		lastBoard = seedBoard;
		sessionUi = ctx;

		// Headless-safe heartbeat + STOP poll (UI poller may be absent).
		const runPulse = setInterval(() => {
			if (!active || active.runId !== runId) return;
			try {
				active.lock?.refresh();
			} catch {
				/* */
			}
			if (hasStopRequest(ctx.cwd, runId) && !controller.signal.aborted) {
				controller.abort();
				active.label = "stopping… (STOP file)";
				try {
					persistActive({ status: "stopped", label: active.label });
				} catch {
					/* */
				}
			}
		}, POLL_MS);
		if (typeof runPulse.unref === "function") runPulse.unref();

		persistActive({ status: "running", label: orch.label });
		if (ctx.hasUI) {
			ctx.ui.notify(`meta-loop started (${runId.slice(0, 20)}…) — chat stays free. /tasks /ml-stop`, "info");
			paint(ctx);
		}

		const work = async () => {
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
						signal: controller.signal,
						artifactDir,
						// UI-independent STOP (headless / other process writing STOP file).
						stopCheck: () => hasStopRequest(ctx.cwd, runId),
						onPhase: (board, label) => {
							if (!active || active.runId !== runId) return;
							active.board = board;
							active.label = label;
							if (board.verdictHistory?.length) {
								active.verdicts = board.verdictHistory;
								lastVerdicts = board.verdictHistory;
							}
							lastBoard = board;
							persistActive({ board, label, status: "running", verdicts: active.verdicts });
						},
						onActivity: (text) => {
							if (!active || active.runId !== runId) return;
							active.activity = text;
							// cheap UI refresh; disk write throttled by poller/paint
							if (canUseOriginSession(orch)) paint();
						},
					},
				);

				lastBoard = result.board;
				lastVerdicts = result.verdicts;
				escStats.suggested = true;

				const terminal = runStatusFromPhase(result.board.phase, controller.signal.aborted);
				const counts = ticketCounts(result.board);

				const finished: PersistedRun = {
					runId,
					cwd: ctx.cwd,
					goal: params.goal,
					status: terminal,
					label: `${result.board.phase}: finished`,
					startedAt,
					updatedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					board: result.board,
					verdicts: result.verdicts,
					summary: result.summary,
					error:
						terminal === "done" || terminal === "stopped"
							? undefined
							: result.board.planSummary?.startsWith("[")
								? result.board.planSummary.slice(0, 500)
								: `phase=${result.board.phase} done=${counts.done}/${counts.total}`,
				};
				writeRun(ctx.cwd, finished);

				if (canUseOriginSession(orch) && sessionUi?.hasUI) {
					sessionUi.ui.notify(
						`meta-loop ${terminal}: ${result.board.phase} (✓${counts.done}/◐${counts.partial}/■${counts.blocked}/✗${counts.failed} of ${counts.total})`,
						terminal === "done" ? "info" : "warning",
					);
					panelForceUntil = Date.now() + 120_000;
					paint(sessionUi, { force: true });
				}

				// Only background runs need out-of-band delivery. Foreground callers get
				// the tool result directly, and old session APIs are invalid on shutdown.
				if (params.background && canUseOriginSession(orch)) {
					pi.sendMessage(
						{
							customType: "meta-loop-result",
							content: [
								`[pi-meta-loop] Supervised run ${terminal} phase=${result.board.phase} (runId=${runId}).`,
								terminal === "done"
									? ""
									: "This is NOT a full success — verify tickets before telling the user the goal is complete.",
								"",
								result.summary,
							]
								.filter(Boolean)
								.join("\n"),
							display: true,
							details: { runId, board: result.board, verdicts: result.verdicts, status: terminal },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const board = active?.board ?? seedBoard;
				const failed: PersistedRun = {
					runId,
					cwd: ctx.cwd,
					goal: params.goal,
					status: controller.signal.aborted ? "stopped" : "error",
					label: controller.signal.aborted ? "stopped by user" : `error: ${message.slice(0, 80)}`,
					startedAt,
					updatedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					board,
					verdicts: active?.verdicts ?? [],
					error: message,
					summary: `orchestrate failed: ${message}`,
				};
				try {
					writeRun(ctx.cwd, failed);
				} catch {
					/* */
				}
				if (canUseOriginSession(orch) && sessionUi?.hasUI) {
					sessionUi.ui.notify(`meta-loop error: ${message.slice(0, 120)}`, "error");
					paint(sessionUi);
				}
				if (params.background && canUseOriginSession(orch)) {
					pi.sendMessage(
						{
							customType: "meta-loop-result",
							content: `[pi-meta-loop] Supervised run failed (runId=${runId}): ${message}`,
							display: true,
							details: { runId, error: message },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
			} finally {
				clearInterval(runPulse);
				removeToolAbort?.();
				try {
					ownerLock.release();
				} catch {
					/* */
				}
				if (active?.runId === runId) {
					active.lock = null;
					active = null;
				}
				if (canUseOriginSession(orch)) paint();
			}
		};

		orch.promise = work();

		if (!params.background) {
			await orch.promise;
			// The owner lock is released in work's finally. Another run may update the
			// latest pointer immediately afterward, so foreground completion must use
			// the exact run id it started.
			const completed = readRun(ctx.cwd, runId);
			if (!completed) {
				throw new Error(`Supervised run ${runId} finished without a persisted result.`);
			}
			const summary = completed.summary ?? `Supervised run finished with status ${completed.status}.`;
			if (completed.status !== "done") {
				throw new Error(`Supervised run ${runId} ${completed.status}: ${summary}`);
			}
			return {
				content: [{ type: "text", text: summary }],
				details: {
					runId,
					board: completed.board,
					verdicts: completed.verdicts,
					background: false,
					status: completed.status,
				},
			};
		}

		return {
			content: [
				{
					type: "text",
					text: [
						`Supervised task started in background.`,
						`runId: ${runId}`,
						`goal: ${params.goal.slice(0, 200)}`,
						"",
						"The main session stays interactive — the user can keep chatting.",
						"Status: footer + widget below the editor (auto-refresh).",
						"Commands: /tasks  /ml-stop  /verdicts  /ml-runs",
						"When finished, a meta-loop-result message is injected automatically.",
						"Do NOT block waiting; acknowledge start and continue helping the user.",
					].join("\n"),
				},
			],
			details: { runId, background: true, status: "running" },
		};
	};

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
					? `${s.state}  ${s.flow}  step:${s.current_step}  $${(s.cost_usd ?? 0).toFixed(2)}  ${sfhElapsed(s.elapsed_sec)}`
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
					`cost: $${(s.cost_usd ?? 0).toFixed(2)}   elapsed: ${sfhElapsed(s.elapsed_sec)}`,
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
			"In TUI, runs in the BACKGROUND by default so the user can keep chatting. Status via widget + /tasks.",
			"Do NOT use for short Q&A, git status, or single-file fixes.",
		].join("\n"),
		parameters: Type.Object({
			goal: Type.String({ description: "User request, verbatim" }),
			context: Type.Optional(Type.String({ description: "Extra context" })),
			constraints: Type.Optional(Type.String({ description: "Constraints / forbidden" })),
			max_tasks: Type.Optional(Type.Number({ description: "Ticket cap" })),
			background: Type.Optional(
				Type.Boolean({
					description: "Run async and free the chat (default true in TUI, false in print/json)",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "Abort an in-memory active run; replacement starts only after confirmed settlement",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// RPC has a UI bridge but is still an API caller: default it to a
			// foreground result. Fire-and-forget is the TUI-only default.
			const background = params.background ?? ctx.mode === "tui";
			return startOrchestration(
				{
					goal: params.goal,
					context: params.context,
					constraints: params.constraints,
					max_tasks: params.max_tasks,
					background,
					force: params.force,
					signal,
				},
				ctx,
			);
		},
	});

	pi.registerCommand("tasks", {
		description: "Task board summary; optional ticket drill-down",
		handler: async (_args, ctx) => {
			if (!loadConfig(ctx.cwd).enabled) {
				ctx.ui.notify("pi-meta-loop is disabled", "info");
				return;
			}
			const disk = readLatestRun(ctx.cwd);
			const board = active?.board ?? lastBoard ?? disk?.board;
			const runMeta = active
				? { runId: active.runId, label: active.label, startedAt: active.startedAt, status: "running" as const }
				: disk;
			if (!board) {
				ctx.ui.notify("No supervised task board yet", "info");
				return;
			}
			const c = ticketCounts(board);
			const runId = runMeta && "runId" in runMeta ? runMeta.runId : lastRunId ?? "?";
			const header = [
				`run: ${runId}`,
				`status: ${runMeta && "status" in runMeta ? runMeta.status : "?"}  phase: ${board.phase}  reviews: ${board.reviewCount}`,
				active ? `live: ${active.label}` : runMeta && "label" in runMeta ? `last: ${runMeta.label}` : "",
				active ? `elapsed: ${formatElapsed(active.startedAt)}` : "",
				`counts: ✓${c.done} ●${c.running} ○${c.pending} ◐${c.partial} ✗${c.failed} ■${c.blocked} / ${c.total}`,
				board.verdict ? `verdict: ${board.verdict.verdict}` : "",
				board.planSummary ? `plan: ${board.planSummary.slice(0, 160)}` : "",
				`goal: ${board.goal.slice(0, 120)}`,
			].filter(Boolean);

			const ticketLines = board.tickets.map((t) => {
				const err = t.error ? ` — ${t.error.slice(0, 60)}` : "";
				return `${ticketIcon(t.status)} ${t.id} [${t.status}] ${t.goal.slice(0, 50)}${err}`;
			});

			// Overview first
			ctx.ui.notify([...header, "", ...ticketLines, active ? "" : "", active ? "Stop: /ml-stop" : ""].filter(Boolean).join("\n"), "info");

			// Optional drill-down (interactive)
			if (board.tickets.length > 0 && ctx.hasUI) {
				const items = [
					"(close)",
					...board.tickets.map(
						(t) => `${ticketIcon(t.status)} ${t.id} [${t.status}] ${t.goal.slice(0, 40)}`,
					),
				];
				const choice = await ctx.ui.select("Ticket detail (or close):", items);
				if (choice && choice !== "(close)") {
					const idx = items.indexOf(choice) - 1;
					const t = board.tickets[idx];
					if (t) {
						ctx.ui.notify(
							[
								`### ${t.id} [${t.status}]`,
								t.goal,
								`exec: ${t.execution ?? "native"}`,
								`deps: ${(t.dependencies || []).join(", ") || "—"}`,
								`scope: ${(t.allowed_scope || []).slice(0, 6).join(", ")}`,
								`acceptance: ${(t.acceptance || []).slice(0, 4).join(" | ")}`,
								t.error ? `error: ${t.error.slice(0, 400)}` : "",
								t.evidence?.scopeViolations?.length
									? `scopeViolations: ${t.evidence.scopeViolations.slice(0, 4).join("; ")}`
									: "",
								t.evidence?.actualChangedFiles?.length
									? `changed: ${t.evidence.actualChangedFiles.slice(0, 8).join(", ")}`
									: "",
							]
								.filter(Boolean)
								.join("\n"),
							"info",
						);
					}
				}
			}

			panelForceUntil = Date.now() + 180_000;
			paint(ctx, { force: true });
		},
	});

	pi.registerCommand("verdicts", {
		description: "Show Supervisor verdict history",
		handler: async (_args, ctx) => {
			if (!loadConfig(ctx.cwd).enabled) {
				ctx.ui.notify("pi-meta-loop is disabled", "info");
				return;
			}
			const disk = readLatestRun(ctx.cwd);
			const fromBoard = active?.board?.verdictHistory ?? disk?.board?.verdictHistory;
			const verdicts = active?.verdicts?.length
				? active.verdicts
				: fromBoard?.length
					? fromBoard
					: lastVerdicts.length
						? lastVerdicts
						: (disk?.verdicts ?? []);
			if (verdicts.length === 0) {
				ctx.ui.notify("No verdicts yet", "info");
				return;
			}
			ctx.ui.notify(
				verdicts.map((v, i) => `#${i + 1} ${v.verdict}${v.observations[0] ? ` — ${v.observations[0]}` : ""}`).join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("ml-stop", {
		description: "Stop the active background supervised run (also writes runs/<id>/STOP)",
		handler: async (_args, ctx) => {
			if (!active) {
				// Still allow writing STOP for latest disk run (other agents)
				const latest = readLatestRun(ctx.cwd);
				if (latest && latest.status === "running") {
					requestStop(ctx.cwd, latest.runId, "ml-stop-no-memory");
					ctx.ui.notify(`Wrote STOP for disk run ${latest.runId} (no in-memory active)`, "warning");
					return;
				}
				ctx.ui.notify("No active supervised run", "info");
				return;
			}
			const stopped = await abortActive("ml-stop");
			const suffix = stopped?.settled
				? "Run settled; a new orchestrate may start."
				: "Run is still settling; active state and owner lock remain held."
			ctx.ui.notify(`Stop signal sent (${stopped?.runId ?? "unknown"}). ${suffix}`, "info");
			paint(ctx);
		},
	});

	pi.registerCommand("ml-ui", {
		description: "Cycle panel detail: compact | normal | full  (or /ml-ui compact)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "compact" || a === "normal" || a === "full") {
				panelDetail = a;
			} else if (a === "hide") {
				panelForceUntil = 0;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, "");
				ctx.ui.notify("panel hidden (will reappear when a run is active)", "info");
				return;
			} else if (a === "show") {
				panelForceUntil = Date.now() + 300_000;
			} else {
				panelDetail = nextDetail(panelDetail);
			}
			panelForceUntil = Math.max(panelForceUntil, Date.now() + 180_000);
			paint(ctx, { force: true });
			ctx.ui.notify(`meta-loop panel: ${panelDetail}  (/ml-ui compact|normal|full|show|hide)`, "info");
		},
	});

	try {
		pi.registerShortcut("ctrl+shift+m", {
			description: "Cycle meta-loop panel detail",
			handler: async (ctx) => {
				panelDetail = nextDetail(panelDetail);
				panelForceUntil = Date.now() + 180_000;
				paint(ctx, { force: true });
				ctx.ui.notify(`panel detail → ${panelDetail}`, "info");
			},
		});
	} catch {
		/* older pi without shortcuts */
	}

	pi.registerCommand("ml-runs", {
		description: "List recent meta-loop runs on disk",
		handler: async (_args, ctx) => {
			const runs = listMetaRuns(ctx.cwd, 12);
			if (runs.length === 0) {
				ctx.ui.notify("No .pi/meta-loop/runs yet", "info");
				return;
			}
			const items = runs.map(
				(r) => `${r.status.padEnd(8)} ${r.runId.slice(0, 24)}  ${r.board.phase}  ${r.goal.slice(0, 40)}`,
			);
			const choice = await ctx.ui.select("meta-loop runs:", items);
			if (!choice) return;
			const picked = runs[items.indexOf(choice)];
			if (!picked) return;
			lastBoard = picked.board;
			lastVerdicts = picked.verdicts ?? [];
			lastRunId = picked.runId;
			const c = ticketCounts(picked.board);
			ctx.ui.notify(
				[
					`runId: ${picked.runId}`,
					`status: ${picked.status}  phase: ${picked.board.phase}`,
					`goal: ${picked.goal}`,
					`label: ${picked.label}`,
					`counts: ✓${c.done} ●${c.running} ✗${c.failed + c.blocked} / ${c.total}`,
					picked.error ? `error: ${picked.error}` : "",
					`dir: .pi/meta-loop/runs/${picked.runId}/`,
				]
					.filter(Boolean)
					.join("\n"),
				picked.status === "error" ? "warning" : "info",
			);
			panelForceUntil = Date.now() + 180_000;
			paint(ctx, { force: true });
		},
	});
}
