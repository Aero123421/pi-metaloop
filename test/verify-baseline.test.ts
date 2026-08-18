import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AWAITING_FINAL_VERIFY,
	finalizeFromEvidence,
} from "../src/runtime.ts";
import { isPreExistingFailure, toVerifyBaseline, verifySignature } from "../src/verify.ts";
import type { ExecutionEvidence, Ticket, VerifyEvidence, WorkerClaim } from "../src/types.ts";

function ticket(): Ticket {
	return {
		id: "t1",
		goal: "g",
		deliverables: [],
		acceptance: ["a"],
		allowed_scope: ["src/**"],
		forbidden: [],
		dependencies: [],
		status: "running",
	};
}

const claimDone: WorkerClaim = { claimedStatus: "done" };

function evidence(verify: VerifyEvidence): ExecutionEvidence {
	return { processExitCode: 0, actualChangedFiles: [], scopeViolations: [], verify };
}

const failedNpmTest: VerifyEvidence = {
	status: "failed",
	failedCommand: ["npm", "test"],
	reason: "controller verify failed (exit 1): npm test",
};

describe("verify baseline attribution", () => {
	it("still fails a ticket when the run started green", () => {
		const t = ticket();
		const baseline = toVerifyBaseline({ status: "passed" });
		finalizeFromEvidence(t, claimDone, evidence(failedNpmTest), { baseline });
		assert.equal(t.status, "failed");
	});

	it("does not blame a ticket for a failure the run started with", () => {
		const t = ticket();
		const baseline = toVerifyBaseline(failedNpmTest);
		finalizeFromEvidence(t, claimDone, evidence(failedNpmTest), { baseline });
		assert.equal(t.status, "partial");
		assert.match(t.error ?? "", /already failing when the run started/);
	});

	it("still fails when a different command breaks", () => {
		const t = ticket();
		const baseline = toVerifyBaseline(failedNpmTest);
		const typecheckBroke: VerifyEvidence = {
			status: "failed",
			failedCommand: ["npm", "run", "typecheck"],
			reason: "controller verify failed (exit 2): npm run typecheck",
		};
		finalizeFromEvidence(t, claimDone, evidence(typecheckBroke), { baseline });
		assert.equal(t.status, "failed");
	});

	it("pre-existing attribution never authorizes done", () => {
		const t = ticket();
		const baseline = toVerifyBaseline(failedNpmTest);
		finalizeFromEvidence(t, claimDone, evidence(failedNpmTest), { baseline });
		assert.notEqual(t.status, "done");
	});

	it("requires a baseline that actually failed", () => {
		assert.equal(isPreExistingFailure(failedNpmTest, { status: "passed" }), false);
		assert.equal(isPreExistingFailure(failedNpmTest, undefined), false);
		// No failedCommand means no comparable signature — fail closed to "attributed".
		assert.equal(
			isPreExistingFailure({ status: "failed" }, { status: "failed", signature: undefined }),
			false,
		);
	});

	it("signature is the failing argv", () => {
		assert.equal(verifySignature(failedNpmTest), JSON.stringify(["npm", "test"]));
		assert.equal(verifySignature({ status: "passed" }), undefined);
	});

	it("an aborted verify is inconclusive, not a ticket failure", () => {
		const t = ticket();
		finalizeFromEvidence(t, claimDone, evidence({ status: "aborted", reason: "stopped" }));
		assert.equal(t.status, "partial");
	});

	it("a timeout is still charged to the ticket", () => {
		const t = ticket();
		finalizeFromEvidence(
			t,
			claimDone,
			evidence({ status: "timeout", failedCommand: ["npm", "test"], reason: "timed out" }),
		);
		assert.equal(t.status, "failed");
	});
});

describe("verifyMode=final defers the gate", () => {
	it("marks a claimed-done ticket as awaiting the final verify", () => {
		const t = ticket();
		finalizeFromEvidence(
			t,
			claimDone,
			evidence({ status: "unset", reason: "deferred: executor.verifyMode=final" }),
			{ mode: "final" },
		);
		assert.equal(t.status, "partial");
		assert.equal(t.error, AWAITING_FINAL_VERIFY);
	});

	it("per-ticket mode keeps the original unset message", () => {
		const t = ticket();
		finalizeFromEvidence(t, claimDone, evidence({ status: "unset", reason: "not configured" }));
		assert.equal(t.status, "partial");
		assert.notEqual(t.error, AWAITING_FINAL_VERIFY);
	});

	it("deferral never turns a scope violation into a pending promotion", () => {
		const t = ticket();
		finalizeFromEvidence(
			t,
			claimDone,
			{
				processExitCode: 0,
				actualChangedFiles: ["etc/passwd"],
				scopeViolations: ["etc/passwd: outside allowed_scope"],
				verify: { status: "unset" },
			},
			{ mode: "final" },
		);
		assert.equal(t.status, "failed");
		assert.notEqual(t.error, AWAITING_FINAL_VERIFY);
	});
});
