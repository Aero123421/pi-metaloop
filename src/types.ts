/**
 * pi-metaLoop core types: task tickets, verdicts, board.
 */

export type TicketStatus = "pending" | "running" | "done" | "partial" | "blocked" | "failed";

export interface Ticket {
	id: string;
	goal: string;
	deliverables: string[];
	acceptance: string[];
	allowed_scope: string[];
	forbidden: string[];
	dependencies: string[];
	context?: string;
	status: TicketStatus;
	report?: string;
	error?: string;
}

export type VerdictLevel = "green" | "yellow" | "red";

export interface Verdict {
	verdict: VerdictLevel;
	/** macro | meso | micro のどの層への介入か */
	scope?: "overall" | "orchestrator" | "workers" | "harness";
	observations: string[];
	risk: string[];
	required_actions: string[];
	optional_advice: string[];
	affected_tasks: string[];
	harness_suggestions: string[];
	/** Orchestrator の次のステップに注入する行動改善アドバイス（例: 視野狭窄の是正）。
	 * Worker への直接介入は禁止。すべて Orchestrator 経由。 */
	orchestrator_guidance?: string[];
}

export interface TaskBoard {
	goal: string;
	planSummary: string;
	openQuestions: string[];
	tickets: Ticket[];
	phase: "planning" | "initial-review" | "revision" | "executing" | "final-review" | "done" | "stopped";
	verdict?: Verdict;
	reviewCount: number;
}

export interface OrchestrateInput {
	goal: string;
	context?: string;
	constraints?: string;
	/** orchestrate 起動前までの Primary との会話ダイジェスト（議論・合意・制約） */
	discussion?: string;
	max_tasks?: number;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface RoleRunResult {
	output: string;
	exitCode: number;
	usage: UsageStats;
}
