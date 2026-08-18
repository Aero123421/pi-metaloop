/**
 * Loop-level tests for runSupervisedTask.
 *
 * Every other test in this suite exercises an extracted pure function. The
 * failures that actually reached production did not live in any of them: two of
 * the three persisted runs died with every ticket blocked and zero executed,
 * because a Supervisor yellow routed into a one-shot revision whose output the
 * merge refused. Each part was individually correct and individually tested.
 *
 * These drive the real loop with a fake role runner, so the composition is what
 * is under test.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { runSupervisedTask } from "../src/runtime.ts";
import type { MetaLoopConfig } from "../src/config.ts";
import type { RoleRunResult } from "../src/types.ts";

function git(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/**
 * A real git repo, nested one level down. Both are load-bearing: the harness
 * captures a git snapshot before every ticket and fails closed without one, and
 * the evidence sweep also scans the parent's direct entries — the system temp
 * directory is full of files other processes hold open, so a cwd placed straight
 * in it fails the pre-run snapshot and no worker ever starts.
 */
function tmpCwd(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ml-loop-"));
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "loop-test@example.com"]);
	git(cwd, ["config", "user.name", "Loop Test"]);
	git(cwd, ["config", "commit.gpgsign", "false"]);
	fs.writeFileSync(path.join(cwd, "README.md"), "initial\n", "utf-8");
	git(cwd, ["add", "README.md"]);
	git(cwd, ["commit", "-m", "init"]);
	return cwd;
}

function cleanup(cwd: string): void {
	fs.rmSync(path.dirname(cwd), { recursive: true, force: true });
}

