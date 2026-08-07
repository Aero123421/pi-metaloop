/**
 * Path scope checks + post-run git evidence.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function escapeRegexChar(c: string): string {
	return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
}

/** Compile the small glob dialect used by allowed_scope. */
function globBody(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			i++;
			// `**/` means zero or more whole path segments.
			if (glob[i + 1] === "/") {
				i++;
				out += "(?:[^/]+/)*";
			} else {
				out += ".*";
			}
		} else if (c === "*") {
			out += "[^/]*";
		} else if (c === "?") {
			out += "[^/]";
		} else {
			out += escapeRegexChar(c);
		}
	}
	return out;
}

export function matchRule(relPosix: string, absPosix: string, rule: string): boolean {
	let r = toPosix(rule.trim()).replace(/^\.\//, "");
	if (!r) return false;
	const target = path.posix.isAbsolute(r) || /^[a-zA-Z]:\//.test(r) ? absPosix : relPosix;
	const normalizedTarget = target.replace(/\/+$/, "");
	r = r.replace(/\/+$/, "");

	if (r.startsWith("*.") && !r.includes("/")) {
		const suffix = r.slice(1);
		return normalizedTarget.endsWith(suffix) || path.posix.basename(normalizedTarget).endsWith(suffix);
	}

	if (!r.includes("*") && !r.includes("?")) {
		return normalizedTarget === r || normalizedTarget.startsWith(r + "/");
	}

	// A trailing /** includes the directory itself as well as all descendants.
	if (r.endsWith("/**")) {
		const base = r.slice(0, -3).replace(/\/$/, "");
		return new RegExp(`^${globBody(base)}(?:/.*)?$`).test(normalizedTarget);
	}
	return new RegExp(`^${globBody(r)}$`).test(normalizedTarget);
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

/**
 * Files that appeared in `after` but not in the pre-ticket `before` snapshot.
 * Always prefer this over the full dirty tree — falling back to all dirty files
 * attributes previous tickets' uncommitted work to the current ticket (false scope hits).
 */
export function deltaChangedFiles(before: Set<string> | Iterable<string>, after: Iterable<string>): string[] {
	const prior = before instanceof Set ? before : new Set(before);
	const out: string[] = [];
	for (const f of after) {
		const key = toPosix(f);
		if (!prior.has(key) && !prior.has(f)) out.push(key);
	}
	return out;
}

/**
 * Evidence files for a ticket: **delta only** when a before-snapshot was taken.
 * Do not substitute the entire working tree if delta is empty (failed runs often
 * change nothing; prior dirty files must not become scope violations).
 */
export function ticketChangedFiles(before: Set<string>, after: string[]): string[] {
	return deltaChangedFiles(before, after);
}

// ---------------------------------------------------------------------------
// Content-hash git snapshots (detect dirty-content mutation + in-ticket commits)
// ---------------------------------------------------------------------------

export type GitSnapshot = {
	ok: boolean;
	head: string | null;
	indexHash: string | null;
	/** rel posix path → sha256 of worktree bytes (or a missing/error sentinel). */
	fileHashes: Map<string, string>;
	/** Populated when ok=false — git missing, not a repo, or command failure. */
	error?: string;
};

export type GitSnapshotDiff = {
	/** Paths present in `before.fileHashes` whose content hash changed (or disappeared). */
	mutatedPreDirty: string[];
	/** Paths in `after.fileHashes` that were absent from `before.fileHashes`. */
	newFiles: string[];
	headChanged: boolean;
	indexChanged: boolean;
};

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function runGit(
	cwd: string,
	args: string[],
): { ok: true; stdout: string } | { ok: false; stdout: string; error: string } {
	try {
		const r = spawnSync("git", args, {
			cwd,
			encoding: "utf-8",
			timeout: 15_000,
			windowsHide: true,
		});
		if (r.error) {
			return { ok: false, stdout: String(r.stdout ?? ""), error: r.error.message };
		}
		if (r.status !== 0) {
			const err = String(r.stderr ?? "").trim() || `git ${args.join(" ")} exit ${r.status}`;
			return { ok: false, stdout: String(r.stdout ?? ""), error: err };
		}
		return { ok: true, stdout: String(r.stdout ?? "") };
	} catch (e) {
		return { ok: false, stdout: "", error: e instanceof Error ? e.message : String(e) };
	}
}

/** Extract worktree path from one `git status --porcelain=v2 -z` record. */
function parsePorcelainV2Path(record: string): string | null {
	if (!record) return null;
	// With -z, paths are raw/unquoted and may contain spaces, tabs, or newlines.
	if (record.startsWith("? ") || record.startsWith("! ")) return record.slice(2);
	if (record.startsWith("1 ")) {
		// 1 XY sub mH mI mW hH hI path
		return /^1 \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/.exec(record)?.[1] ?? null;
	}
	if (record.startsWith("2 ")) {
		// 2 XY sub mH mI mW hH hI Xscore path\0origPath\0
		return /^2 \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/.exec(record)?.[1] ?? null;
	}
	if (record.startsWith("u ")) {
		// u XY sub m1 m2 m3 mW h1 h2 h3 path
		return /^u \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]+)$/.exec(record)?.[1] ?? null;
	}
	return null;
}

