/**
 * Regressions found by review of the fix PR itself. Each of these was a real
 * defect the first pass introduced (or, for the symlink case, a pre-existing
 * hole the first pass had started relying on).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildConfigFromLayers } from "../src/config.ts";
import { checkPath, scopeRulesOutsideCeiling } from "../src/evidence.ts";
import { applyFinalVerify, canRunSupervisorAudit, finalizeFromEvidence, validateTicket } from "../src/runtime.ts";
import type { ExecutionEvidence, Ticket, VerifyEvidence, WorkerClaim } from "../src/types.ts";

function ticket(scope = ["src/**"]): Ticket {
	return {
		id: "t1",
		goal: "g",
		deliverables: [],
		acceptance: ["a"],
		allowed_scope: scope,
		forbidden: [],
		dependencies: [],
		status: "running",
	};
}

describe("a dangling symlink cannot smuggle a write out of scope", () => {
	const setup = () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ml-symlink-")));
		const cwd = path.join(root, "project");
		fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
		fs.mkdirSync(path.join(cwd, "node_modules", ".bin"), { recursive: true });
		fs.mkdirSync(path.join(root, "sibling"), { recursive: true });
		return { root, cwd };
	};

	it("blocks a dangling link pointing outside the project", () => {
		const { root, cwd } = setup();
		try {
			// The target does not exist, so an existsSync-based walk steps straight
			// past the link and judges the path by its parent directory instead.
			fs.symlinkSync("../../sibling/pwned.txt", path.join(cwd, "src", "out.ts"));
			const result = checkPath("src/out.ts", cwd, ["src/**"], []);
			assert.equal(result.ok, false);
			assert.match((result as { reason: string }).reason, /outside project cwd/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks a dangling link pointing into an unswept directory", () => {
		const { root, cwd } = setup();
		try {
			fs.symlinkSync("../node_modules/.bin/pwned", path.join(cwd, "src", "hook.ts"));
			const result = checkPath("src/hook.ts", cwd, ["src/**"], []);
			assert.equal(result.ok, false);
			assert.match((result as { reason: string }).reason, /outside allowed_scope/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still allows ordinary in-scope writes, including missing deep paths", () => {
		const { root, cwd } = setup();
		try {
			fs.writeFileSync(path.join(cwd, "src", "real.ts"), "x");
			assert.deepEqual(checkPath("src/real.ts", cwd, ["src/**"], []), { ok: true });
			assert.deepEqual(checkPath("src/new/deep/x.ts", cwd, ["src/**"], []), { ok: true });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("a project layer cannot disarm the write-scope ceiling", () => {
	it("an empty ceiling is deny-all, not unrestricted", () => {
		assert.deepEqual(scopeRulesOutsideCeiling(["**"], undefined), [], "undefined = no ceiling");
		assert.deepEqual(scopeRulesOutsideCeiling(["src/a", "**"], []), ["src/a", "**"]);
		assert.match(validateTicket(ticket(["src/a"]), []) ?? "", /outside limits\.scopeCeiling/);
	});

	it("a disjoint project ceiling fails closed instead of removing the user's", () => {
		// Narrowing to a non-overlapping set intersects to []. Reading that as
		// "no ceiling" would let an untrusted layer switch the control off by
		// simply disagreeing with it.
		const cfg = buildConfigFromLayers(
			[{ limits: { scopeCeiling: ["src/**"] } }],
			[{ limits: { scopeCeiling: ["src/**/*"] } }],
		);
		assert.deepEqual(cfg.limits.scopeCeiling, []);
		assert.match(validateTicket(ticket(["**"]), cfg.limits.scopeCeiling) ?? "", /outside limits\.scopeCeiling/);
	});
});

