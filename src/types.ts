/**
 * pi-metaLoop core types.
 */
export type TicketStatus =
	| "pending"
	| "running"
	| "done"
	| "partial"
	| "blocked"
	| "failed"
	| "cancelled";

export type BoardPhase =
	| "planning"
	| "initial-review"
	| "revision"
	| "executing"
	| "final-review"
	| "done"
	| "stopped"
	| "incomplete"
	| "degraded"
	| "plan_failed";

/** Parallel group branch */
export interface Branch {
	id: string;
	tool?: string;
	model?: string;
	effort?: string;
	/** Forced to read for sfh groups by the harness */
	access?: string;
	prompt: string;
}

export interface IntegrationContract {
	acceptance: string[];
	output?: string;
}

export interface WorkerClaim {
	claimedStatus?: "done" | "partial" | "blocked";
	changed_files?: string[];
	tests?: string[];
	unresolved?: string[];
	assumptions?: string[];
	notes?: string;
	raw?: string;
}

/** Controller-side trusted verify outcome (model-independent). */
export type VerifyStatus = "passed" | "failed" | "timeout" | "unset" | "error" | "aborted";

export interface VerifyEvidence {
	status: VerifyStatus;
	/** argv lists that were configured / attempted */
	commands?: string[][];
	exitCode?: number;
	timedOut?: boolean;
	output?: string;
	reason?: string;
}

export interface ExecutionEvidence {
	processExitCode: number;
	actualChangedFiles: string[];
	scopeViolations: string[];
	claimedStatus?: string;
	/** Present on native implementation tickets after controller verify gate. */
	verify?: VerifyEvidence;
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
	execution?: "native" | "sfh";
	branches?: Branch[];
	integration?: IntegrationContract;
	status: TicketStatus;
	report?: string;
	error?: string;
	claim?: WorkerClaim;
	evidence?: ExecutionEvidence;
}

export type VerdictLevel = "green" | "yellow" | "red";

export interface Verdict {
	verdict: VerdictLevel;
	scope?: "overall" | "orchestrator" | "workers" | "harness";
	observations: string[];
	risk: string[];
	required_actions: string[];
	optional_advice: string[];
	affected_tasks: string[];
	harness_suggestions: string[];
	orchestrator_guidance?: string[];
}

export interface TaskBoard {
	goal: string;
	planSummary: string;
	openQuestions: string[];
	tickets: Ticket[];
	phase: BoardPhase;
	verdict?: Verdict;
	/** Full history persisted with the board (survives reload). */
	verdictHistory?: Verdict[];
	reviewCount: number;
}

export interface OrchestrateInput {
	goal: string;
	context?: string;
	constraints?: string;
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