function hashWorktreeFile(cwd: string, relPosix: string): string {
	const abs = path.join(cwd, relPosix);
	try {
		if (!fs.existsSync(abs)) {
			return sha256Hex(`__missing__:${relPosix}`);
		}
		const st = fs.statSync(abs);
		if (st.isDirectory()) {
			return sha256Hex(`__dir__:${relPosix}`);
		}
		return sha256Hex(fs.readFileSync(abs));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return sha256Hex(`__error__:${relPosix}:${msg}`);
	}
}

/**
 * Snapshot HEAD + index + content hashes of dirty tracked/untracked files.
 * Fail-closed: any git/IO failure yields ok=false with error recorded (never silent empty success).
 */
export function captureGitSnapshot(cwd: string): GitSnapshot {
	const fileHashes = new Map<string, string>();
	try {
		const headRes = runGit(cwd, ["rev-parse", "HEAD"]);
		if (!headRes.ok) {
			return {
				ok: false,
				head: null,
				indexHash: null,
				fileHashes,
				error: headRes.error || "failed to read HEAD",
			};
		}
		const head = headRes.stdout.trim() || null;
		if (!head) {
			return {
				ok: false,
				head: null,
				indexHash: null,
				fileHashes,
				error: "empty HEAD",
			};
		}

		const indexRes = runGit(cwd, ["ls-files", "-s"]);
		if (!indexRes.ok) {
			return {
				ok: false,
				head,
				indexHash: null,
				fileHashes,
				error: indexRes.error || "failed to read git index",
			};
		}
		const indexHash = sha256Hex(indexRes.stdout);

		const statusRes = runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!statusRes.ok) {
			return {
				ok: false,
				head,
				indexHash,
				fileHashes,
				error: statusRes.error || "failed to read git status",
			};
		}

		const records = statusRes.stdout.split("\0");
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (!record) continue;
			const rel = parsePorcelainV2Path(record);
			if (!rel) continue;
			const relPosix = toPosix(rel);
			if (!relPosix || relPosix === ".") continue;
			fileHashes.set(relPosix, hashWorktreeFile(cwd, relPosix));
			// Rename/copy records carry the original path as the following NUL record.
			if (record.startsWith("2 ")) i += 1;
		}

		return { ok: true, head, indexHash, fileHashes };
	} catch (e) {
		return {
			ok: false,
			head: null,
			indexHash: null,
			fileHashes,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * Compare two snapshots from captureGitSnapshot.
 * Callers must treat before.ok/after.ok === false as fail-closed before trusting the diff.
 */
export function diffGitSnapshots(before: GitSnapshot, after: GitSnapshot): GitSnapshotDiff {
	const mutatedPreDirty: string[] = [];
	const newFiles: string[] = [];

	for (const [file, hash] of after.fileHashes) {
		if (!before.fileHashes.has(file)) {
			newFiles.push(file);
		} else if (before.fileHashes.get(file) !== hash) {
			mutatedPreDirty.push(file);
		}
	}
	// Pre-dirty path no longer dirty (reverted/committed/deleted from status) ⇒ content state changed.
	for (const file of before.fileHashes.keys()) {
		if (!after.fileHashes.has(file) && !mutatedPreDirty.includes(file)) {
			mutatedPreDirty.push(file);
		}
	}

	return {
		mutatedPreDirty,
		newFiles,
		headChanged: before.head !== after.head,
		indexChanged: before.indexHash !== after.indexHash,
	};
}
