/**
 * Re-review triggers. Event-driven anomalies + automatic hook-style checks
 * (time interval, worker start count). All thresholds are config-driven.
 */
import type { TaskBoard, Ticket } from "./types.ts";
import type { MetaLoopConfig } from "./config.ts";

export interface TriggerResult {
	review: boolean;
	reason?: string;
}

export type RuntimeEvent =
	| { kind: "worker_failed"; ticket: Ticket; consecutiveFailures: number }
	| { kind: "worker_blocked"; ticket: Ticket }
	| { kind: "worker_out_of_scope"; ticket: Ticket };

/** Statistics maintained by the runtime for automatic Supervisor hooks. */
export interface SupervisorStats {
	workerStarts: number;
	startsSinceReview: number;
	lastReviewAt: number;
	consecutiveFailures: number;
}

/** Event-driven anomaly triggers (failures, blocks, scope violations). */
export function evaluateTriggers(board: TaskBoard, event: RuntimeEvent, config: MetaLoopConfig): TriggerResult {
	switch (event.kind) {
		case "worker_failed":
			if (event.consecutiveFailures >= config.supervisor.maxConsecutiveFailures) {
				return { review: true, reason: `連続失敗 ${event.consecutiveFailures} 件 (${event.ticket.id})` };
			}
			return { review: false };

		case "worker_blocked":
			return { review: true, reason: `チケット ${event.ticket.id} が前提条件不足でブロック` };

		case "worker_out_of_scope":
			return { review: true, reason: `チケット ${event.ticket.id} のスコープ逸脱の疑い` };
	}
}

/**
 * Automatic hook-style triggers, checked before each ticket starts:
 * - periodic: every `checkIntervalMinutes` since the last review (default 30)
 * - load: `workerStartThreshold` worker starts since the last review (default 4)
 */
export function checkAutoTriggers(stats: SupervisorStats, config: MetaLoopConfig): TriggerResult {
	const sup = config.supervisor;
	if (!sup.auto) return { review: false };

	const intervalMs = sup.checkIntervalMinutes * 60_000;
	if (intervalMs > 0 && Date.now() - stats.lastReviewAt >= intervalMs) {
		const mins = Math.round((Date.now() - stats.lastReviewAt) / 60_000);
		return { review: true, reason: `定期検査（${mins} 分経過 / 基準 ${sup.checkIntervalMinutes} 分）` };
	}

	if (sup.workerStartThreshold > 0 && stats.startsSinceReview >= sup.workerStartThreshold) {
		return { review: true, reason: `Worker 起動数 ${stats.startsSinceReview} が閾値 ${sup.workerStartThreshold} に到達` };
	}

	return { review: false };
}
