import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPath, matchRule, deltaChangedFiles, ticketChangedFiles } from "../src/evidence.ts";
import {
	validatePlanGraph,
	validateTicket,
	formatBoardForSupervisor,
	buildPrimarySummary,
	resolveTerminalPhase,
	sfhWriteRequiresAllowedScope,
	sfhMutatingAccessUnsupported,
} from "../src/runtime.ts";
import { runElapsed, runStatusFromPhase } from "../src/board-store.ts";
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
	it("rejects sfh write/full without OS sandbox at plan and execute gates", () => {
		for (const access of ["write", "full"] as const) {
			const err = validateTicket(
				baseTicket({
					execution: "sfh",
					allowed_scope: ["src/**"],
					branches: [{ id: "a", prompt: "x", access }],
					integration: { acceptance: ["ok"] },
				}),
			);
			assert.ok(err, access);
			assert.match(err!, /sandbox|write\/full|unsupported/i, access);
		}
		assert.ok(sfhMutatingAccessUnsupported("write"));
		assert.ok(sfhMutatingAccessUnsupported("full"));
		assert.equal(sfhMutatingAccessUnsupported("read"), null);
		// Defense-in-depth: empty scope still rejected if mutating access ever reached this gate.
		assert.ok(sfhWriteRequiresAllowedScope("full", []));
		assert.equal(sfhWriteRequiresAllowedScope("full", ["src/**"]), null);
	});
	// P0 fail-closed: empty write scope must not run as native implementation work
	it("rejects native ticket with empty allowed_scope", () => {
		const err = validateTicket(baseTicket({ execution: "native", allowed_scope: [] }));
		assert.ok(err);
		assert.match(err!, /allowed_scope/);
	});
	it("rejects native ticket when allowed_scope omitted (defaults empty)", () => {
		const t = baseTicket();
		t.allowed_scope = [];
		delete (t as { execution?: string }).execution;
		const err = validateTicket(t);
		assert.ok(err);
		assert.match(err!, /allowed_scope/);
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
		assert.equal(matchRule("src/a", "/x/src/a", "src/a/**"), true);
	});

	it("matches globstar segments and their directory entries", () => {
		const rule = "crates/**/tests/**";
		assert.equal(matchRule("crates/ownmesh-broker/tests", "/p/crates/ownmesh-broker/tests", rule), true);
		assert.equal(matchRule("crates/ownmesh-broker/tests/", "/p/crates/ownmesh-broker/tests/", rule), true);
		assert.equal(
			matchRule("crates/ownmesh-broker/tests/security_boundary.rs", "/p/crates/ownmesh-broker/tests/security_boundary.rs", rule),
			true,
		);
		assert.equal(matchRule("crates/ownmesh-broker/src/lib.rs", "/p/crates/ownmesh-broker/src/lib.rs", rule), false);
	});

	it("supports single-star path segments", () => {
		assert.equal(matchRule("crates/a/tests/x.rs", "/p/crates/a/tests/x.rs", "crates/*/tests/**"), true);
		assert.equal(matchRule("crates/a/nested/tests/x.rs", "/p/crates/a/nested/tests/x.rs", "crates/*/tests/**"), false);
	});

	it("always reserves .pi/meta-loop even under broad allowed_scope", () => {
		for (const target of [
			".pi/meta-loop/runs/owner.lock.json",
			".pi/meta-loop/flows/x.flow.yaml",
			".pi/meta-loop/runs/some-run/board.json",
		]) {
			const r = checkPath(target, "/proj", ["**"], []);
			assert.equal(r.ok, false, target);
			assert.match(r.reason ?? "", /reserved/i, target);
		}
		// Non-reserved project paths still allowed under **
		assert.equal(checkPath("src/x.ts", "/proj", ["**"], []).ok, true);
	});

	it("always reserves .git control plane even under broad allowed_scope", () => {
		for (const target of [
			".git/config",
			".git/HEAD",
			".git/refs/heads/feature-x",
			".git/hooks/pre-commit",
			".git/info/exclude",
		]) {
			const r = checkPath(target, "/proj", ["**"], []);
			assert.equal(r.ok, false, target);
			assert.match(r.reason ?? "", /reserved/i, target);
		}
		assert.equal(checkPath("src/x.ts", "/proj", ["**"], []).ok, true);
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

	it("compact mode omits long reports", () => {
		const board: TaskBoard = {
			goal: "g",
			planSummary: "p".repeat(100),
			openQuestions: [],
			phase: "executing",
			reviewCount: 2,
			tickets: [
				baseTicket({
					report: "HUGE_REPORT_" + "x".repeat(5000),
					claim: { claimedStatus: "done", notes: "n" },
				}),
			],
		};
		const full = formatBoardForSupervisor(board);
		const compact = formatBoardForSupervisor(board, { compact: true });
		assert.match(full, /HUGE_REPORT/);
		assert.doesNotMatch(compact, /HUGE_REPORT/);
		assert.ok(compact.length < full.length);
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

describe("terminal phase semantics", () => {
	const boardOf = (statuses: Ticket["status"][], phase: TaskBoard["phase"] = "executing"): TaskBoard => ({
		goal: "g",
		planSummary: "p",
		openQuestions: [],
		phase,
		reviewCount: 0,
		tickets: statuses.map((status, i) => baseTicket({ id: `t${i}`, status, acceptance: ["a"] })),
	});

	it("all blocked is incomplete, not done", () => {
		assert.equal(resolveTerminalPhase(boardOf(["blocked", "blocked"]), false), "incomplete");
		assert.equal(runStatusFromPhase("incomplete", false), "incomplete");
	});

	// P0 semantics change (not a weakened assertion): partial never counts as full success.
	// Old expectation was resolveTerminalPhase(done+partial)="done"; new spec → "incomplete".
	it("all-done only is done; done+partial is incomplete (P0)", () => {
		assert.equal(resolveTerminalPhase(boardOf(["done", "done"]), false), "done");
		assert.equal(runStatusFromPhase("done", false), "done");
		assert.equal(resolveTerminalPhase(boardOf(["done", "partial"]), false), "incomplete");
		assert.equal(runStatusFromPhase("incomplete", false), "incomplete");
	});

	it("empty tickets is plan_failed", () => {
		assert.equal(resolveTerminalPhase(boardOf([], "planning"), false), "plan_failed");
		assert.equal(runStatusFromPhase("plan_failed", false), "error");
	});

	it("abort wins", () => {
		assert.equal(resolveTerminalPhase(boardOf(["running"]), true), "stopped");
		assert.equal(runStatusFromPhase("stopped", true), "stopped");
	});

	it("elapsed freezes after finishedAt", () => {
		const started = "2026-01-01T00:00:00.000Z";
		const finished = "2026-01-01T00:02:00.000Z";
		const a = runElapsed({ startedAt: started, finishedAt: finished, updatedAt: finished, status: "incomplete" });
		const b = runElapsed({ startedAt: started, finishedAt: finished, updatedAt: finished, status: "incomplete" });
		assert.equal(a, b);
		assert.equal(a, "2m00s");
	});
});

describe("scope delta evidence", () => {
	it("ignores pre-existing dirty files", () => {
		const before = new Set(["docs/ENV_SMOKE_CHECK.md", "README.md"]);
		const after = ["docs/ENV_SMOKE_CHECK.md", "README.md", "docs/DOD_1.0.md"];
		const delta = ticketChangedFiles(before, after);
		assert.deepEqual(delta, ["docs/DOD_1.0.md"]);
	});

	it("empty delta when nothing new — not full dirty tree", () => {
		const before = new Set(["docs/ENV_SMOKE_CHECK.md"]);
		const after = ["docs/ENV_SMOKE_CHECK.md"];
		assert.deepEqual(deltaChangedFiles(before, after), []);
		// Old bug: fall back to `after` would false-flag ENV_SMOKE as this ticket's write
	});
});
