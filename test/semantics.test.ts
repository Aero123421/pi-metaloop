/**
 * P0 terminal / claim / evidence / trigger semantics (pure-function level).
 * Spec follow-up for adversarial review — not assertion weakening.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyVerdict,
	finalizeFromEvidence,
	mergeRevisedTickets,
	parseInitialPlanRun,
	resolveTerminalPhase,
	sfhStatusFromResult,
	sfhWriteRequiresAllowedScope,
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
	// Old harness expected done+partial → "done". Partial is no longer full success.
	it("done+partial → incomplete (was done under pre-P0 expectation)", () => {
		assert.equal(resolveTerminalPhase(boardOf(["done", "partial"]), false), "incomplete");
	});

	it("all done → done", () => {
		assert.equal(resolveTerminalPhase(boardOf(["done", "done"]), false), "done");
	});

	it("any failed/blocked/partial without full success → incomplete", () => {
		assert.equal(resolveTerminalPhase(boardOf(["done", "failed"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["blocked"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["partial", "partial"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["done", "cancelled"]), false), "incomplete");
	});

	it("pending/running → incomplete (not fake done)", () => {
		assert.equal(resolveTerminalPhase(boardOf(["done", "pending"]), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["running"]), false), "incomplete");
	});

	it("empty tickets → plan_failed; abort → stopped; locked phases kept", () => {
		assert.equal(resolveTerminalPhase(boardOf([], "planning"), false), "plan_failed");
		assert.equal(resolveTerminalPhase(boardOf(["done"]), true), "stopped");
		assert.equal(resolveTerminalPhase(boardOf(["done"], "degraded"), false), "degraded");
		assert.equal(resolveTerminalPhase(boardOf(["done"], "stopped"), false), "stopped");
		assert.equal(resolveTerminalPhase(boardOf(["done"], "plan_failed"), false), "plan_failed");
	});

	it("final-review phase does not lock: evidence drives terminal incomplete/done", () => {
		// After Supervisor final audit label, resolveTerminalPhase still applies ticket evidence.
		assert.equal(resolveTerminalPhase(boardOf(["done", "partial"], "final-review"), false), "incomplete");
		assert.equal(resolveTerminalPhase(boardOf(["done", "done"], "final-review"), false), "done");
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

	it("exit 0 + claim done → done; exit 0 + claim partial → partial", () => {
		const doneT = baseTicket({ status: "running" });
		finalizeFromEvidence(doneT, claim({ claimedStatus: "done" }), evidence({ processExitCode: 0 }));
		assert.equal(doneT.status, "done");

		const partT = baseTicket({ status: "running" });
		finalizeFromEvidence(partT, claim({ claimedStatus: "partial" }), evidence({ processExitCode: 0 }));
		assert.equal(partT.status, "partial");
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

	it("sfh ticket may omit allowed_scope when branches+integration present (read path)", () => {
		const err = validateTicket(
			baseTicket({
				execution: "sfh",
				allowed_scope: [],
				branches: [{ id: "a", prompt: "work" }],
				integration: { acceptance: ["merged"] },
			}),
		);
		assert.equal(err, null);
	});

	it("sfh ticket with explicit write/full branch.access requires non-empty allowed_scope", () => {
		for (const access of ["write", "full"] as const) {
			const err = validateTicket(
				baseTicket({
					execution: "sfh",
					allowed_scope: [],
					branches: [{ id: "a", prompt: "work", access }],
					integration: { acceptance: ["merged"] },
				}),
			);
			assert.ok(err, access);
			assert.match(err!, /allowed_scope/i, access);
		}
	});

	it("sfhWriteRequiresAllowedScope blocks config-resolved write/full with empty scope", () => {
		assert.ok(sfhWriteRequiresAllowedScope("write", []));
		assert.ok(sfhWriteRequiresAllowedScope("full", undefined));
		assert.equal(sfhWriteRequiresAllowedScope("read", []), null);
		assert.equal(sfhWriteRequiresAllowedScope("write", ["src/**"]), null);
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

describe("Supervisor yellow fail-closed semantics", () => {
	it("yellow with empty or whitespace-only guidance stops", () => {
		assert.deepEqual(classifyVerdict(verdict("yellow")), {
			action: "stop",
			guidance: [],
			reason: "yellow-without-guidance",
		});
		assert.equal(
			classifyVerdict(verdict("yellow", { required_actions: ["  "], orchestrator_guidance: [""] })).action,
			"stop",
		);
	});

	it("required yellow revision cannot continue until a green re-audit", () => {
		assert.equal(
			classifyVerdict(verdict("yellow", { required_actions: ["tighten acceptance"] })).action,
			"revise",
		);
		// Another yellow still revises/stops; only green can release execution.
		assert.notEqual(
			classifyVerdict(verdict("yellow", { orchestrator_guidance: ["revise again"] })).action,
			"continue",
		);
		assert.equal(classifyVerdict(verdict("green")).action, "continue");
	});

	it("a final yellow cannot resolve an all-done board to done", () => {
		const finalBoard = boardOf(["done"], "final-review");
		const disposition = classifyVerdict(verdict("yellow"));
		assert.equal(disposition.action, "stop");
		finalBoard.phase = "stopped";
		assert.equal(resolveTerminalPhase(finalBoard, false), "stopped");
	});
});

describe("material yellow revision and maxTasks ceiling", () => {
	it("rejects an unchanged echo of pending work", () => {
		const pending = baseTicket({ id: "pending", status: "pending" });
		assert.equal(mergeRevisedTickets([pending], [{ ...pending }], 2), null);
	});

	it("rejects an all-completed echo and cannot become done through no-op revision→green", () => {
		const completed = baseTicket({ id: "done", status: "done" });
		const finalBoard = boardOf(["done"], "final-review");
		assert.equal(mergeRevisedTickets([completed], [{ ...completed }], 2), null);
		// Production control treats a failed required revision as terminal; a later
		// green classification cannot retroactively release that stopped board.
		finalBoard.phase = "stopped";
		assert.equal(classifyVerdict(verdict("green")).action, "continue");
		assert.equal(resolveTerminalPhase(finalBoard, false), "stopped");
	});

	it("accepts a real pending remediation ticket and stays incomplete after final re-audit", () => {
		const completed = baseTicket({ id: "done", status: "done" });
		const revised = mergeRevisedTickets(
			[completed],
			[completed, baseTicket({ id: "remediate", goal: "fix final review finding" })],
			2,
		);
		assert.ok(revised);
		assert.equal(revised[0], completed);
		assert.deepEqual(revised.map((ticket) => ticket.status), ["done", "pending"]);
		const finalBoard = boardOf([], "final-review");
		finalBoard.tickets = revised;
		assert.equal(resolveTerminalPhase(finalBoard, false), "incomplete");
	});

	it("accepts a material modification to existing pending work", () => {
		const pending = baseTicket({ id: "pending", status: "pending", acceptance: ["old"] });
		const revised = mergeRevisedTickets(
			[pending],
			[{ ...pending, acceptance: ["old", "new remediation check"] }],
			1,
		);
		assert.ok(revised);
		assert.deepEqual(revised[0].acceptance, ["old", "new remediation check"]);
	});

	it("counts frozen tickets inside the total ceiling and rejects overflow", () => {
		const current = [
			baseTicket({ id: "done-1", status: "done" }),
			baseTicket({ id: "done-2", status: "failed" }),
			baseTicket({ id: "pending-old", status: "pending" }),
		];
		const raw = [
			{ ...current[0], goal: "must not rewrite frozen" },
			{ ...current[1] },
			{ ...current[2], id: "pending-a" },
			{ ...current[2], id: "pending-b" },
		];
		assert.equal(mergeRevisedTickets(current, raw, 3), null);

		const revised = mergeRevisedTickets(current, raw.slice(0, 3), 3);
		assert.ok(revised);
		assert.deepEqual(revised.map((ticket) => ticket.id), ["done-1", "done-2", "pending-a"]);
		assert.equal(revised[0], current[0]);
		assert.equal(revised[1], current[1]);
	});

	it("requires pending remediation capacity when every ticket is frozen", () => {
		const completed = [
			baseTicket({ id: "done-1", status: "done" }),
			baseTicket({ id: "done-2", status: "done" }),
		];
		assert.equal(
			mergeRevisedTickets(completed, [baseTicket({ id: "remediate" })], 2),
			null,
		);
	});

	it("preserves running tickets as non-pending and never exceeds maxTasks", () => {
		const running = baseTicket({ id: "running", status: "running" });
		const revised = mergeRevisedTickets(
			[running, baseTicket({ id: "pending", status: "pending" })],
			[baseTicket({ id: "replacement" })],
			2,
		);
		assert.ok(revised);
		assert.equal(revised.length, 2);
		assert.equal(revised[0], running);
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

describe("sfh empty output never done (production classifier)", () => {
	// Exercise the helper used by executeGroupTicket; do not mirror runtime logic here.
	it("exit 0 + empty/whitespace stdout → partial", () => {
		assert.equal(sfhStatusFromResult(0, "", []), "partial");
		assert.equal(sfhStatusFromResult(0, "   \n\t  ", []), "partial");
	});

	it("exit 0 + non-empty stdout + clean scope → done", () => {
		assert.equal(sfhStatusFromResult(0, "integration ok", []), "done");
	});

	it("exit 0 + scope violations → failed (even with stdout)", () => {
		assert.equal(sfhStatusFromResult(0, "ok", ["leak.ts"]), "failed");
	});

	it("nonzero exit → failed", () => {
		assert.equal(sfhStatusFromResult(1, "partial output", []), "failed");
		assert.equal(sfhStatusFromResult(1, "", []), "failed");
	});

	it("empty-stdout path composed with resolveTerminalPhase is incomplete, not done", () => {
		// Board with only sfh-empty-style partial ticket must not resolve to done.
		const board = boardOf(["partial"], "final-review");
		assert.equal(resolveTerminalPhase(board, false), "incomplete");
		// finalizeFromEvidence path for empty-claim also stays non-done
		const ticket = baseTicket({ status: "running" });
		finalizeFromEvidence(
			ticket,
			claim({ claimedStatus: "partial", notes: "sfh empty stdout" }),
			evidence({ processExitCode: 0 }),
		);
		assert.equal(ticket.status, "partial");
		assert.notEqual(ticket.status, "done");
	});
});
