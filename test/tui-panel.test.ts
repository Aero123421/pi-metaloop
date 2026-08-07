import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersistedRun } from "../src/board-store.ts";
import type { SfhStatus } from "../src/sfh.ts";
import {
	buildFooterLine,
	buildPanelLines,
	nextDetail,
	progressBar,
	shouldShowPanel,
	type PanelDetail,
} from "../src/tui-panel.ts";
import type { TaskBoard } from "../src/types.ts";

const theme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
} as any;

function board(over: Partial<TaskBoard> = {}): TaskBoard {
	return {
		goal: "ship feature X with tests",
		planSummary: "p",
		openQuestions: [],
		phase: "executing",
		reviewCount: 1,
		tickets: [
			{
				id: "t1",
				goal: "implement core",
				deliverables: [],
				acceptance: ["a"],
				allowed_scope: [],
				forbidden: [],
				dependencies: [],
				status: "done",
			},
			{
				id: "t2",
				goal: "add tests",
				deliverables: [],
				acceptance: ["a"],
				allowed_scope: [],
				forbidden: [],
				dependencies: ["t1"],
				status: "running",
			},
		],
		verdict: { verdict: "green", observations: [], risk: [], required_actions: [], optional_advice: [], affected_tasks: [], harness_suggestions: [] },
		...over,
	};
}

function run(over: Partial<PersistedRun> = {}): PersistedRun {
	const b = board();
	return {
		runId: "r1",
		cwd: "/tmp",
		goal: b.goal,
		status: "running",
		label: "executing: t2",
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		updatedAt: new Date().toISOString(),
		board: b,
		verdicts: [],
		...over,
	};
}

const sfhRunning: SfhStatus = {
	state: "running",
	current_step: "fanout.branch_a",
	steps_done: 1,
	cost_usd: 0.12,
	elapsed_sec: 42,
	fanout_total: 3,
	fanout_completed: 1,
	active_members: { branch_a: "running", branch_b: "pending" },
	flow: "meta-loop-demo",
	run_dir: "/tmp/.sfh/runs/x",
	pid: 1,
};

describe("tui-panel", () => {
	it("cycles detail levels", () => {
		let d: PanelDetail = "compact";
		d = nextDetail(d);
		assert.equal(d, "normal");
		d = nextDetail(d);
		assert.equal(d, "full");
		d = nextDetail(d);
		assert.equal(d, "compact");
	});

	it("progressBar encodes ratio", () => {
		const s = progressBar(2, 4, 8);
		assert.match(s, /2\/4/);
		assert.ok(s.includes("█"));
		assert.ok(s.includes("░"));
	});

	it("shows running ml panel with tickets and colors path", () => {
		const lines = buildPanelLines({
			theme,
			detail: "normal",
			tick: 3,
			ml: run(),
			live: { label: "executing: t2", activity: "writing tests..." },
			sfh: null,
		});
		const blob = lines.join("\n");
		assert.match(blob, /meta-loop/);
		assert.match(blob, /RUNNING|running/i);
		assert.match(blob, /t2/);
		assert.match(blob, /chat OK/);
		assert.match(blob, /\/ml-ui/);
	});

	it("merges sfh into same panel", () => {
		const lines = buildPanelLines({
			theme,
			detail: "full",
			tick: 1,
			ml: run(),
			sfh: sfhRunning,
		});
		const blob = lines.join("\n");
		assert.match(blob, /sfh/);
		assert.match(blob, /fanout|fan/i);
		assert.match(blob, /branch_a/);
		assert.match(blob, /meta-loop/);
	});

	it("footer includes ML and SFH", () => {
		const footer = buildFooterLine({
			theme,
			detail: "normal",
			tick: 0,
			ml: run(),
			sfh: sfhRunning,
		});
		assert.match(footer, /ML/);
		assert.match(footer, /SFH/);
	});

	it("hides old finished runs unless forced", () => {
		const old = run({
			status: "stopped",
			finishedAt: new Date(Date.now() - 200_000).toISOString(),
			updatedAt: new Date(Date.now() - 200_000).toISOString(),
			board: board({ phase: "stopped", tickets: [] }),
		});
		assert.equal(
			shouldShowPanel({ theme, detail: "normal", tick: 0, ml: old, hideFinishedAfterMs: 90_000 }),
			false,
		);
		assert.equal(
			shouldShowPanel({ theme, detail: "normal", tick: 0, ml: old, forceShow: true, hideFinishedAfterMs: 90_000 }),
			true,
		);
	});

	it("always shows while sfh running", () => {
		assert.equal(
			shouldShowPanel({
				theme,
				detail: "compact",
				tick: 0,
				ml: null,
				sfh: sfhRunning,
			}),
			true,
		);
	});

	it("does not show panel for terminal sfh alone (ghost)", () => {
		const failed = { ...sfhRunning, state: "failed" as const };
		assert.equal(
			shouldShowPanel({
				theme,
				detail: "compact",
				tick: 0,
				ml: null,
				sfh: failed,
			}),
			false,
		);
	});
});
