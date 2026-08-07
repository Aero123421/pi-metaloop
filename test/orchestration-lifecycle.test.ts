import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decideAbortWait,
	waitForSettlement,
} from "../src/orchestration-lifecycle.ts";

describe("bounded orchestration abort lifecycle", () => {
	it("retains active state and owner lock after a timeout", () => {
		assert.deepEqual(decideAbortWait("timed_out"), {
			settled: false,
			retainActive: true,
			retainOwnerLock: true,
			canStartReplacement: false,
		});
	});

	it("allows replacement only after confirmed settlement", () => {
		assert.deepEqual(decideAbortWait("settled"), {
			settled: true,
			retainActive: false,
			retainOwnerLock: false,
			canStartReplacement: true,
		});
	});

	it("recognizes both fulfillment and rejection as settlement", async () => {
		assert.equal(await waitForSettlement(Promise.resolve(), 100), "settled");
		assert.equal(await waitForSettlement(Promise.reject(new Error("expected")), 100), "settled");
	});

	it("reports timeout while a run promise can still execute", async () => {
		let resolveRun!: () => void;
		const run = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});

		assert.equal(await waitForSettlement(run, 5), "timed_out");
		resolveRun();
		assert.equal(await waitForSettlement(run, 100), "settled");
	});
});
