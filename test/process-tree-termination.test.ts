import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getProcessTreeTerminationSchedule } from "../src/process-tree-termination.ts";

describe("process-tree termination scheduling", () => {
	it("uses one immediate forced tree kill on Windows with no delayed second PID signal", () => {
		const schedule = getProcessTreeTerminationSchedule("win32", 3000);

		assert.deepEqual(schedule, [{ force: true, delayMs: 0 }]);
		assert.equal(schedule.length, 1);
	});

	it("retains immediate TERM then delayed owned-group KILL on POSIX", () => {
		for (const platform of ["linux", "darwin"] as const) {
			assert.deepEqual(getProcessTreeTerminationSchedule(platform, 3000), [
				{ force: false, delayMs: 0 },
				{ force: true, delayMs: 3000 },
			]);
		}
	});
});
