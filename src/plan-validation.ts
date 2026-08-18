/**
 * Plan and ticket validation, shared by the harness and the role subprocess.
 *
 * The Orchestrator's `submit_plan` tool runs exactly these checks inside the child
 * process, so a malformed plan is a tool error the model can fix in the same
 * session instead of a dead run. The harness re-runs them on whatever arrives —
 * the child is a convenience, never the authority.
 */
import { scopeRulesOutsideCeiling } from "./evidence.ts";
import type { Ticket } from "./types.ts";

/** The subset of a ticket a plan may specify. Status and evidence are the harness's. */
export interface TicketDraft {
	id: string;
	goal: string;
	deliverables: string[];
	acceptance: string[];
	allowed_scope: string[];
	forbidden: string[];
	dependencies: string[];
	context?: string;
}

export interface PlanPayload {
	summary: string;
	open_questions: string[];
	tasks: TicketDraft[];
}

export function toTicket(t: any, i: number, previous?: Ticket): Ticket {
	return {
		id: String(t.id ?? previous?.id ?? `task-${i + 1}`),
		goal: String(t.goal ?? previous?.goal ?? ""),
		deliverables: Array.isArray(t.deliverables) ? t.deliverables.map(String) : previous?.deliverables ?? [],
		acceptance: Array.isArray(t.acceptance) ? t.acceptance.map(String) : previous?.acceptance ?? [],
		allowed_scope: Array.isArray(t.allowed_scope) ? t.allowed_scope.map(String) : previous?.allowed_scope ?? [],
		forbidden: Array.isArray(t.forbidden) ? t.forbidden.map(String) : previous?.forbidden ?? [],
		dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : previous?.dependencies ?? [],
		context: t.context != null ? String(t.context) : previous?.context,
		execution: "native",
		status: previous?.status ?? "pending",
		report: previous?.report,
		error: previous?.error,
		claim: previous?.claim,
		evidence: previous?.evidence,
	};
}

export function validatePlanGraph(tickets: Ticket[]): string | null {
	const ids = new Set<string>();
	for (const t of tickets) {
		if (!t.id.trim()) return "empty ticket id";
		if (ids.has(t.id)) return `duplicate ticket id: ${t.id}`;
		ids.add(t.id);
	}
	for (const t of tickets) {
		for (const d of t.dependencies) {
			if (d === t.id) return `self-dependency: ${t.id}`;
			if (!ids.has(d)) return `missing dependency ${d} referenced by ${t.id}`;
		}
		if (t.acceptance.length === 0) {
			return `native ticket ${t.id} has empty acceptance`;
		}
	}
	// cycle detect
	const visiting = new Set<string>();
	const done = new Set<string>();
	const map = new Map(tickets.map((t) => [t.id, t]));
	const visit = (id: string): boolean => {
		if (done.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		for (const d of map.get(id)?.dependencies ?? []) {
			if (visit(d)) return true;
		}
		visiting.delete(id);
		done.add(id);
		return false;
	};
	for (const id of ids) {
		if (visit(id)) return "dependency cycle detected";
	}
	return null;
}

export function validateTicket(ticket: Ticket, scopeCeiling?: string[]): string | null {
	// Only the native pi worker exists. An unknown executor is a plan the harness cannot
	// enforce scope for, so it is refused rather than silently run as native (issue #4).
	if (ticket.execution !== undefined && ticket.execution !== "native") {
		return `unknown execution "${String(ticket.execution)}" — only "native" is supported`;
	}
	// native implementation tickets must declare a non-empty write scope (fail closed)
	if (!ticket.allowed_scope?.length) {
		return "native implementation ticket requires non-empty allowed_scope";
	}
	// A plan is model output; without a ceiling the write surface is chosen entirely
	// by the Orchestrator. When the user set one, the plan must stay inside it.
	const outside = scopeRulesOutsideCeiling(ticket.allowed_scope ?? [], scopeCeiling);
	if (outside.length > 0) {
		return `allowed_scope entries outside limits.scopeCeiling: ${outside.join(", ")} (ceiling: ${(scopeCeiling ?? []).join(", ")})`;
	}
	return null;
}

/**
 * Every reason this plan would be refused, not just the first. A model fixing one
 * violation per round-trip is the slow way to spend a submission budget.
 *
 * @returns an empty array when the plan is acceptable.
 */
export function validateSubmittedPlan(
	payload: PlanPayload,
	opts: { maxTasks: number; scopeCeiling?: string[] },
): string[] {
	const errors: string[] = [];
	const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
	if (tasks.length === 0) return ["plan has no tasks"];
	if (tasks.length > opts.maxTasks) {
		errors.push(`${tasks.length} tickets exceeds the cap of ${opts.maxTasks}`);
	}
	const tickets = tasks.map((t, i) => toTicket(t, i));
	const graph = validatePlanGraph(tickets);
	if (graph) errors.push(graph);
	for (const ticket of tickets) {
		const err = validateTicket(ticket, opts.scopeCeiling);
		if (err) errors.push(`${ticket.id}: ${err}`);
	}
	return errors;
}
