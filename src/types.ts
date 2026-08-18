/**
 * pi-meta-loop core types.
 */
/**
 * `failed` means the ticket's own execution is at fault. Outcomes the ticket did
 * not cause — environment failures, external interference, verify that was
 * already red before the run — are `partial` with `evidence.inconclusive`, which
 * can never become `done` but is also not charged to the ticket.
 */
export type TicketStatus =
	| "pending"
	| "running"
	| "completed"
	| "partial"
	| "blocked"
	| "failed"
	| "cancelled";

export type BoardPhase =
	| "planning"
	| "initial-review"
	| "awaiting-approval"
	| "executing"
	| "final-review"
	| "completed"
	| "stopped"
	| "incomplete"
	| "degraded"
	| "plan_failed"
	| "plan_rejected";

export interface WorkerClaim {
	claimedStatus?: "done" | "partial" | "blocked";
	changed_files?: string[];
	tests?: string[];
	unresolved?: string[];
	assumptions?: string[];
	notes?: string;
	raw?: string;
	/** Which protocol carried the report. A silent fallback should be visible. */
	source?: "submission" | "fence-fallback";
}

/** Controller-side trusted verify outcome (model-independent). */
export type VerifyStatus = "passed" | "failed" | "timeout" | "unset" | "error" | "aborted";

/** When the controller runs the trusted verify sequence. */
export type VerifyMode = "per-ticket" | "final";

export interface VerifyEvidence {
	status: VerifyStatus;
	/** argv lists that were configured / attempted */
	commands?: string[][];
	/** The argv that failed or timed out, when one did. */
	failedCommand?: string[];
	exitCode?: number;
	timedOut?: boolean;
	output?: string;
	reason?: string;
	/** Run-start baseline status, when a baseline was captured. */
	baselineStatus?: VerifyStatus;
	/** True when this ticket's failure matches a failure the run started with. */
	preExisting?: boolean;
}

/**
 * Verify result captured once before the execute loop, so a repository that was
 * already failing does not make every ticket look like it broke something.
 */
export interface VerifyBaseline {
	status: VerifyStatus;
	/** Stable identity of the failing step (the argv that failed). */
	signature?: string;
}

export interface ExecutionEvidence {
	/**
	 * The harness could not determine whether the ticket did its work — the
	 * snapshot failed, another process invalidated the baseline, or verify was
	 * cut short. Distinct from an ordinary `partial`, where the Worker ran and
	 * reported incomplete progress: inconclusive must not read as forward progress.
	 */
	inconclusive?: boolean;
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
	/**
	 * Which executor runs the ticket. Only the native pi worker exists today; the field
	 * is the extension point for the multi-CLI executor (issue #4). Boards written by
	 * older versions may carry other values — they are read for display, never executed.
	 */
	execution?: "native";
	status: TicketStatus;
	report?: string;
	error?: string;
	claim?: WorkerClaim;
	evidence?: ExecutionEvidence;
}

export type VerdictLevel = "green" | "yellow" | "red";

export interface Verdict {
	verdict: VerdictLevel;
	/** Which audit produced it. Optional for boards written before it existed. */
	stage?: "initial" | "mid" | "final";
	scope?: "overall" | "orchestrator" | "workers" | "harness";
	observations: string[];
	risk: string[];
	required_actions: string[];
	optional_advice: string[];
	affected_tasks: string[];
	harness_suggestions: string[];
	orchestrator_guidance?: string[];
}

/**
 * Whether the run's work was checked, kept apart from whether the work was done.
 *
 * These are different questions and folding them into one status made the answer to
 * both worse: a finished ticket with no verify configured had to be called `partial`,
 * which reads as "half done" when nothing was half done — only unchecked.
 */
export interface RunVerification {
	status: "verified" | "unverified" | "failed";
	detail: string;
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
	/** Whether the run's work was checked. Independent of whether tickets completed. */
	verification?: RunVerification;
	reviewCount: number;
}

export interface OrchestrateInput {
	goal: string;
	context?: string;
	constraints?: string;
	discussion?: string;
	max_tasks?: number;
	/** Caller-side gate override. May only strengthen the configured policy. */
	approval?: "always" | "findings" | "off";
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
