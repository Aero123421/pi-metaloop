/**
 * Role I/O extension — loaded into every role subprocess via `pi -e`.
 *
 * A role used to answer by printing a fenced JSON blob that the harness scraped
 * out of stdout. That protocol has exactly one failure mode and it is fatal: an
 * unparseable answer ends the run, because the parent has no way to say "that
 * was not valid, try again" to a process that has already exited.
 *
 * Here the answer is a tool call against a schema. A malformed submission comes
 * back as a tool error inside the same session, and the model fixes it for the
 * price of one turn. The plan tool runs the harness's own validators, so a plan
 * that would be blocked is refused where it can still be corrected.
 *
 * The child is a convenience, never the authority: the harness re-validates
 * whatever arrives.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateSubmittedPlan, type PlanPayload } from "./plan-validation.ts";
import { installScopeGuard } from "./scope-guard.ts";

/** Invalid submissions allowed before the role is stopped rather than looped. */
export const MAX_SUBMIT_ATTEMPTS = 5;

export const TicketDraftSchema = Type.Object({
	id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
	goal: Type.String({ minLength: 1, maxLength: 500 }),
	deliverables: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { default: [], maxItems: 8 }),
	acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 6 }),
	allowed_scope: Type.Array(Type.String({ minLength: 1, maxLength: 260 }), { minItems: 1, maxItems: 16 }),
	forbidden: Type.Array(Type.String({ minLength: 1, maxLength: 260 }), { default: [], maxItems: 16 }),
	dependencies: Type.Array(Type.String({ maxLength: 64 }), { default: [], maxItems: 16 }),
	context: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const SubmitPlanSchema = Type.Object({
	summary: Type.String({ minLength: 1, maxLength: 1000 }),
	open_questions: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 10 }),
	tasks: Type.Array(TicketDraftSchema, { minItems: 1, maxItems: 64 }),
});

export const SubmitVerdictSchema = Type.Object({
	verdict: StringEnum(["green", "yellow", "red"] as const),
	scope: Type.Optional(StringEnum(["overall", "orchestrator", "workers", "harness"] as const)),
	observations: Type.Array(Type.String({ maxLength: 500 }), { default: [], maxItems: 10 }),
	risk: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 8 }),
	required_actions: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 6 }),
	optional_advice: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 8 }),
	affected_tasks: Type.Array(Type.String({ maxLength: 64 }), { default: [], maxItems: 16 }),
	orchestrator_guidance: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 6 }),
	harness_suggestions: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 6 }),
});

export const SubmitReportSchema = Type.Object({
	status: StringEnum(["done", "partial", "blocked"] as const),
	changed_files: Type.Array(Type.String({ maxLength: 260 }), { default: [], maxItems: 64 }),
	tests: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 16 }),
	unresolved: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 16 }),
	assumptions: Type.Array(Type.String({ maxLength: 300 }), { default: [], maxItems: 16 }),
	notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

export type RoleName = "orchestrator" | "supervisor" | "worker";

interface ToolSpec {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	schema: typeof SubmitPlanSchema | typeof SubmitVerdictSchema | typeof SubmitReportSchema;
}

const TOOLS: Record<RoleName, ToolSpec> = {
	orchestrator: {
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Submit the final decomposition plan. Call exactly once. The harness validates ids, dependencies, acceptance, write scopes and the ticket cap; on error, fix the plan and call again.",
		promptSnippet: "Submit the final decomposition plan",
		schema: SubmitPlanSchema,
	},
	supervisor: {
		name: "submit_verdict",
		label: "Submit Verdict",
		description: "Submit the audit verdict. Call exactly once. Do not print the verdict as text.",
		promptSnippet: "Submit the audit verdict",
		schema: SubmitVerdictSchema,
	},
	worker: {
		name: "submit_report",
		label: "Submit Report",
		description:
			"Submit the final report for this ticket. Call exactly once. If acceptance was not met, submit status partial or blocked with the reason in unresolved.",
		promptSnippet: "Submit the final ticket report",
		schema: SubmitReportSchema,
	},
};

function parseCeiling(raw: string | undefined): string[] | undefined {
	if (!raw?.trim()) return undefined;
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : undefined;
	} catch {
		return undefined;
	}
}

/** Semantic checks beyond the schema. Only the plan has any. */
export function validateSubmission(
	role: RoleName,
	payload: unknown,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (role !== "orchestrator") return [];
	const maxTasks = Number.parseInt(env.PI_META_LOOP_MAX_TASKS ?? "", 10);
	return validateSubmittedPlan(payload as PlanPayload, {
		maxTasks: Number.isFinite(maxTasks) && maxTasks > 0 ? maxTasks : 64,
		scopeCeiling: parseCeiling(env.PI_META_LOOP_SCOPE_CEILING),
	});
}

export function rejectionMessage(errors: string[], attempt: number): string {
	return [
		`submission rejected (attempt ${attempt}/${MAX_SUBMIT_ATTEMPTS}):`,
		...errors.map((e) => `- ${e}`),
		"Fix these and call the tool again.",
	].join("\n");
}

/** Same write discipline as the board: temp file in the same directory, fsync, rename. */
function atomicWrite(file: string, body: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	const fd = fs.openSync(tmp, "w");
	try {
		fs.writeFileSync(fd, body, "utf-8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
}

export default function (pi: ExtensionAPI) {
	const role = (process.env.PI_META_LOOP_ROLE ?? "") as RoleName;
	// The Worker loads exactly one extension, so the guard travels with the tool.
	if (role === "worker") installScopeGuard(pi);

	const submitPath = process.env.PI_META_LOOP_SUBMIT_PATH;
	const spec = TOOLS[role];
	// Without a submission path the harness is reading stdout the old way; adding a
	// tool the parent will not collect would only mislead the model.
	if (!spec || !submitPath) return;

	let attempts = 0;

	pi.registerTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		parameters: spec.schema as never,
		async execute(_toolCallId, params) {
			attempts++;
			const errors = validateSubmission(role, params);
			if (errors.length > 0) {
				if (attempts < MAX_SUBMIT_ATTEMPTS) {
					throw new Error(rejectionMessage(errors, attempts));
				}
				// Looping a role against a budget it cannot meet only burns tokens.
				atomicWrite(
					`${submitPath}.failed.json`,
					JSON.stringify({ tool: spec.name, attempts, errors, payload: params }, null, 2),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Submission budget exhausted (${MAX_SUBMIT_ATTEMPTS} invalid attempts). Stop.`,
						},
					],
					details: {},
					terminate: true,
				};
			}
			atomicWrite(
				submitPath,
				JSON.stringify({ tool: spec.name, payload: params, attempt: attempts, at: new Date().toISOString() }, null, 2),
			);
			return {
				content: [{ type: "text" as const, text: `${spec.name} accepted.` }],
				details: {},
				terminate: true,
			};
		},
	});

	// A role launched with an explicit --tools allowlist would otherwise have no way
	// to answer at all.
	pi.on("session_start", () => {
		try {
			const active = pi.getActiveTools();
			if (!active.includes(spec.name)) pi.setActiveTools([...active, spec.name]);
		} catch {
			/* older hosts without the accessor still work through normal registration */
		}
	});
}
