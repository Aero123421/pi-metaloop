/**
 * Worker scope guard — loaded into implementation-worker subprocesses via `pi -e`.
 *
 * Two rules, both enforced at the tool-call gate:
 *
 * - `bash` is denied unconditionally. Per-command shell denylists do not converge —
 *   eight rounds of hardening each closed one more write side-channel (awk, find,
 *   sort, yq, diff, rg, git, less…) and the next one always existed. The 450-line
 *   inspector that grew out of those rounds ended up behind this unconditional deny,
 *   where it could never run; it was removed rather than maintained as decoration.
 * - `write` and `edit` are path checked against the ticket's `allowed_scope`, with
 *   symlinks resolved explicitly so a link inside the scope cannot redirect a write
 *   outside it.
 *
 * The harness also takes bounded pre/post filesystem snapshots. That is a detection
 * backstop, not the enforcement: enforcement is here, before the write happens.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkPath } from "./evidence.ts";

function parseList(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
}

const MUTATING = new Set(["write", "edit"]);

export function denyWorkerBashToolCall(): { block: true; reason: string } {
	return {
		block: true,
		reason:
			"pi-meta-loop scope guard: bash is not available to scoped native workers. " +
			"Build/test is the controller's trusted verify (executor.verifyCommands); " +
			"file changes go through write/edit inside allowed_scope.",
	};
}

/**
 * Install the tool-call guard on an extension host.
 *
 * Split out from the default export so the role-io extension can carry it: a Worker
 * subprocess loads exactly one `-e` extension, and it needs both the guard and its
 * submission tool.
 */
export function installScopeGuard(pi: ExtensionAPI): void {
	const cwd = process.env.PI_META_LOOP_CWD || process.cwd();
	const allowed = parseList(process.env.PI_META_LOOP_ALLOWED_SCOPE);
	const forbidden = parseList(process.env.PI_META_LOOP_FORBIDDEN);

	pi.on("tool_call", async (event) => {
		// Never consult a command inspector here: config, aliases and args cannot
		// re-enable a shell for a scoped worker, so there is nothing to inspect.
		if (event.toolName === "bash") {
			return denyWorkerBashToolCall();
		}

		if (!MUTATING.has(event.toolName)) return;
		if (allowed.length === 0) {
			return {
				block: true,
				reason: "pi-meta-loop scope guard: native implementation worker has empty allowed_scope",
			};
		}
		const input = event.input as Record<string, unknown>;
		const filePath = String(input.path ?? input.file_path ?? "");
		if (!filePath) {
			return { block: true, reason: "pi-meta-loop scope guard: mutating tool path missing" };
		}
		const result = checkPath(filePath, cwd, allowed, forbidden);
		if (!result.ok) return { block: true, reason: `pi-meta-loop scope guard: ${result.reason}` };
	});
}

export default function (pi: ExtensionAPI) {
	installScopeGuard(pi);
}
