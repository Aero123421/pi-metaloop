/**
 * The one place a human stands in the loop.
 *
 * Everything else the harness does is deterministic or a model judging a model.
 * This is the cheapest and most accurate misalignment detector available — the
 * person who wrote the goal, looking at the plan, before a single file is written.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { padCell } from "./tui-panel.ts";
import type { ApprovalDecision, ApprovalRequest } from "./runtime.ts";

const MAX_TICKET_ROWS = 8;

function trunc(s: string, n: number): string {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * What the reviewer needs to answer "is this what I asked for?" — the goal, what the
 * audit thought, what will be written, and whether the result will be verified at all.
 */
export function buildApprovalLines(req: ApprovalRequest): string[] {
	const { board, verdict } = req;
	const lines: string[] = [
		"[pi-meta-loop] Plan awaiting approval",
		`goal: ${trunc(board.goal, 160)}`,
		`plan: ${trunc(board.planSummary, 240)}`,
		`audit: ${verdict.verdict} — ${trunc((verdict.observations ?? []).slice(0, 3).join(" · "), 400)}`,
	];
	const required = (verdict.required_actions ?? []).filter(Boolean);
	if (required.length > 0) {
		lines.push("required:");
		for (const r of required) lines.push(`  - ${trunc(r, 140)}`);
	}
	const risk = (verdict.risk ?? []).filter(Boolean);
	if (risk.length > 0) lines.push(`risk: ${trunc(risk.slice(0, 2).join(" · "), 200)}`);

	lines.push(`tickets (${board.tickets.length}):`);
	const idCol = Math.min(20, Math.max(8, ...board.tickets.slice(0, MAX_TICKET_ROWS).map((t) => t.id.length)));
	for (const t of board.tickets.slice(0, MAX_TICKET_ROWS)) {
		lines.push(`  ${padCell(t.id, idCol)}  ${trunc(t.goal, 60)}`);
		lines.push(`      scope: ${trunc((t.allowed_scope ?? []).join(", "), 100)}`);
	}
	if (board.tickets.length > MAX_TICKET_ROWS) {
		lines.push(`  +${board.tickets.length - MAX_TICKET_ROWS} more — /tasks`);
	}

	lines.push(
		`scope ceiling: ${req.scopeCeiling?.length ? req.scopeCeiling.join(", ") : "(none — plan chose its own write surface)"}`,
	);
	lines.push(
		`verify: ${req.verifyConfigured ? "configured" : "not configured — the run will finish unverified"}`,
	);
	const open = (board.openQuestions ?? []).filter(Boolean);
	if (open.length > 0) lines.push(`open questions: ${trunc(open.join(" | "), 200)}`);
	return lines;
}

const APPROVE = "approve — start execution";
const REPLAN = "replan — send guidance to the Orchestrator";
const REJECT = "reject — stop this run";

/**
 * @returns null when the reviewer dismissed the dialog without deciding. The caller
 * decides what that means: postponed when they can come back to it, refused when
 * there will be no second chance.
 */
export async function showApprovalDialog(
	ctx: Pick<ExtensionContext, "ui">,
	req: ApprovalRequest,
	opts: { timeoutMs?: number } = {},
): Promise<ApprovalDecision | null> {
	ctx.ui.notify(buildApprovalLines(req).join("\n"), req.assessment === "findings" ? "warning" : "info");

	const options = req.canReplan ? [APPROVE, REPLAN, REJECT] : [APPROVE, REJECT];
	for (let round = 0; round < 2; round++) {
		const choice = await ctx.ui.select(`Approve this plan? (${req.board.tickets.length} tickets)`, options, {
			timeout: opts.timeoutMs,
		} as never);
		if (!choice) return null;
		if (choice === APPROVE) return { action: "approve" };
		if (choice === REJECT) return { action: "reject" };
		const guidance = await ctx.ui.input(
			"Guidance for the replan:",
			"e.g. merge tickets 2 and 3; keep scope inside src/",
		);
		if (guidance?.trim()) return { action: "replan", guidance: guidance.trim() };
		// An empty guidance would ask the Orchestrator to redo the plan for no stated
		// reason, which is how a replan budget gets spent on nothing.
	}
	return null;
}