function ok(output: string): RoleRunResult {
	return { output, exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
}

function fence(value: unknown): string {
	return ["```json", JSON.stringify(value), "```"].join("\n");
}

const PLAN = {
	summary: "one slice",
	open_questions: [],
	tasks: [
		{
			id: "t1",
			goal: "implement the thing",
			deliverables: ["src/thing.ts"],
			acceptance: ["src/thing.ts exists"],
			allowed_scope: ["src/**"],
			forbidden: [],
			dependencies: [],
			context: "",
		},
	],
};

const WORKER_REPORT = fence({ status: "done", changed_files: [], tests: [], unresolved: [], assumptions: [] });

function config(over: Partial<MetaLoopConfig> = {}): MetaLoopConfig {
	return structuredClone({ ...defaultConfig, ...over }) as MetaLoopConfig;
}

/** Records what the loop asked of each role, in order. */
interface Recorder {
	roles: string[];
	runRole: (role: { name: string }, task: string) => Promise<RoleRunResult>;
}

function recorder(reply: (role: string, task: string, nth: number) => string): Recorder {
	const roles: string[] = [];
	const counts: Record<string, number> = {};
	return {
		roles,
		runRole: async (role, task) => {
			counts[role.name] = (counts[role.name] ?? 0) + 1;
			roles.push(role.name);
			return ok(reply(role.name, task, counts[role.name]!));
		},
	};
}

describe("execute loop: a yellow verdict must not be able to kill the run silently", () => {
	it("records why a revision was rejected instead of a bare 'revision failed'", async () => {
		const cwd = tmpCwd();
		const artifactDir = path.join(cwd, "artifacts");
		fs.mkdirSync(artifactDir, { recursive: true });

		// The production shape: the Supervisor keeps asking for something a ticket list
		// cannot express, so the Orchestrator echoes the board back, and the merge
		// refuses the echo.
		const rec = recorder((role, _task, nth) => {
			if (role === "orchestrator") return nth === 1 ? fence(PLAN) : fence(PLAN);
			if (role === "supervisor") {
				return fence({
					verdict: "yellow",
					scope: "overall",
					observations: ["the Orchestrator should run the tests itself"],
					required_actions: ["run npm test from the plan"],
					orchestrator_guidance: ["add an integration verification step you execute yourself"],
				});
			}
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask(
			{ goal: "ship it" },
			cwd,
			config(),
			{ artifactDir, runRole: rec.runRole as never },
		);

		assert.equal(result.board.phase, "stopped");
		const blocked = result.board.tickets.filter((t) => t.status === "blocked");
		assert.ok(blocked.length > 0, "pending work is blocked when a required revision is refused");

		// The cause must reach the ticket. "revision failed" alone is what left two
		// production runs undiagnosable.
		assert.match(blocked[0]!.error ?? "", /unchanged-echo/);

		// And it must reach disk, with the raw model output beside it.
		const artifacts = fs.readdirSync(artifactDir);
		const revise = artifacts.filter((f) => f.startsWith("revise-attempt-"));
		assert.ok(revise.length > 0, `expected a revise artifact, saw ${artifacts.join(", ")}`);
		const body = fs.readFileSync(path.join(artifactDir, revise[0]!), "utf-8");
		assert.match(body, /unchanged-echo/);
		assert.match(body, /## raw output/);
		assert.match(body, /## guidance/);

		cleanup(cwd);
	});

	it("keeps the Supervisor's raw output even when the verdict cannot be parsed", async () => {
		const cwd = tmpCwd();
		const artifactDir = path.join(cwd, "artifacts");
		fs.mkdirSync(artifactDir, { recursive: true });

		const rec = recorder((role) => {
			if (role === "orchestrator") return fence(PLAN);
			if (role === "supervisor") return "I have some thoughts but no JSON for you.";
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask(
			{ goal: "ship it" },
			cwd,
			config(),
			{ artifactDir, runRole: rec.runRole as never },
		);

		// Fail-closed: an unparseable initial audit does not start execution.
		assert.equal(result.board.tickets.every((t) => t.status !== "done"), true);
		const supervise = fs.readdirSync(artifactDir).filter((f) => f.startsWith("supervise-"));
		assert.ok(supervise.length > 0, "an unusable audit is the run's cause of death; keep its output");
		const body = fs.readFileSync(path.join(artifactDir, supervise[0]!), "utf-8");
		assert.match(body, /verdict: \(unusable\)/);
		assert.match(body, /no JSON for you/);

		cleanup(cwd);
	});

	it("a green plan runs its tickets and reaches a terminal phase", async () => {
		const cwd = tmpCwd();
		const rec = recorder((role) => {
			if (role === "orchestrator") return fence(PLAN);
			if (role === "supervisor") {
				return fence({ verdict: "green", scope: "overall", observations: [] });
			}
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask(
			{ goal: "ship it" },
			cwd,
			config(),
			{ runRole: rec.runRole as never },
		);

		assert.ok(rec.roles.includes("worker"), "green must reach the worker");
		assert.ok(["done", "incomplete"].includes(result.board.phase), `phase was ${result.board.phase}`);
		// Without a configured verify the ticket cannot be `done` — that gate is the point.
		assert.ok(result.board.tickets.every((t) => t.status !== "done"));

		cleanup(cwd);
	});
});

describe("execute loop: a plan the harness would block never reaches the Supervisor", () => {
	const BAD_PLAN = {
		summary: "no write scope",
		open_questions: [],
		tasks: [
			{
				id: "t1",
				goal: "implement the thing",
				deliverables: ["src/thing.ts"],
				acceptance: ["src/thing.ts exists"],
				allowed_scope: [],
				forbidden: [],
				dependencies: [],
				context: "",
			},
		],
	};

	it("retries planning with the reason, instead of auditing a doomed plan", async () => {
		const cwd = tmpCwd();
		const rec = recorder((role, task, nth) => {
			if (role === "orchestrator") return nth === 1 ? fence(BAD_PLAN) : fence(PLAN);
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
		});

		// Two planning calls, and the Supervisor only ever saw the usable plan.
		assert.equal(rec.roles.filter((r) => r === "orchestrator").length, 2);
		assert.equal(rec.roles[0], "orchestrator");
		assert.equal(rec.roles[1], "orchestrator");
		assert.equal(rec.roles[2], "supervisor");
		assert.ok(result.board.tickets.length > 0);
		cleanup(cwd);
	});

	it("spends no audit at all when planning cannot produce a usable plan", async () => {
		const cwd = tmpCwd();
		const rec = recorder((role) => {
			if (role === "orchestrator") return fence(BAD_PLAN);
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
		});

		assert.equal(result.board.phase, "plan_failed");
		assert.ok(!rec.roles.includes("supervisor"), "no Supervisor call for a plan that cannot run");
		assert.ok(!rec.roles.includes("worker"));
		assert.match(result.board.planSummary, /allowed_scope/);
		cleanup(cwd);
	});

	it("refuses a revision that would introduce an unusable ticket", async () => {
		const cwd = tmpCwd();
		const artifactDir = path.join(cwd, "artifacts");
		fs.mkdirSync(artifactDir, { recursive: true });

		const rec = recorder((role, _task, nth) => {
			// Plan is fine; the revision the Supervisor forces is not.
			if (role === "orchestrator") return nth === 1 ? fence(PLAN) : fence(BAD_PLAN);
			if (role === "supervisor") {
				return fence({
					verdict: "yellow",
					scope: "overall",
					observations: ["narrow the scope"],
					orchestrator_guidance: ["drop the write scope"],
				});
			}
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			artifactDir,
			runRole: rec.runRole as never,
		});

		const blocked = result.board.tickets.filter((t) => t.status === "blocked");
		assert.ok(blocked.length > 0);
		assert.match(blocked[0]!.error ?? "", /allowed_scope/);
		cleanup(cwd);
	});
});
