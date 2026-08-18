/**
 * Resuming a run.
 *
 * Long tasks fail partway — that is what makes them long tasks. Before this, a run
 * that died at ticket 5 of 6 could only be started over, which re-planned from
 * scratch and redid the work that had succeeded. The board and the evidence were on
 * disk the whole time; only the way back in was missing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareResume, priorAttemptsNote } from "../src/runtime.ts";
import type { TaskBoard, Ticket } from "../src/types.ts";

function ticket(over: Partial<Ticket> = {}): Ticket {
	return {
		id: "t1",
		goal: "g",
		deliverables: [],
		acceptance: ["a"],
		allowed_scope: ["src/**"],
		forbidden: [],
		dependencies: [],
		status: "pending",
		...over,
	};
}

function board(tickets: Ticket[]): TaskBoard {
	return {
		goal: "ship it",
		planSummary: "one slice",
		openQuestions: [],
		phase: "incomplete",
		reviewCount: 1,
		verification: { status: "unverified", detail: "stale" },
		tickets,
	};
}

describe("preparing a board for a second run", () => {
	it("retries what did not finish and leaves finished work alone", () => {
		const b = board([
			ticket({ id: "t1", status: "completed" }),
			ticket({ id: "t2", status: "failed", error: "verify failed" }),
			ticket({ id: "t3", status: "blocked", error: "dependency t2" }),
			ticket({ id: "t4", status: "pending" }),
		]);
		const r = prepareResume(b, { runId: "old" });

		assert.deepEqual(r.retrying, ["t2", "t3"]);
		const byId = new Map(r.board.tickets.map((t) => [t.id, t]));
		// Redoing work that succeeded is how a "retry" quietly undoes it.
		assert.equal(byId.get("t1")!.status, "completed");
		assert.equal(byId.get("t2")!.status, "pending");
		assert.equal(byId.get("t3")!.status, "pending");
		assert.equal(byId.get("t4")!.status, "pending");
		assert.equal(r.board.phase, "executing");
	});

	it("keeps what each retried ticket already tried", () => {
		const b = board([ticket({ id: "t2", status: "failed", error: "verify failed" })]);
		const r = prepareResume(b, { runId: "run-a" });
		const t = r.board.tickets[0]!;
		assert.equal(t.attempts?.length, 1);
		assert.equal(t.attempts?.[0]?.status, "failed");
		assert.equal(t.attempts?.[0]?.error, "verify failed");
		assert.equal(t.attempts?.[0]?.runId, "run-a");
		// The live error is cleared; the record of it is not.
		assert.equal(t.error, undefined);
	});

	it("accumulates attempts across repeated resumes", () => {
		let b = board([ticket({ id: "t2", status: "failed", error: "first" })]);
		b = prepareResume(b, { runId: "r1" }).board;
		b.tickets[0]!.status = "failed";
		b.tickets[0]!.error = "second";
		const r = prepareResume(b, { runId: "r2" });
		assert.equal(r.board.tickets[0]!.attempts?.length, 2);
		assert.deepEqual(
			r.board.tickets[0]!.attempts?.map((a) => a.error),
			["first", "second"],
		);
	});

	it("refuses to resume a run with nothing left to do", () => {
		const r = prepareResume(board([ticket({ id: "t1", status: "completed" })]));
		assert.equal(r.retrying.length, 0);
		assert.match(r.reason ?? "", /nothing to resume/);
	});

	it("drops the previous run's verification instead of carrying it forward", () => {
		const r = prepareResume(board([ticket({ id: "t2", status: "failed" })]));
		// The old verdict describes work that is about to change.
		assert.equal(r.board.verification, undefined);
	});

	it("a cancelled plan can be resumed; an untouched pending ticket is not an attempt", () => {
		const r = prepareResume(
			board([ticket({ id: "t1", status: "cancelled", error: "plan not approved" }), ticket({ id: "t2" })]),
		);
		assert.deepEqual(r.retrying, ["t1"]);
		assert.equal(r.board.tickets[1]!.attempts, undefined);
	});
});

describe("what a retried worker is told", () => {
	it("says nothing on a first attempt", () => {
		assert.equal(priorAttemptsNote(ticket()), "");
	});

	it("names what failed so the worker does not repeat it", () => {
		const t = ticket({
			attempts: [
				{ startedAt: "a", finishedAt: "b", status: "failed", error: "typecheck: missing export" },
			],
		});
		const note = priorAttemptsNote(t);
		assert.match(note, /Previous attempts/);
		assert.match(note, /typecheck: missing export/);
		assert.match(note, /Do not repeat the approach that failed/);
	});

	it("keeps only the most recent attempts", () => {
		const t = ticket({
			attempts: Array.from({ length: 6 }, (_, i) => ({
				startedAt: "a",
				finishedAt: "b",
				status: "failed" as const,
				error: `err${i}`,
			})),
		});
		const note = priorAttemptsNote(t);
		assert.ok(!note.includes("err0"), "an old attempt should not crowd out the recent one");
		assert.match(note, /err5/);
	});
});
