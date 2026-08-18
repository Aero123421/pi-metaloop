/**
 * P0 terminal / claim / evidence / trigger semantics (pure-function level).
 * Spec follow-up for adversarial review — not assertion weakening.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildChatDigest,
	computeRunVerification,
	finalizeFromEvidence,
	parseInitialPlanRun,
	resolveTerminalPhase,
	validateTicket,
} from "../src/runtime.ts";
import { runStatusFromPhase } from "../src/board-store.ts";
import { evaluateTriggers } from "../src/triggers.ts";
import { defaultConfig } from "../src/config.ts";
import type { ExecutionEvidence, TaskBoard, Ticket, Verdict, WorkerClaim } from "../src/types.ts";

function baseTicket(over: Partial<Ticket> = {}): Ticket {
	return {
		id: "t1",
		goal: "g",
		deliverables: ["d"],
		acceptance: ["a"],
		allowed_scope: ["src/**"],
		forbidden: [],
		dependencies: [],
		status: "pending",
		...over,
	};
}

function boardOf(
	statuses: Ticket["status"][],
	phase: TaskBoard["phase"] = "executing",
): TaskBoard {
	return {
		goal: "g",
		planSummary: "p",
		openQuestions: [],
		phase,
		reviewCount: 0,
		tickets: statuses.map((status, i) => baseTicket({ id: `t${i}`, status, acceptance: ["a"] })),
	};
}

function evidence(over: Partial<ExecutionEvidence> = {}): ExecutionEvidence {
	return {
		processExitCode: 0,
		actualChangedFiles: [],
		scopeViolations: [],
		...over,
	};
}

function claim(over: Partial<WorkerClaim> = {}): WorkerClaim {
	return { ...over };
}

function verdict(level: Verdict["verdict"], over: Partial<Verdict> = {}): Verdict {
	return {
		verdict: level,
		observations: [],
		risk: [],
		required_actions: [],
		optional_advice: [],
		affected_tasks: [],
		harness_suggestions: [],
		...over,
	};
}

describe("resolveTerminalPhase P0 semantics", () => {
	// P0 specification change (not a weakened test):
	// Old harness expected done+partial → "completed". Partial is no longer full success.
	it("done+partial → incomplete (was done under pre-P0 expectation)", () => {
		assert.equal(resolveTerminalPhase(boardOf(["completed", "partial"]), false), "incomplete");
	});

	it("all done → done", () => {
		assert.equal(resolveTerminalPhase(boardOf(["completed", "completed"]), false), "completed");
	});

	it("any failed/blocked/partial without full success → incomplete", () => {
		assert.equal(resolveTerminalPhase(boardOf(["completed", "failed"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["blocked"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["partial", "partial"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["completed", "cancelled"]), false), "incomplete");
	});

	it("pending/running → incomplete (not fake done)", () => {
		assert.equal(resolveTerminalPhase(boardOf(["completed", "pending"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["running"]), false), "incomplete");
	});

	it("empty tickets → plan_failed; abort → stopped; locked phases kept", () => {
		assert.equal(resolveTerminalPhase(boardOf([], "planning"), false), "plan_failed");
		assert.equal(resolveTerminalPhase(boardOf(["completed"]), true), "stopped");
		assert.equal(resolveTerminalPhase(boardOf(["completed"], "degraded"), false), "degraded");
		assert.equal(resolveTerminalPhase(boardOf(["completed"], "stopped"), false), "stopped");
		assert.equal(resolveTerminalPhase(boardOf(["completed"], "plan_failed"), false), "plan_failed");
	});

	it("final-review phase does not lock: evidence drives terminal incomplete/done", () => {
		// After Supervisor final audit label, resolveTerminalPhase still applies ticket evidence.
		assert.equal(resolveTerminalPhase(boardOf(["completed", "partial"], "final-review"), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["completed", "completed"], "final-review"), false), "completed");
		assert.equal(runStatusFromPhase("incomplete", false), "incomplete");
	});
});

describe("finalizeFromEvidence P0 semantics", () => {
	it("nonzero exit → failed even when worker claims done", () => {
		const ticket = baseTicket({ status: "running" });
		finalizeFromEvidence(
			ticket,
			claim({ claimedStatus: "done", notes: "I finished" }),
			evidence({ processExitCode: 1 }),
		);
		assert.equal(ticket.status, "failed");
		assert.match(ticket.error ?? "", /exit 1|claimed done/i);
	});

	it("nonzero exit → failed even when worker claims partial/blocked", () => {
		const partialT = baseTicket({ status: "running" });
		finalizeFromEvidence(partialT, claim({ claimedStatus: "partial" }), evidence({ processExitCode: 2 }));
		assert.equal(partialT.status, "failed");

		const blockedT = baseTicket({ status: "running" });
		finalizeFromEvidence(blockedT, claim({ claimedStatus: "blocked" }), evidence({ processExitCode: 3 }));
		assert.equal(blockedT.status, "failed");
	});

	it("exit 0 + claim done + verify passed → done; exit 0 + claim partial → partial", () => {
		const doneT = baseTicket({ status: "running" });
		finalizeFromEvidence(
			doneT,
			claim({ claimedStatus: "done" }),
			evidence({ processExitCode: 0, verify: { status: "passed", exitCode: 0 } }),
		);
		assert.equal(doneT.status, "completed");

		const partT = baseTicket({ status: "running" });
		finalizeFromEvidence(partT, claim({ claimedStatus: "partial" }), evidence({ processExitCode: 0 }));
		assert.equal(partT.status, "partial");
	});

	it("exit 0 + claim done without verify → completed but unchecked", () => {
		// The ticket did its work; nobody checked it. Those are different facts and the
		// run-level verification carries the second one — calling this "partial" said
		// "half done" about work that was not half done.
		const unsetT = baseTicket({ status: "running" });
		finalizeFromEvidence(
			unsetT,
			claim({ claimedStatus: "done" }),
			evidence({ processExitCode: 0, verify: { status: "unset", reason: "not configured" } }),
		);
		assert.equal(unsetT.status, "completed");

		const missingT = baseTicket({ status: "running" });
		finalizeFromEvidence(missingT, claim({ claimedStatus: "done" }), evidence({ processExitCode: 0 }));
		assert.equal(missingT.status, "completed");
	});

	it("exit 0 + claim done + verify failed/timeout → failed", () => {
		const failedT = baseTicket({ status: "running" });
		finalizeFromEvidence(
			failedT,
			claim({ claimedStatus: "done" }),
			evidence({
				processExitCode: 0,
				verify: { status: "failed", exitCode: 1, reason: "controller verify failed (exit 1): npm test" },
			}),
		);
		assert.equal(failedT.status, "failed");
		assert.match(failedT.error ?? "", /verify failed/i);

		const timeoutT = baseTicket({ status: "running" });
		finalizeFromEvidence(
			timeoutT,
			claim({ claimedStatus: "done" }),
			evidence({
				processExitCode: 0,
				verify: { status: "timeout", timedOut: true, reason: "controller verify timed out" },
			}),
		);
		assert.equal(timeoutT.status, "failed");
		assert.match(timeoutT.error ?? "", /timeout|verify/i);
	});

	it("exit 0 + missing claim status → partial (never silent done)", () => {
		const ticket = baseTicket({ status: "running" });
		finalizeFromEvidence(ticket, claim({}), evidence({ processExitCode: 0 }));
		assert.equal(ticket.status, "partial");
	});

	it("scope violations → failed before claim trust", () => {
		const ticket = baseTicket({ status: "running" });
		finalizeFromEvidence(
			ticket,
			claim({ claimedStatus: "done" }),
			evidence({ processExitCode: 0, scopeViolations: ["outside/scope.ts"] }),
		);
		assert.equal(ticket.status, "failed");
		assert.match(ticket.error ?? "", /scope violations/i);
	});
});

describe("validateTicket allowed_scope fail-closed", () => {
	it("rejects native implementation ticket with empty allowed_scope", () => {
		const err = validateTicket(baseTicket({ execution: "native", allowed_scope: [] }));
		assert.ok(err);
		assert.match(err!, /allowed_scope/);
	});

	it("rejects default-native ticket with empty allowed_scope", () => {
		const t = baseTicket({ allowed_scope: [] });
		delete (t as { execution?: string }).execution;
		const err = validateTicket(t);
		assert.ok(err);
		assert.match(err!, /native implementation ticket requires non-empty allowed_scope/);
	});

});

describe("worker_blocked trigger (blocked dependency path)", () => {
	it("worker_blocked event always requests Supervisor review", () => {
		const depBlocked = baseTicket({
			id: "child",
			status: "blocked",
			dependencies: ["missing-dep"],
			error: "missing dependency id(s) for child",
		});
		const t = evaluateTriggers({} as TaskBoard, { kind: "worker_blocked", ticket: depBlocked }, defaultConfig);
		assert.equal(t.review, true);
		assert.ok(t.reason);
		assert.match(t.reason!, /child|ブロック|block/i);
	});

	it("failed dependency style blocked ticket also triggers review", () => {
		const t = evaluateTriggers(
			{} as TaskBoard,
			{
				kind: "worker_blocked",
				ticket: baseTicket({
					id: "b",
					status: "blocked",
					error: "dependency not satisfied: a",
				}),
			},
			defaultConfig,
		);
		assert.equal(t.review, true);
	});
});


describe("initial Orchestrator plan process semantics", () => {
	const validPlan = JSON.stringify({
		summary: "valid JSON",
		tasks: [
			{
				id: "plan-1",
				goal: "work",
				deliverables: ["code"],
				acceptance: ["passes"],
				allowed_scope: ["src/**"],
				forbidden: [],
				dependencies: [],
			},
		],
	});

	it("rejects valid plan JSON when the Orchestrator exits nonzero", () => {
		const parsed = parseInitialPlanRun({ output: validPlan, exitCode: 9 }, 8);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /exit 9/);
	});

	it("accepts the same plan only on exit zero", () => {
		const parsed = parseInitialPlanRun({ output: validPlan, exitCode: 0 }, 8);
		assert.equal(parsed.ok, true);
		if (parsed.ok) assert.deepEqual(parsed.tickets.map((ticket) => ticket.id), ["plan-1"]);
	});
});

describe("did the work happen, and was it checked", () => {
	// Two questions, two answers. Folding them into one status is what made a finished
	// ticket with no verify configured report as "partial" — half-done about work that
	// was not half-done — and made a default install unable to ever say it finished.
	const boardOfTickets = (tickets: Ticket[]): TaskBoard => ({
		goal: "g",
		planSummary: "p",
		openQuestions: [],
		phase: "completed",
		reviewCount: 0,
		tickets,
	});

	it("no verify configured is unverified, and says how to fix it", () => {
		const v = computeRunVerification(boardOfTickets([baseTicket({ status: "completed" })]), {
			verifyConfigured: false,
			verifyMode: "per-ticket",
		});
		assert.equal(v.status, "unverified");
		assert.match(v.detail, /verify not configured/);
		assert.match(v.detail, /meta-loop-setup/);
	});

	it("every completed ticket passing its gate is a verified run", () => {
		const t = baseTicket({
			status: "completed",
			evidence: {
				processExitCode: 0,
				actualChangedFiles: [],
				scopeViolations: [],
				verify: { status: "passed" },
			},
		});
		const v = computeRunVerification(boardOfTickets([t]), {
			verifyConfigured: true,
			verifyMode: "per-ticket",
		});
		assert.equal(v.status, "verified");
	});

	it("a gate that ran and found a regression fails the run", () => {
		const t = baseTicket({
			status: "failed",
			evidence: {
				processExitCode: 0,
				actualChangedFiles: [],
				scopeViolations: [],
				verify: { status: "failed", failedCommand: ["npm", "test"] },
			},
		});
		const v = computeRunVerification(boardOfTickets([t]), {
			verifyConfigured: true,
			verifyMode: "per-ticket",
		});
		assert.equal(v.status, "failed");
		assert.match(v.detail, /npm test/);
	});

	it("a failed final gate fails the run without reassigning blame", () => {
		const t = baseTicket({ status: "completed" });
		const v = computeRunVerification(boardOfTickets([t]), {
			verifyConfigured: true,
			verifyMode: "final",
			finalVerify: { status: "failed", failedCommand: ["npm", "run", "typecheck"] },
		});
		assert.equal(v.status, "failed");
		// One gate over the whole plan cannot say which ticket broke what.
		assert.equal(t.status, "completed");
	});

	it("an already-red baseline leaves the run unverified, never verified", () => {
		const t = baseTicket({
			status: "completed",
			evidence: {
				processExitCode: 0,
				actualChangedFiles: [],
				scopeViolations: [],
				verify: { status: "failed", failedCommand: ["npm", "test"], preExisting: true },
			},
		});
		const v = computeRunVerification(boardOfTickets([t]), {
			verifyConfigured: true,
			verifyMode: "per-ticket",
		});
		assert.equal(v.status, "unverified");
		assert.match(v.detail, /baseline was already failing/);
	});

	it("nothing completed is nothing to verify", () => {
		const v = computeRunVerification(boardOfTickets([baseTicket({ status: "blocked" })]), {
			verifyConfigured: true,
			verifyMode: "per-ticket",
		});
		assert.equal(v.status, "unverified");
		assert.match(v.detail, /no completed tickets/);
	});
});

describe("what goes back into the conversation", () => {
	function bigBoard(): TaskBoard {
		return {
			goal: "harden everything",
			planSummary: "x".repeat(4000),
			openQuestions: [],
			phase: "completed",
			reviewCount: 2,
			verification: { status: "unverified", detail: "verify not configured" },
			tickets: Array.from({ length: 40 }, (_, i) =>
				baseTicket({
					id: `t${i}`,
					status: "completed",
					goal: "y".repeat(500),
					report: "z".repeat(5000),
					claim: { claimedStatus: "done", unresolved: ["w".repeat(400)] },
				}),
			),
		};
	}

	const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 1.5, turns: 4 };

	it("stays small enough to belong in a chat turn", () => {
		// The old summary put 8-25KB into the context of every run, most of it the
		// Worker's own prose — the one thing this harness does not take at face value.
		const digest = buildChatDigest({ board: bigBoard(), verdicts: [], usage, runId: "r1", status: "completed" });
		assert.ok(digest.length <= 2000, `digest was ${digest.length} chars`);
		assert.match(digest, /full report: .*summary\.md/);
		assert.match(digest, /usage: \$1\.50/);
	});

	it("warns unless the run both finished and was verified", () => {
		const unverified = buildChatDigest({
			board: { ...bigBoard(), verification: { status: "unverified", detail: "d" } },
			verdicts: [],
			usage,
			runId: "r1",
			status: "completed",
		});
		assert.match(unverified, /not a verified success/);

		const verified = buildChatDigest({
			board: { ...bigBoard(), verification: { status: "verified", detail: "d" } },
			verdicts: [],
			usage,
			runId: "r1",
			status: "completed",
		});
		assert.ok(!/not a verified success/.test(verified));
	});
});
