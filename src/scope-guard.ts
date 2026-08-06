/**
 * Worker scope guard — loaded into worker subprocesses via `pi -e`.
 * Blocks mutating tools when path is outside allowed_scope / matches forbidden.
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

/** Deny-by-default mutating tools (not bash — bash is stripped from Worker by default). */
const MUTATING = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
	const cwd = process.env.PI_META_LOOP_CWD || process.cwd();
	const allowed = parseList(process.env.PI_META_LOOP_ALLOWED_SCOPE);
	const forbidden = parseList(process.env.PI_META_LOOP_FORBIDDEN);
	if (allowed.length === 0 && forbidden.length === 0) return;

	pi.on("tool_call", async (event) => {
		if (!MUTATING.has(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		const filePath = String(input.path ?? input.file_path ?? "");
		if (!filePath) return;
		const result = checkPath(filePath, cwd, allowed, forbidden);
		if (!result.ok) {
			return { block: true, reason: `pi-meta-loop scope guard: ${result.reason}` };
		}
	});
}
