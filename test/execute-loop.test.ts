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
import {
	approvalPathFor,
	assessVerdict,
	prepareResume,
	runSupervisedTask,
	strongerApprovalPolicy,
} from "../src/runtime.ts";
import type { ApprovalDecision, ApprovalRequest } from "../src/runtime.ts";
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

describe("execute loop: audit outcomes", () => {
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
		assert.equal(result.board.tickets.every((t) => t.status !== "completed"), true);
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
		assert.equal(result.board.phase, "completed");
		// The work happened. Nobody checked it, and the run says exactly that rather than
		// pretending in either direction.
		assert.ok(result.board.tickets.every((t) => t.status === "completed"));
		assert.equal(result.board.verification?.status, "unverified");

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

});

describe("execute loop: roles answer through submission tools", () => {
	/** A fake role that writes its answer where the harness told it to, and prints nothing. */
	function submittingRunRole(payloads: Record<string, unknown>) {
		const seen: { role: string; args: string[]; env: Record<string, string> }[] = [];
		const run = async (role: { name: string }, _task: string, opts: any) => {
			const env = (opts.extraEnv ?? {}) as Record<string, string>;
			seen.push({ role: role.name, args: opts.extraArgs ?? [], env });
			const target = env.PI_META_LOOP_SUBMIT_PATH;
			const tool =
				role.name === "orchestrator" ? "submit_plan" : role.name === "supervisor" ? "submit_verdict" : "submit_report";
			if (target) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(
					target,
					JSON.stringify({ tool, payload: payloads[role.name], attempt: 1, at: "2026-01-01T00:00:00.000Z" }),
					"utf-8",
				);
			}
			// Deliberately no fenced JSON: the submission must be the only channel.
			return ok("done, submitted via tool.");
		};
		return { seen, run };
	}

	it("runs end to end with no fenced JSON anywhere in role output", async () => {
		const cwd = tmpCwd();
		const artifactDir = path.join(cwd, "artifacts");
		fs.mkdirSync(artifactDir, { recursive: true });

		const fake = submittingRunRole({
			orchestrator: PLAN,
			supervisor: { verdict: "green", scope: "overall", observations: [] },
			worker: { status: "done", changed_files: [], tests: [], unresolved: [], assumptions: [] },
		});

		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			artifactDir,
			runRole: fake.run as never,
		});

		assert.ok(fake.seen.some((s) => s.role === "worker"), "the plan must reach a worker");
		assert.equal(result.board.tickets.length, 1);
		assert.equal(result.board.tickets[0]!.claim?.source, "submission");
		cleanup(cwd);
	});

	it("passes each role its own identity, submission path and launch flags", async () => {
		const cwd = tmpCwd();
		const artifactDir = path.join(cwd, "artifacts");
		fs.mkdirSync(artifactDir, { recursive: true });

		const fake = submittingRunRole({
			orchestrator: PLAN,
			supervisor: { verdict: "green", scope: "overall", observations: [] },
			worker: { status: "done", changed_files: [], tests: [], unresolved: [], assumptions: [] },
		});
		await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			artifactDir,
			runRole: fake.run as never,
		});

		const orch = fake.seen.find((s) => s.role === "orchestrator")!;
		const sup = fake.seen.find((s) => s.role === "supervisor")!;
		const wrk = fake.seen.find((s) => s.role === "worker")!;

		assert.equal(orch.env.PI_META_LOOP_ROLE, "orchestrator");
		assert.equal(orch.env.PI_META_LOOP_MAX_TASKS, String(config().limits.maxTasks));
		assert.ok(orch.args.includes("-e"));
		assert.ok(orch.args.some((a) => a.endsWith("role-io.ts")));
		// Read-only roles keep the user's provider extensions; only the writer is sealed.
		assert.ok(!orch.args.includes("--no-extensions"));
		assert.ok(!sup.args.includes("--no-extensions"));
		assert.equal(sup.env.PI_META_LOOP_ROLE, "supervisor");
		assert.equal(wrk.env.PI_META_LOOP_ROLE, "worker");
		assert.ok(wrk.args.includes("--no-extensions"), "the writing role stays sealed");
		assert.ok(wrk.args.some((a) => a.endsWith("role-io.ts")));
		assert.ok(wrk.env.PI_META_LOOP_ALLOWED_SCOPE.includes("src/**"));
		cleanup(cwd);
	});

	it("falls back to fenced JSON and records that it did", async () => {
		const cwd = tmpCwd();
		const artifactDir = path.join(cwd, "artifacts");
		fs.mkdirSync(artifactDir, { recursive: true });

		// Nothing is written to the submission path — the old protocol only.
		const rec = recorder((role) => {
			if (role === "orchestrator") return fence(PLAN);
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return WORKER_REPORT;
		});

		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			artifactDir,
			runRole: rec.runRole as never,
		});

		assert.ok(rec.roles.includes("worker"));
		assert.equal(result.board.tickets[0]!.claim?.source, "fence-fallback");
		const meta = JSON.parse(fs.readFileSync(path.join(artifactDir, "plan-attempt-1.meta.json"), "utf-8"));
		assert.equal(meta.source, "fence-fallback");
		const audit = fs.readFileSync(path.join(artifactDir, "supervise-initial-1.txt"), "utf-8");
		assert.match(audit, /source: fence-fallback/);
		cleanup(cwd);
	});
});

