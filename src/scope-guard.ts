/**
 * Worker scope guard — loaded into worker subprocesses via `pi -e`.
 *
 * Blocks write/edit (and similar) when the target path is outside
 * PI_META_LOOP_ALLOWED_SCOPE or matches PI_META_LOOP_FORBIDDEN.
 *
 * Env (JSON arrays of path rules):
 *   PI_META_LOOP_ALLOWED_SCOPE  e.g. ["src/auth/**","tests/auth/**"]
 *   PI_META_LOOP_FORBIDDEN      e.g. [".env","private/**"]
 *   PI_META_LOOP_CWD            working directory for relative resolution
 *
 * Rule syntax (minimal):
 *   - "src/foo"      → that path or anything under it
 *   - "src/foo/**"   → anything under src/foo
 *   - "*.env"        → basename glob
 *   - exact file path
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function matchRule(relPosix: string, absPosix: string, rule: string): boolean {
	const r = toPosix(rule.trim());
	if (!r) return false;

	// basename glob: *.env
	if (r.startsWith("*.") && !r.includes("/")) {
		const suffix = r.slice(1); // .env
		return relPosix.endsWith(suffix) || absPosix.endsWith(suffix);
	}

	// directory glob: foo/**
	if (r.endsWith("/**")) {
		const prefix = r.slice(0, -3).replace(/\/$/, "");
		return relPosix === prefix || relPosix.startsWith(prefix + "/") || absPosix.includes("/" + prefix + "/");
	}

	// trailing slash = directory prefix
	if (r.endsWith("/")) {
		return relPosix.startsWith(r) || relPosix === r.slice(0, -1);
	}

	// exact or prefix-as-directory
	return relPosix === r || relPosix.startsWith(r + "/") || absPosix.endsWith("/" + r) || absPosix === r;
}

function resolveTarget(filePath: string, cwd: string): { rel: string; abs: string } {
	const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(cwd, filePath));
	let rel = path.relative(cwd, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		// outside cwd — keep abs as identity for matching absolute rules
		rel = abs;
	}
	return { rel: toPosix(rel), abs: toPosix(abs) };
}

export function checkPath(
	filePath: string,
	cwd: string,
	allowed: string[],
	forbidden: string[],
): { ok: true } | { ok: false; reason: string } {
	const { rel, abs } = resolveTarget(filePath, cwd);

	for (const rule of forbidden) {
		if (matchRule(rel, abs, rule)) {
			return { ok: false, reason: `forbidden に一致: ${rule} （対象: ${rel}）` };
		}
	}

	// Empty allowed_scope = no positive restriction (forbidden still applies).
	if (allowed.length === 0) return { ok: true };

	// Outside project cwd when allowed is set → deny unless an absolute rule matches abs.
	const outside = rel === abs && !allowed.some((a) => path.isAbsolute(a) || a.includes(":"));
	if (outside) {
		const hit = allowed.some((rule) => matchRule(rel, abs, rule));
		if (!hit) return { ok: false, reason: `プロジェクト外のパスは許可されていません: ${abs}` };
		return { ok: true };
	}

	if (!allowed.some((rule) => matchRule(rel, abs, rule))) {
		return {
			ok: false,
			reason: `allowed_scope 外: ${rel} （許可: ${allowed.join(", ")}）`,
		};
	}
	return { ok: true };
}

const MUTATING = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
	// Never register orchestrate etc. — this file is worker-only.
	const cwd = process.env.PI_META_LOOP_CWD || process.cwd();
	const allowed = parseList(process.env.PI_META_LOOP_ALLOWED_SCOPE);
	const forbidden = parseList(process.env.PI_META_LOOP_FORBIDDEN);

	// If nothing to enforce, stay silent.
	if (allowed.length === 0 && forbidden.length === 0) return;

	pi.on("tool_call", async (event) => {
		if (!MUTATING.has(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		const filePath = String(input.path ?? input.file_path ?? "");
		if (!filePath) return;

		const result = checkPath(filePath, cwd, allowed, forbidden);
		if (!result.ok) {
			return {
				block: true,
				reason: `pi-metaLoop scope guard: ${result.reason}`,
			};
		}
	});
}
