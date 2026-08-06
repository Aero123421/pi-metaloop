/**
 * pi-metaLoop core types: task tickets, verdicts, board.
 */

export type TicketStatus = "pending" | "running" | "done" | "partial" | "blocked" | "failed";

/** 並列グループチケットの 1 ブランチ */
export interface Branch {
	id: string;
	/** sfh のツールプリセット名（pi / opencode / codex / claude / grok など）。既定は pi */
	tool?: string;
	/** sfh step.model。ツールごとのモデル ID。未指定なら config の executor.sfhToolModels / sfhModel */
	model?: string;
	prompt: string;
}

/** 統合約：並列ブランチの出力をどう纏めるかの観測可能な条件 */
export interface IntegrationContract {
	acceptance: string[];
	output?: string;
}

export interface Ticket {
	id: string;
	goal: string;
	deliverables: string[];
	acceptance: string[];
	allowed_scope: string[];
	forbidden: string[];
	dependencies: string[];
	context?: string;
	/** native = Worker（pi）が直接実行。sfh = 並列ブランチ群を sfh に委譲 */
	execution?: "native" | "sfh";
	branches?: Branch[];
	integration?: IntegrationContract;
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
