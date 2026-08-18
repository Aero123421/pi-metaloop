/**
 * The submission protocol.
 *
 * A role used to answer by printing a fenced JSON blob, and an unparseable answer
 * ended the run because the parent could not talk back to a process that had
 * already exited. These fix the replacement: a schema-checked tool call, a
 * rejection the model can act on, and a bounded number of tries.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_SUBMIT_ATTEMPTS,
	rejectionMessage,
	validateSubmission,
	SubmitPlanSchema,
	SubmitReportSchema,
	SubmitVerdictSchema,
} from "../src/role-io.ts";
import { validateSubmittedPlan } from "../src/plan-validation.ts";

function draft(over: Record<string, unknown> = {}) {
	return {
		id: "t1",
		goal: "do the thing",
		deliverables: ["src/thing.ts"],
		acceptance: ["src/thing.ts exists"],
		allowed_scope: ["src/**"],
		forbidden: [],
		dependencies: [],
		...over,
	};
}

const PLAN = { summary: "one slice", open_questions: [], tasks: [draft()] };

describe("submitted plan validation", () => {
	it("accepts a well-formed plan", () => {
		assert.deepEqual(validateSubmittedPlan(PLAN, { maxTasks: 8 }), []);
	});

	it("reports every violation at once, not just the first", () => {
		const errors = validateSubmittedPlan(
			{
				summary: "s",
				open_questions: [],
				tasks: [
					draft({ id: "a", allowed_scope: [] }),
					draft({ id: "b", dependencies: ["ghost"] }),
				],
			},
			{ maxTasks: 8 },
		);
		// One round-trip per violation would burn the whole submission budget.
		assert.ok(errors.length >= 2, `expected several errors, got ${JSON.stringify(errors)}`);
		assert.ok(errors.some((e) => /allowed_scope/.test(e)));
		assert.ok(errors.some((e) => /ghost/.test(e)));
	});

	it("enforces the ticket cap", () => {
		const tasks = Array.from({ length: 5 }, (_, i) => draft({ id: `t${i}` }));
		const errors = validateSubmittedPlan({ summary: "s", open_questions: [], tasks }, { maxTasks: 3 });
		assert.ok(errors.some((e) => /exceeds the cap of 3/.test(e)));
	});

	it("enforces the scope ceiling", () => {
		const errors = validateSubmittedPlan(PLAN, { maxTasks: 8, scopeCeiling: ["docs/**"] });
		assert.ok(errors.some((e) => /scopeCeiling/.test(e)));
	});

	it("refuses an empty plan", () => {
		assert.deepEqual(validateSubmittedPlan({ summary: "s", open_questions: [], tasks: [] }, { maxTasks: 8 }), [
			"plan has no tasks",
		]);
	});
});

describe("role submission gate", () => {
	it("only the Orchestrator's payload gets semantic checks", () => {
		// The verdict and report schemas are the whole contract for those roles.
		assert.deepEqual(validateSubmission("supervisor", { verdict: "green" }), []);
		assert.deepEqual(validateSubmission("worker", { status: "done" }), []);
	});

	it("reads the cap and ceiling from the environment the harness passes", () => {
		const env = { PI_META_LOOP_MAX_TASKS: "1", PI_META_LOOP_SCOPE_CEILING: '["docs/**"]' } as NodeJS.ProcessEnv;
		const errors = validateSubmission(
			"orchestrator",
			{ summary: "s", open_questions: [], tasks: [draft(), draft({ id: "t2" })] },
			env,
		);
		assert.ok(errors.some((e) => /exceeds the cap of 1/.test(e)));
		assert.ok(errors.some((e) => /scopeCeiling/.test(e)));
	});

	it("survives a malformed ceiling instead of failing the whole submission", () => {
		const env = { PI_META_LOOP_MAX_TASKS: "8", PI_META_LOOP_SCOPE_CEILING: "not json" } as NodeJS.ProcessEnv;
		assert.deepEqual(validateSubmission("orchestrator", PLAN, env), []);
	});

	it("the rejection tells the model what to do and how many tries remain", () => {
		const msg = rejectionMessage(["t1: no scope", "t2: bad dep"], 2);
		assert.match(msg, new RegExp(`attempt 2/${MAX_SUBMIT_ATTEMPTS}`));
		assert.match(msg, /- t1: no scope/);
		assert.match(msg, /- t2: bad dep/);
		assert.match(msg, /call the tool again/i);
	});
});

describe("submission schemas", () => {
	it("a ticket must declare acceptance and a write scope", () => {
		const props = (SubmitPlanSchema as any).properties.tasks.items.properties;
		assert.equal(props.acceptance.minItems, 1);
		// Same rule as validateTicket, enforced one layer earlier so the failure is cheaper.
		assert.equal(props.allowed_scope.minItems, 1);
	});

	it("verdict and status are closed sets", () => {
		const verdict = (SubmitVerdictSchema as any).properties.verdict;
		const status = (SubmitReportSchema as any).properties.status;
		assert.deepEqual(verdict.enum ?? verdict.anyOf?.map((v: any) => v.const), ["green", "yellow", "red"]);
		assert.deepEqual(status.enum ?? status.anyOf?.map((v: any) => v.const), ["done", "partial", "blocked"]);
	});
});
