import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPath, matchRule } from "../src/evidence.ts";
import { validatePlanGraph, validateTicket, formatBoardForSupervisor, buildPrimarySummary } from "../src/runtime.ts";
import { generateFlowYaml } from "../src/sfh-exec.ts";
import type { TaskBoard, Ticket } from "../src/types.ts";
import { evaluateTriggers } from "../src/triggers.ts";
import { defaultConfig } from "../src/config.ts";

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

describe("sfh success path contract", () => {
	it("generateFlowYaml forces read access fields when provided", () => {
		const y = generateFlowYaml({
			name: "meta-loop-x",
			timeoutSec: 60,
			maxParallel: 2,
			defaultAccess: "read",
			branches: [{ id: "a", tool: "pi", access: "read", prompt: "p" }],
			integrationPrompt: "i {{steps.fanout.outputs}}",
			integrationAccess: "read",
		});
		assert.match(y, /access: read/);
		assert.doesNotMatch(y, /access: write/);
	});
});

describe("ticket validation", () => {
	it("rejects sfh without branches", () => {
		const err = validateTicket(baseTicket({ execution: "sfh" }));
		assert.ok(err);
	});
	it("rejects sfh without integration.acceptance", () => {
		const err = validateTicket(
			baseTicket({
				execution: "sfh",
				branches: [{ id: "a", prompt: "x" }],
			}),
		);
		assert.ok(err);
	});
	it("accepts valid sfh ticket", () => {
		const err = validateTicket(
			baseTicket({
				execution: "sfh",
				branches: [{ id: "a", prompt: "x" }],
				integration: { acceptance: ["ok"] },
			}),
		);
		assert.equal(err, null);
	});
});

describe("plan graph", () => {
	it("rejects missing dependency", () => {
		const err = validatePlanGraph([baseTicket({ dependencies: ["nope"] })]);
		assert.ok(err);
	});
	it("rejects cycles", () => {
		const err = validatePlanGraph([
			baseTicket({ id: "a", dependencies: ["b"], acceptance: ["x"] }),
			baseTicket({ id: "b", dependencies: ["a"], acceptance: ["x"] }),
		]);
		assert.ok(err);
	});
	it("rejects duplicate ids", () => {
		const err = validatePlanGraph([baseTicket({ id: "a" }), baseTicket({ id: "a" })]);
		assert.ok(err);
	});
	it("accepts dag", () => {
		const err = validatePlanGraph([
			baseTicket({ id: "a", acceptance: ["x"] }),
			baseTicket({ id: "b", dependencies: ["a"], acceptance: ["x"] }),
		]);
		assert.equal(err, null);
	});
});

describe("scope", () => {
	it("allows under prefix", () => {
		const r = checkPath("src/auth/x.ts", "/proj", ["src/auth/**"], []);
		assert.equal(r.ok, true);
	});
	it("denies outside", () => {
		const r = checkPath("src/other/x.ts", "/proj", ["src/auth/**"], []);
		assert.equal(r.ok, false);
	});
	it("matchRule directory", () => {
		assert.equal(matchRule("src/a/b", "/x/src/a/b", "src/a/**"), true);
	});
});

describe("triggers", () => {
	it("blocked is immediate", () => {
		const t = evaluateTriggers({} as any, { kind: "worker_blocked", ticket: baseTicket() }, defaultConfig);
		assert.equal(t.review, true);
	});
	it("out of scope is immediate", () => {
		const t = evaluateTriggers({} as any, { kind: "worker_out_of_scope", ticket: baseTicket() }, defaultConfig);
		assert.equal(t.review, true);
	});
	it("single failure not enough", () => {
		const t = evaluateTriggers(
			{} as any,
			{ kind: "worker_failed", ticket: baseTicket(), consecutiveFailures: 1 },
			defaultConfig,
		);
		assert.equal(t.review, false);
	});
});

describe("supervisor board payload", () => {
	it("includes acceptance and scopes", () => {
		const board: TaskBoard = {
			goal: "g",
			planSummary: "p",
			openQuestions: [],
			phase: "executing",
			reviewCount: 0,
			tickets: [baseTicket({ acceptance: ["test passes"], allowed_scope: ["src/**"] })],
		};
		const s = formatBoardForSupervisor(board);
		assert.match(s, /test passes/);
		assert.match(s, /allowed_scope/);
	});
});

describe("primary summary", () => {
	it("includes ticket details for model content", () => {
		const board: TaskBoard = {
			goal: "g",
			planSummary: "p",
			openQuestions: [],
			phase: "done",
			reviewCount: 1,
			tickets: [
				baseTicket({
					status: "done",
					claim: { claimedStatus: "done", changed_files: ["src/a.ts"], tests: ["ok"] },
					evidence: { processExitCode: 0, actualChangedFiles: ["src/a.ts"], scopeViolations: [] },
				}),
			],
		};
		const s = buildPrimarySummary(board, [{ verdict: "green", observations: [], risk: [], required_actions: [], optional_advice: [], affected_tasks: [], harness_suggestions: [] }]);
		assert.match(s, /changed_files \(observed\)/);
		assert.match(s, /src\/a\.ts/);
	});
});
