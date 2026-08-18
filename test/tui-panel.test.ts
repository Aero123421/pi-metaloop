import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersistedRun } from "../src/board-store.ts";
import {
	buildFooterLine,
	buildPanelLines,
	dispWidth,
	nextDetail,
	progressBar,
	shouldShowPanel,
	type PanelDetail,
} from "../src/tui-panel.ts";
import type { TaskBoard } from "../src/types.ts";

const theme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
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
				status: "completed",
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
		});
		const blob = lines.join("\n");
		assert.match(blob, /meta-loop/);
		assert.match(blob, /executing/);
		assert.match(blob, /t2/);
		assert.match(blob, /chat OK/);
		assert.match(blob, /\/ml-ui/);
	});

	it("footer names the run", () => {
		const footer = buildFooterLine({
			theme,
			detail: "normal",
			tick: 0,
			ml: run(),
		});
		assert.match(footer, /meta-loop/);
		assert.match(footer, /executing/);
	});

	it("never draws past the requested width, including full-width text", () => {
		const jp = run({
			goal: "エビデンス帰属の是正と最終検証モードの追加をオーケストレーターに適用する",
			activity: "src/evidence.ts を編集中 — ワークツリーを走査（1284 件）",
			board: board({
				tickets: [
					{
						id: "t1-足場",
						goal: "モジュールの足場を作り設定ローダーを配線する",
						deliverables: [],
						acceptance: ["a"],
						allowed_scope: [],
						forbidden: [],
						dependencies: [],
						status: "running",
					},
					{
						id: "t2-verify-gate-wiring-long-id",
						goal: "信頼された verify ゲートを配線する",
						deliverables: [],
						acceptance: ["a"],
						allowed_scope: [],
						forbidden: [],
						dependencies: [],
						status: "blocked",
						error: "依存パッケージが見つからない",
					},
				],
			}),
		});
		for (const width of [44, 50, 78, 120]) {
			for (const detail of ["compact", "normal", "full"] as PanelDetail[]) {
				const lines = buildPanelLines({ theme, detail, tick: 0, ml: jp, width });
				for (const line of lines) {
					assert.ok(
						dispWidth(line) <= width,
						`detail=${detail} width=${width} overflowed by ${dispWidth(line) - width}: ${line}`,
					);
				}
			}
		}
	});

	it("clamps absurd widths instead of collapsing", () => {
		const lines = buildPanelLines({ theme, detail: "normal", tick: 0, ml: run(), width: 4 });
		assert.ok(lines.length > 0);
		for (const line of lines) assert.ok(dispWidth(line) <= 44);
	});

	it("omits zero counters", () => {
		const blob = buildPanelLines({ theme, detail: "normal", tick: 0, ml: run(), width: 78 }).join("\n");
		assert.match(blob, /✓1/);
		assert.ok(!blob.includes("✗0"));
		assert.ok(!blob.includes("■0"));
		const footer = buildFooterLine({ theme, detail: "normal", tick: 0, ml: run() });
		assert.ok(!footer.includes("✗0"));
	});

	it("dispWidth counts full-width and combining characters", () => {
		assert.equal(dispWidth("abc"), 3);
		assert.equal(dispWidth("あい"), 4);
		assert.equal(dispWidth("あa"), 3);
		assert.equal(dispWidth(""), 0);
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

});
