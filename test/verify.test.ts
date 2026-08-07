import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runControllerVerify, unsetVerifyEvidence, verifyAllowsDone } from "../src/verify.ts";

describe("controller trusted verify", () => {
	it("unset when commands missing or empty", async () => {
		const a = await runControllerVerify({ cwd: process.cwd() });
		assert.equal(a.status, "unset");
		assert.equal(verifyAllowsDone(a), false);

		const b = await runControllerVerify({ cwd: process.cwd(), commands: [] });
		assert.equal(b.status, "unset");
		assert.equal(verifyAllowsDone(unsetVerifyEvidence()), false);
	});

	it("passes a successful argv sequence (no shell)", async () => {
		const result = await runControllerVerify({
			cwd: process.cwd(),
			commands: [[process.execPath, "-e", "process.exit(0)"]],
			timeoutSec: 30,
		});
		assert.equal(result.status, "passed");
		assert.equal(result.exitCode, 0);
		assert.equal(verifyAllowsDone(result), true);
	});

	it("fails on non-zero exit and records evidence", async () => {
		const result = await runControllerVerify({
			cwd: process.cwd(),
			commands: [[process.execPath, "-e", "process.exit(7)"]],
			timeoutSec: 30,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.exitCode, 7);
		assert.match(result.reason ?? "", /exit 7/);
		assert.equal(verifyAllowsDone(result), false);
	});

	it("times out a hanging command within budget", async () => {
		const result = await runControllerVerify({
			cwd: process.cwd(),
			commands: [[process.execPath, "-e", "setInterval(() => {}, 60_000)"]],
			timeoutSec: 1,
		});
		assert.equal(result.status, "timeout");
		assert.equal(result.timedOut, true);
		assert.equal(verifyAllowsDone(result), false);
	});

	it("fail-fast: later commands skipped after first failure", async () => {
		const result = await runControllerVerify({
			cwd: process.cwd(),
			commands: [
				[process.execPath, "-e", "process.exit(1)"],
				[process.execPath, "-e", "require('fs').writeFileSync('should-not-run','x')"],
			],
			timeoutSec: 30,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.commands?.length, 2);
		assert.match(result.output ?? "", /exit 1/);
	});

	it("pre-aborted signal does not spawn", async () => {
		const ac = new AbortController();
		ac.abort();
		const result = await runControllerVerify({
			cwd: process.cwd(),
			commands: [[process.execPath, "-e", "process.exit(0)"]],
			signal: ac.signal,
			timeoutSec: 30,
		});
		assert.equal(result.status, "aborted");
		assert.equal(verifyAllowsDone(result), false);
	});
});