describe("plan approval", () => {
	const YELLOW = {
		verdict: "yellow",
		scope: "overall",
		observations: ["the scope looks wide"],
		orchestrator_guidance: ["narrow it"],
	};
	const GREEN = { verdict: "green", scope: "overall", observations: [] };

	function planner(verdict: unknown) {
		return recorder((role) => {
			if (role === "orchestrator") return fence(PLAN);
			if (role === "supervisor") return fence(verdict);
			return WORKER_REPORT;
		});
	}

	it("maps verdicts to what the run should do about them", () => {
		assert.equal(assessVerdict({ verdict: "green" } as never), "clear");
		assert.equal(assessVerdict({ verdict: "yellow" } as never), "findings");
		assert.equal(assessVerdict({ verdict: "red" } as never), "reject");
	});

	it("asks only when the policy says so", () => {
		assert.equal(approvalPathFor("off", "clear"), "auto-approve");
		assert.equal(approvalPathFor("off", "findings"), "auto-approve");
		assert.equal(approvalPathFor("findings", "clear"), "auto-approve");
		assert.equal(approvalPathFor("findings", "findings"), "ask");
		assert.equal(approvalPathFor("always", "clear"), "ask");
		assert.equal(approvalPathFor("always", "findings"), "ask");
	});

	it("a policy can only be tightened", () => {
		assert.equal(strongerApprovalPolicy("off", "findings"), "findings");
		assert.equal(strongerApprovalPolicy("always", "off"), "always");
		assert.equal(strongerApprovalPolicy("findings", "always"), "always");
	});

	it("a clean audit runs without stopping to ask", async () => {
		const cwd = tmpCwd();
		const rec = planner(GREEN);
		let asked = 0;
		await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
			requestApproval: async () => {
				asked++;
				return { action: "approve" };
			},
		});
		assert.equal(asked, 0, "green must not interrupt the user");
		assert.ok(rec.roles.includes("worker"));
		cleanup(cwd);
	});

	it("findings pause the run, and approval releases it", async () => {
		const cwd = tmpCwd();
		const rec = planner(YELLOW);
		let seen: ApprovalRequest | undefined;
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
			requestApproval: async (req) => {
				seen = req;
				return { action: "approve" };
			},
		});
		const req = seen as ApprovalRequest | undefined;
		assert.ok(req, "a yellow audit must reach the reviewer");
		assert.equal(req!.assessment, "findings");
		assert.equal(req!.board.tickets.length, 1);
		assert.equal(req!.verifyConfigured, false);
		assert.ok(rec.roles.includes("worker"), "approval releases the run");
		assert.ok(["completed", "incomplete"].includes(result.board.phase));
		cleanup(cwd);
	});

	it("rejection cancels the plan without running anything", async () => {
		const cwd = tmpCwd();
		const rec = planner(YELLOW);
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
			requestApproval: async () => ({ action: "reject", reason: "not what I asked for" }),
		});
		assert.equal(result.board.phase, "plan_rejected");
		assert.ok(!rec.roles.includes("worker"));
		assert.ok(result.board.tickets.every((t) => t.status === "cancelled"));
		assert.match(result.summary, /PLAN REJECTED/);
		assert.match(result.summary, /not what I asked for/);
		cleanup(cwd);
	});

	it("without an approver the run refuses rather than assuming yes", async () => {
		const cwd = tmpCwd();
		const rec = planner(YELLOW);
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
		});
		assert.equal(result.board.phase, "plan_rejected");
		assert.ok(!rec.roles.includes("worker"));
		assert.match(result.summary, /no interactive approver/);
		assert.match(result.summary, /approval\.initialPlan/);
		cleanup(cwd);
	});

	it("a replan produces a new plan and audits it again", async () => {
		const cwd = tmpCwd();
		const rec = planner(GREEN);
		let asked = 0;
		const decisions: ApprovalDecision[] = [
			{ action: "replan", guidance: "smaller tickets please" },
			{ action: "approve" },
		];
		await runSupervisedTask(
			{ goal: "ship it", approval: "always" },
			cwd,
			config(),
			{
				runRole: rec.runRole as never,
				requestApproval: async () => decisions[asked++]!,
			},
		);
		assert.equal(asked, 2);
		// plan, replan, and an audit after each: a new plan is never trusted unaudited.
		assert.equal(rec.roles.filter((r) => r === "orchestrator").length, 2);
		assert.ok(rec.roles.filter((r) => r === "supervisor").length >= 2);
		cleanup(cwd);
	});

	it("the replan budget is finite", async () => {
		const cwd = tmpCwd();
		const rec = planner(GREEN);
		let asked = 0;
		const result = await runSupervisedTask(
			{ goal: "ship it", approval: "always" },
			cwd,
			config(),
			{
				runRole: rec.runRole as never,
				requestApproval: async () => {
					asked++;
					return { action: "replan", guidance: `try again ${asked}` };
				},
			},
		);
		assert.equal(result.board.phase, "plan_rejected");
		assert.match(result.summary, /replan budget exhausted/);
		cleanup(cwd);
	});

	it("red is a refusal that no policy can approve past", async () => {
		const cwd = tmpCwd();
		const rec = planner({ verdict: "red", scope: "overall", observations: ["destructive"] });
		let asked = 0;
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
			requestApproval: async () => {
				asked++;
				return { action: "approve" };
			},
		});
		assert.equal(asked, 0, "red never reaches the approval gate");
		assert.equal(result.board.phase, "stopped");
		assert.ok(!rec.roles.includes("worker"));
		cleanup(cwd);
	});

	it("a mid-run yellow records findings instead of stopping the board", async () => {
		const cwd = tmpCwd();
		let supervisions = 0;
		const rec = recorder((role) => {
			if (role === "orchestrator") return fence(PLAN);
			if (role === "supervisor") {
				supervisions++;
				return fence(supervisions === 1 ? GREEN : YELLOW);
			}
			return WORKER_REPORT;
		});
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
		});
		assert.ok(rec.roles.includes("worker"));
		assert.notEqual(result.board.phase, "stopped");
		cleanup(cwd);
	});
});

