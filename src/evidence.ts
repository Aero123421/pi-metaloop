/**
 * Path scope checks + post-run git evidence.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

export function matchRule(relPosix: string, absPosix: string, rule: string): boolean {
	const r = toPosix(rule.trim());
	if (!r) return false;
	if (r.startsWith("*.") && !r.includes("/")) {
		const suffix = r.slice(1);
		return relPosix.endsWith(suffix) || path.posix.basename(relPosix).endsWith(suffix);
	}
	if (r.endsWith("/**")) {
		const prefix = r.slice(0, -3).replace(/\/$/, "");
		return relPosix === prefix || relPosix.startsWith(prefix + "/");
	}
	if (r.endsWith("/")) {
		return relPosix.startsWith(r) || relPosix === r.slice(0, -1);
	}
	return relPosix === r || relPosix.startsWith(r + "/");
}

/** Resolve path; prefer realpath when the target exists. */
export function resolvePath(filePath: string, cwd: string): { rel: string; abs: string } {
	const joined = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(cwd, filePath));
	let abs = joined;
	try {
		if (fs.existsSync(joined)) abs = fs.realpathSync(joined);
		else {
			// realpath parent if possible (symlink dirs)
			const parent = path.dirname(joined);
			if (fs.existsSync(parent)) {
				abs = path.join(fs.realpathSync(parent), path.basename(joined));
			}
		}
	} catch {
		abs = joined;
	}
	abs = path.normalize(abs);
	let cwdReal = cwd;
	try {
		cwdReal = fs.realpathSync(cwd);
	} catch {
		/* keep */
	}
	let rel = path.relative(cwdReal, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		rel = abs; // outside
	}
	// Windows: compare case-insensitively via lowercased posix forms for matching
	return { rel: toPosix(rel), abs: toPosix(abs) };
}

export function checkPath(
	filePath: string,
	cwd: string,
	allowed: string[],
	forbidden: string[],
): { ok: true } | { ok: false; reason: string } {
	const { rel, abs } = resolvePath(filePath, cwd);
	const relKey = process.platform === "win32" ? rel.toLowerCase() : rel;
	const absKey = process.platform === "win32" ? abs.toLowerCase() : abs;
	const normRule = (r: string) => (process.platform === "win32" ? r.toLowerCase() : r);

	for (const rule of forbidden) {
		if (matchRule(relKey, absKey, normRule(rule))) {
			return { ok: false, reason: `forbidden matched: ${rule} (target: ${rel})` };
		}
	}
	if (allowed.length === 0) return { ok: true };

	const outside = rel === abs || relKey.includes(":");
	if (outside) {
		return { ok: false, reason: `path outside project cwd is not allowed: ${abs}` };
	}
	if (!allowed.some((rule) => matchRule(relKey, absKey, normRule(rule)))) {
		return { ok: false, reason: `outside allowed_scope: ${rel} (allowed: ${allowed.join(", ")})` };
	}
	return { ok: true };
}

/** Collect changed/untracked files via git (best-effort). */
export function collectGitChangedFiles(cwd: string): string[] {
	try {
		const tracked = spawnSync("git", ["diff", "--name-only", "HEAD"], {
			cwd,
			encoding: "utf-8",
			timeout: 15_000,
		});
		const porcelain = spawnSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf-8",
			timeout: 15_000,
		});
		const set = new Set<string>();
		if (tracked.status === 0 && tracked.stdout) {
			for (const line of tracked.stdout.split(/\r?\n/)) {
				const t = line.trim();
				if (t) set.add(toPosix(t));
			}
		}
		if (porcelain.status === 0 && porcelain.stdout) {
			for (const line of porcelain.stdout.split(/\r?\n/)) {
				if (!line.trim()) continue;
				// XY<path> or rename
				const file = line.slice(3).trim().split(" -> ").pop();
				if (file) set.add(toPosix(file.replace(/^"|"$/g, "")));
			}
		}
		return [...set];
	} catch {
		return [];
	}
}

export function findScopeViolations(
	changedFiles: string[],
	cwd: string,
	allowed: string[],
	forbidden: string[],
): string[] {
	if (allowed.length === 0 && forbidden.length === 0) return [];
	const violations: string[] = [];
	for (const f of changedFiles) {
		const r = checkPath(f, cwd, allowed, forbidden);
		if (!r.ok) violations.push(`${f}: ${r.reason}`);
	}
	return violations;
}