describe("untrusted layers cannot weaken supervision or the evidence sweep", () => {
	it("a project cannot change the audit budget in either direction", () => {
		const lowered = buildConfigFromLayers(
			[{ limits: { maxSupervisions: 12 } }],
			[{ limits: { maxSupervisions: 1 } }],
		);
		assert.equal(lowered.limits.maxSupervisions, 12);

		const raised = buildConfigFromLayers(
			[{ limits: { maxSupervisions: 4 } }],
			[{ limits: { maxSupervisions: 20 } }],
		);
		assert.equal(raised.limits.maxSupervisions, 4);
	});

	it("the mid-run budget applies to every re-audit call", () => {
		assert.equal(canRunSupervisorAudit("mid", 0, 1), true);
		assert.equal(canRunSupervisorAudit("mid", 1, 1), false);
		assert.equal(canRunSupervisorAudit("initial", 1, 1), true);
		assert.equal(canRunSupervisorAudit("final", 1, 1), true);
	});

	it("a project cannot change evidence bounds in either direction", () => {
		const base = buildConfigFromLayers([{ evidence: { parentMaxDepth: 1, timeoutMs: 20_000 } }]);
		assert.equal(base.evidence.parentMaxDepth, 1);

		// Widening is a synchronous-I/O hang and a path-disclosure channel;
		// narrowing weakens detection. Neither belongs to the untrusted layer.
		const attacked = buildConfigFromLayers(
			[{ evidence: { parentMaxDepth: 1, timeoutMs: 20_000 } }],
			[{ evidence: { ignoreDirNames: [], parentMaxDepth: 8, maxEntries: 5_000_000, timeoutMs: 600_000 } }],
		);
		assert.equal(attacked.evidence.parentMaxDepth, 1);
		assert.equal(attacked.evidence.timeoutMs, 20_000);
		assert.deepEqual(attacked.evidence.ignoreDirNames, base.evidence.ignoreDirNames);
	});
});

describe("inconclusive outcomes are not progress", () => {
	const claimDone: WorkerClaim = { claimedStatus: "done" };
	const evidence = (verify: VerifyEvidence): ExecutionEvidence => ({
		processExitCode: 0,
		actualChangedFiles: [],
		scopeViolations: [],
		verify,
	});

	it("a pre-existing failure is not charged to the ticket", () => {
		const t = ticket();
		const failing: VerifyEvidence = { status: "failed", failedCommand: ["npm", "test"] };
		finalizeFromEvidence(t, claimDone, evidence(failing), {
			baseline: { status: "failed", signature: JSON.stringify(["npm", "test"]) },
		});
		// The command was already red before this ticket ran, so the ticket did its work.
		// Whether the run as a whole is trustworthy is answered by computeRunVerification.
		assert.equal(t.status, "completed");
		assert.match(t.error ?? "", /already failing when the run started/);
	});

	it("an aborted verify does not demote a ticket that finished", () => {
		const t = ticket();
		finalizeFromEvidence(t, claimDone, evidence({ status: "aborted" }));
		assert.equal(t.status, "completed");
	});

	it("leaves an ordinary worker-reported partial as real progress", () => {
		const t = ticket();
		finalizeFromEvidence(t, { claimedStatus: "partial" }, evidence({ status: "unset" }));
		assert.equal(t.status, "partial");
		assert.notEqual(t.evidence?.inconclusive, true);
	});

	it("a deferred final-verify ticket records the wait on the evidence", () => {
		const t = ticket();
		finalizeFromEvidence(t, claimDone, evidence({ status: "unset" }), { mode: "final" });
		assert.equal(t.status, "completed");
		assert.notEqual(t.evidence?.inconclusive, true);
	});

	it("the shared final verify records itself without reassigning blame", () => {
		// One gate covering the whole plan cannot say which ticket broke what, so it must
		// not mark each waiting ticket failed just because the tree ended red.
		const aborted = ticket();
		aborted.status = "completed";
		applyFinalVerify(aborted, { status: "aborted", reason: "stopped" });
		assert.equal(aborted.status, "completed");
		assert.equal(aborted.evidence?.verify?.status, "aborted");

		const preExisting = ticket();
		preExisting.status = "completed";
		applyFinalVerify(preExisting, {
			status: "failed",
			failedCommand: ["npm", "test"],
			preExisting: true,
		});
		assert.equal(preExisting.status, "completed");
		assert.equal(preExisting.evidence?.verify?.preExisting, true);
	});
});