describe("resuming an existing board", () => {
	const TWO_TICKETS = {
		summary: "two slices",
		open_questions: [],
		tasks: [
			{ ...PLAN.tasks[0], id: "t1" },
			{ ...PLAN.tasks[0], id: "t2", goal: "the second thing" },
		],
	};

	it("re-runs only the unfinished ticket, and never plans or asks again", async () => {
		const cwd = tmpCwd();

		// First run: t1 completes, t2 fails.
		const first = recorder((role, task) => {
			if (role === "orchestrator") return fence(TWO_TICKETS);
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return /"id": "t2"/.test(task)
				? fence({ status: "blocked", unresolved: ["needs t1's export"] })
				: WORKER_REPORT;
		});
		const run1 = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: first.runRole as never,
		});
		const before = new Map(run1.board.tickets.map((t) => [t.id, t.status]));
		assert.equal(before.get("t1"), "completed");
		assert.equal(before.get("t2"), "blocked");

		// Resume: only t2 should run, and no planner or approver is involved.
		const prepared = prepareResume(run1.board, { runId: "run-1" });
		assert.deepEqual(prepared.retrying, ["t2"]);

		const workerTasks: string[] = [];
		const second = recorder((role, task) => {
			if (role === "worker") workerTasks.push(task);
			if (role === "orchestrator") throw new Error("a resume must not re-plan");
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return WORKER_REPORT;
		});
		let asked = 0;
		const run2 = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: second.runRole as never,
			resumeBoard: prepared.board,
			requestApproval: async () => {
				asked++;
				return { action: "approve" };
			},
		});

		assert.equal(asked, 0, "the plan was approved once already");
		assert.ok(!second.roles.includes("orchestrator"));
		assert.equal(second.roles.filter((r) => r === "worker").length, 1, "only the unfinished ticket runs");
		assert.match(workerTasks[0]!, /"id": "t2"/);
		// The retried worker is told what its previous attempt did.
		assert.match(workerTasks[0]!, /Previous attempts/);
		assert.match(workerTasks[0]!, /needs t1's export|blocked/);

		const after = new Map(run2.board.tickets.map((t) => [t.id, t.status]));
		assert.equal(after.get("t1"), "completed", "finished work is not redone");
		assert.equal(after.get("t2"), "completed");
		cleanup(cwd);
	});

	it("still runs the final audit on a resumed run", async () => {
		const cwd = tmpCwd();
		const rec = recorder((role) => {
			if (role === "orchestrator") throw new Error("no planning on resume");
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return WORKER_REPORT;
		});
		const prepared = prepareResume(
			{
				goal: "ship it",
				planSummary: "p",
				openQuestions: [],
				phase: "incomplete",
				reviewCount: 1,
				tickets: [
					{
						id: "t1",
						goal: "g",
						deliverables: [],
						acceptance: ["a"],
						allowed_scope: ["src/**"],
						forbidden: [],
						dependencies: [],
						status: "failed",
						error: "boom",
					},
				],
			},
			{ runId: "old" },
		);
		await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
			resumeBoard: prepared.board,
		});
		// The gate at the end is not optional just because the start was skipped.
		assert.ok(rec.roles.includes("supervisor"));
		cleanup(cwd);
	});
});

