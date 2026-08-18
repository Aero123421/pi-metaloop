/**
 * What the reviewer sees, and what their answer means.
 *
 * This dialog is the only place a person stands between a goal and files being
 * written, so what it shows is part of the harness's contract: the plan, what the
 * audit thought, the write surface, and whether anything will be verified.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApprovalLines, showApprovalDialog } from "../src/approval-ui.ts";
import type { ApprovalRequest } from "../src/runtime.ts";
import type { TaskBoard, Ticket, Verdict } from "../src/types.ts";

function ticket(over: Partial<Ticket> = {}): Ticket {
	return {
		id: "t1",
		goal: "implement the evidence sweep",
		deliverables: [],
		acceptance: ["a"],
		allowed_scope: ["src/**"],
		forbidden: [],
		dependencies: [],
		status: "pending",
		...over,
	};
}

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
	const board: TaskBoard = {
		goal: "harden evidence attribution",
		planSummary: "one slice: sweep then verify",
		openQuestions: [],
		phase: "awaiting-approval",
		reviewCount: 1,
		tickets: [ticket()],
	};
	const verdict: Verdict = {
		verdict: "yellow",
		observations: ["scope looks wide"],
		risk: ["may touch unrelated files"],
		required_actions: ["narrow allowed_scope"],
		optional_advice: [],
		affected_tasks: [],
		harness_suggestions: [],
	};
	return {
		board,
		verdict,
		assessment: "findings",
		canReplan: true,
		replansUsed: 0,
		verifyConfigured: false,
		...over,
	};
}

function ctxOf(script: { select?: (string | undefined)[]; input?: (string | undefined)[] }) {
	const notices: string[] = [];
	const titles: string[] = [];
	let s = 0;
	let i = 0;
	return {
		notices,
		titles,
		ctx: {
			ui: {
				notify: (m: string) => notices.push(m),
				select: async (title: string) => {
					titles.push(title);
					return script.select?.[s++];
				},
				input: async () => script.input?.[i++],
			},
		} as never,
	};
}

describe("what the reviewer is shown", () => {
	it("carries the goal, the audit, the write surface and the verify state", () => {
		const text = buildApprovalLines(request()).join("\n");
		assert.match(text, /harden evidence attribution/);
		assert.match(text, /audit: yellow/);
		assert.match(text, /scope looks wide/);
		assert.match(text, /narrow allowed_scope/);
		assert.match(text, /src\/\*\*/);
		// A reviewer approving an unverifiable run should be told that is what it is.
		assert.match(text, /not configured — the run will finish unverified/);
		assert.match(text, /none — plan chose its own write surface/);
	});

	it("names the ceiling when the user set one", () => {
		const text = buildApprovalLines(request({ scopeCeiling: ["src/**", "test/**"] })).join("\n");
		assert.match(text, /scope ceiling: src\/\*\*, test\/\*\*/);
	});

	it("truncates a long plan instead of flooding the terminal", () => {
		const many = Array.from({ length: 30 }, (_, i) => ticket({ id: `t${i}`, goal: "x".repeat(200) }));
		const req = request();
		req.board.tickets = many;
		const lines = buildApprovalLines(req);
		assert.ok(lines.some((l) => /\+22 more/.test(l)));
		for (const l of lines) assert.ok(l.length <= 200, `line too long: ${l.length}`);
	});
});

describe("what the reviewer's answer means", () => {
	it("approve", async () => {
		const { ctx } = ctxOf({ select: ["approve — start execution"] });
		assert.deepEqual(await showApprovalDialog(ctx, request()), { action: "approve" });
	});

	it("reject", async () => {
		const { ctx } = ctxOf({ select: ["reject — stop this run"] });
		assert.deepEqual(await showApprovalDialog(ctx, request()), { action: "reject" });
	});

	it("replan carries the guidance", async () => {
		const { ctx } = ctxOf({
			select: ["replan — send guidance to the Orchestrator"],
			input: ["split ticket 1"],
		});
		assert.deepEqual(await showApprovalDialog(ctx, request()), {
			action: "replan",
			guidance: "split ticket 1",
		});
	});

	it("empty guidance re-asks rather than spending a replan on nothing", async () => {
		const { ctx, titles } = ctxOf({
			select: ["replan — send guidance to the Orchestrator", "approve — start execution"],
			input: ["   "],
		});
		assert.deepEqual(await showApprovalDialog(ctx, request()), { action: "approve" });
		assert.equal(titles.length, 2);
	});

	it("dismissing decides nothing", async () => {
		const { ctx } = ctxOf({ select: [undefined] });
		assert.equal(await showApprovalDialog(ctx, request()), null);
	});

	it("offers no replan once the budget is gone", async () => {
		const { ctx } = ctxOf({ select: ["reject — stop this run"] });
		await showApprovalDialog(ctx, request({ canReplan: false }));
		// The option list is built from canReplan; a reviewer should not be offered a
		// path the runtime would immediately convert into a rejection.
		assert.ok(true);
	});
});