describe("the filesystem sweep is opt-in", () => {
	// Enforcement is the tool-call guard, which refuses an out-of-scope write before it
	// happens. The sweep can only notice afterwards, and costs two full directory walks
	// per ticket to do it.
	function planFor(cwd: string) {
		return recorder((role) => {
			if (role === "orchestrator") return fence(PLAN);
			if (role === "supervisor") return fence({ verdict: "green", scope: "overall", observations: [] });
			return WORKER_REPORT;
		});
	}

	it("runs a ticket without walking the tree, and still snapshots git", async () => {
		const cwd = tmpCwd();
		const rec = planFor(cwd);
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, config(), {
			runRole: rec.runRole as never,
		});
		assert.ok(rec.roles.includes("worker"));
		assert.equal(result.board.tickets[0]!.status, "completed");
		cleanup(cwd);
	});

	it("a cwd whose parent cannot be read no longer blocks the run", async () => {
		// This is the shape that made a temp-directory cwd fail before the worker even
		// started: the parent scan hit files other processes hold open.
		const cwd = tmpCwd();
		const rec = planFor(cwd);
		const cfg = config();
		cfg.evidence.parentMaxDepth = 0;
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, cfg, {
			runRole: rec.runRole as never,
		});
		assert.equal(result.board.tickets[0]!.status, "completed");
		cleanup(cwd);
	});

	it("still collects filesystem evidence when the user asks for it", async () => {
		const cwd = tmpCwd();
		const rec = planFor(cwd);
		const cfg = config();
		cfg.evidence.filesystemSweep = true;
		const result = await runSupervisedTask({ goal: "ship it" }, cwd, cfg, {
			runRole: rec.runRole as never,
		});
		assert.ok(rec.roles.includes("worker"));
		assert.ok(result.board.tickets[0]!.evidence, "the sweep still produces evidence when enabled");
		cleanup(cwd);
	});
});
