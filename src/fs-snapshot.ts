/**
 * Bounded pre/post filesystem snapshots for implementation-worker tickets.
 *
 * Git evidence cannot see ignored files or paths outside the worktree. This
 * snapshot covers the complete ticket cwd plus a bounded neighbourhood below
 * its parent. Traversal failures and hard coverage limits are explicit errors;
 * callers must fail the ticket rather than treating an incomplete snapshot as
 * evidence of no writes.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { toPosix } from "./evidence.ts";

export interface FilesystemSnapshotLimits {
	/** Maximum entries across the cwd and parent-neighbourhood scans. */
	maxEntries: number;
	/** Maximum recursion below cwd. Reaching a deeper entry fails closed. */
	cwdMaxDepth: number;
	/** Neighbourhood depth below cwd's parent (cwd itself is scanned separately). */
	parentMaxDepth: number;
	/** Maximum synchronous snapshot wall time. */
	timeoutMs: number;
	/** Files at or below this size receive a content hash as well as metadata. */
	hashFileMaxBytes: number;
	/** Bounded total content bytes hashed; metadata remains for later files. */
	maxHashBytes: number;
}

export const DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS: FilesystemSnapshotLimits = {
	maxEntries: 250_000,
	cwdMaxDepth: 64,
	parentMaxDepth: 3,
	timeoutMs: 30_000,
	hashFileMaxBytes: 256 * 1024,
	maxHashBytes: 32 * 1_048_576,
};

export type FilesystemEntryKind = "file" | "directory" | "symlink" | "other";

export interface FilesystemEntrySnapshot {
	kind: FilesystemEntryKind;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	mode: number;
	/** Content hash for bounded regular files, or symlink target hash. */
	hash?: string;
	/**
	 * Stable owner identity for the host-managed owner lock. `heartbeatAt` is
	 * deliberately excluded; every other JSON field remains semantic.
	 */
	ownerLockSemanticHash?: string;
}

export interface FilesystemSnapshot {
	ok: boolean;
	cwd: string;
	parent: string;
	entries: Map<string, FilesystemEntrySnapshot>;
	entryCount: number;
	hashedBytes: number;
	elapsedMs: number;
	error?: string;
}

export interface FilesystemSnapshotDiff {
	added: string[];
	modified: string[];
	deleted: string[];
	/** Added/modified/deleted paths, de-duplicated. */
	changedPaths: string[];
}

function canonicalExisting(p: string): string {
	try {
		return path.normalize(fs.realpathSync(p));
	} catch {
		return path.normalize(path.resolve(p));
	}
}

function keyPath(p: string): string {
	const normalized = toPosix(path.normalize(p));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
	return keyPath(a) === keyPath(b);
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function entryKind(st: fs.Stats): FilesystemEntryKind {
	if (st.isFile()) return "file";
	if (st.isDirectory()) return "directory";
	if (st.isSymbolicLink()) return "symlink";
	return "other";
}

function sameEntry(a: FilesystemEntrySnapshot, b: FilesystemEntrySnapshot): boolean {
	if (a.ownerLockSemanticHash !== undefined || b.ownerLockSemanticHash !== undefined) {
		// A valid owner lock is rewritten atomically for every host heartbeat. Ignore
		// the resulting size/timestamp/content changes only when the parsed lock's
		// complete semantics (apart from heartbeatAt) and file mode are unchanged.
		// A valid↔malformed transition therefore remains a detected modification.
		return (
			a.kind === b.kind &&
			a.mode === b.mode &&
			a.ownerLockSemanticHash !== undefined &&
			a.ownerLockSemanticHash === b.ownerLockSemanticHash
		);
	}
	return (
		a.kind === b.kind &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.mode === b.mode &&
		// The total hash budget is an optimisation bound. A new early-sorted file
		// can shift which later files are hashed, so compare hashes only when both
		// snapshots captured one; metadata remains mandatory for every file.
		(a.hash === undefined || b.hash === undefined || a.hash === b.hash)
	);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

/** Parse only the known-valid owner-lock shape; malformed content stays fail-closed. */
function ownerLockSemanticHash(raw: Buffer): string | undefined {
	try {
		const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return undefined;
		if (typeof parsed.hostname !== "string" || typeof parsed.runId !== "string") return undefined;
		if (typeof parsed.generation !== "string" || typeof parsed.acquiredAt !== "string") return undefined;
		if (typeof parsed.heartbeatAt !== "string") return undefined;
		if (typeof parsed.leaseSec !== "number" || !Number.isFinite(parsed.leaseSec) || parsed.leaseSec <= 0) {
			return undefined;
		}
		const semantic = { ...parsed };
		delete semantic.heartbeatAt;
		return sha256(stableJson(semantic));
	} catch {
		return undefined;
	}
}

/**
 * Capture cwd recursively and cwd's parent neighbourhood. `.git` internals are
 * excluded: HEAD/index are checked separately with semantic git snapshots and
 * read-only git commands may refresh implementation-detail metadata there.
 */
export function captureFilesystemSnapshot(
	cwd: string,
	overrides: Partial<FilesystemSnapshotLimits> = {},
): FilesystemSnapshot {
	const limits = { ...DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS, ...overrides };
	const started = Date.now();
	const cwdReal = canonicalExisting(cwd);
	const parentReal = canonicalExisting(path.dirname(cwdReal));
	const ownerLockReal = path.join(cwdReal, ".pi", "meta-loop", "runs", "owner.lock.json");
	const entries = new Map<string, FilesystemEntrySnapshot>();
	let entryCount = 0;
	let hashedBytes = 0;
	let error: string | undefined;

	const fail = (message: string): never => {
		throw new Error(message);
	};
	const checkBudget = (target: string): void => {
		if (Date.now() - started > limits.timeoutMs) {
			fail(`filesystem snapshot timeout (${limits.timeoutMs}ms) at ${target}`);
		}
		if (entryCount >= limits.maxEntries) {
			fail(`filesystem snapshot entry limit (${limits.maxEntries}) exceeded at ${target}`);
		}
	};

	const record = (abs: string, st: fs.Stats): void => {
		checkBudget(abs);
		entryCount += 1;
		const kind = entryKind(st);
		const item: FilesystemEntrySnapshot = {
			kind,
			size: st.size,
			mtimeMs: st.mtimeMs,
			ctimeMs: st.ctimeMs,
			mode: st.mode,
		};
		if (kind === "symlink") {
			item.hash = sha256(fs.readlinkSync(abs));
		} else if (kind === "file") {
			let contents: Buffer | undefined;
			if (samePath(abs, ownerLockReal)) {
				contents = fs.readFileSync(abs);
				item.ownerLockSemanticHash = ownerLockSemanticHash(contents);
			}
			if (st.size <= limits.hashFileMaxBytes && hashedBytes + st.size <= limits.maxHashBytes) {
				contents ??= fs.readFileSync(abs);
				item.hash = sha256(contents);
				hashedBytes += st.size;
			}
		}
		entries.set(keyPath(abs), item);
	};

	const scanDirectory = (
		root: string,
		maxDepth: number,
		opts: { skipCwdSubtree?: boolean; hardDepthLimit: boolean },
	): void => {
		const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
		while (stack.length > 0) {
			const current = stack.pop()!;
			checkBudget(current.dir);
			let children: fs.Dirent[] = [];
			try {
				children = fs.readdirSync(current.dir, { withFileTypes: true });
			} catch (e) {
				fail(`filesystem snapshot cannot read ${current.dir}: ${e instanceof Error ? e.message : String(e)}`);
			}
			children.sort((a, b) => a.name.localeCompare(b.name));
			for (const child of children) {
				const abs = path.join(current.dir, child.name);
				// Git state has its own HEAD/index snapshot. Never traverse a .git dir.
				if (child.name === ".git" && child.isDirectory()) continue;
				if (opts.skipCwdSubtree && samePath(abs, cwdReal)) continue;
				let st: fs.Stats | undefined;
				try {
					st = fs.lstatSync(abs);
					record(abs, st);
				} catch (e) {
					fail(`filesystem snapshot cannot stat/read ${abs}: ${e instanceof Error ? e.message : String(e)}`);
				}
				if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
				if (current.depth >= maxDepth) {
					if (opts.hardDepthLimit) {
						fail(`filesystem snapshot cwd depth limit (${maxDepth}) exceeded at ${abs}`);
					}
					// Parent scan is deliberately a bounded neighbourhood, not full coverage
					// of unrelated sibling projects.
					continue;
				}
				stack.push({ dir: abs, depth: current.depth + 1 });
			}
		}
	};

	try {
		const rootStat = fs.lstatSync(cwdReal);
		if (!rootStat.isDirectory()) fail(`filesystem snapshot cwd is not a directory: ${cwdReal}`);
		scanDirectory(cwdReal, limits.cwdMaxDepth, { hardDepthLimit: true });
		// Include direct parent files and a realistic bounded sibling neighbourhood.
		// This detects `../file`, sibling writes, and interpreter/redirection bypasses.
		scanDirectory(parentReal, limits.parentMaxDepth, {
			skipCwdSubtree: true,
			hardDepthLimit: false,
		});
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	return {
		ok: error === undefined,
		cwd: cwdReal,
		parent: parentReal,
		entries,
		entryCount,
		hashedBytes,
		elapsedMs: Date.now() - started,
		error,
	};
}

/** Compare successful pre/post snapshots. Callers must reject ok=false first. */
export function diffFilesystemSnapshots(
	before: FilesystemSnapshot,
	after: FilesystemSnapshot,
): FilesystemSnapshotDiff {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const [file, next] of after.entries) {
		const prior = before.entries.get(file);
		if (!prior) added.push(file);
		// Directory mtimes change when an allowed child is created/deleted. Reporting
		// those metadata-only changes would falsely attribute every write to all
		// ancestor directories; new/deleted directories remain observable.
		else if (next.kind !== "directory" && !sameEntry(prior, next)) modified.push(file);
	}
	for (const file of before.entries.keys()) {
		if (!after.entries.has(file)) deleted.push(file);
	}

	// Suppress newly-created/deleted ancestor directories when their child change
	// is already present. Otherwise an exact allowed file (for example
	// `src/new/file.ts`) would falsely violate scope merely because its parent had
	// to be created. Empty-directory writes remain observable.
	const nonDirectoryChanges = [...added, ...modified, ...deleted].filter((file) => {
		const item = after.entries.get(file) ?? before.entries.get(file);
		return item?.kind !== "directory";
	});
	const hasChangedDescendant = (directory: string): boolean => {
		const prefix = directory.replace(/\/+$/u, "") + "/";
		return nonDirectoryChanges.some((file) => file.startsWith(prefix));
	};
	const filteredAdded = added.filter((file) => after.entries.get(file)?.kind !== "directory" || !hasChangedDescendant(file));
	const filteredDeleted = deleted.filter((file) => before.entries.get(file)?.kind !== "directory" || !hasChangedDescendant(file));
	const changedPaths = [...new Set([...filteredAdded, ...modified, ...filteredDeleted])];
	return { added: filteredAdded, modified, deleted: filteredDeleted, changedPaths };
}

/** Render a monitored absolute path as cwd-relative when it is inside cwd. */
export function filesystemEvidencePath(absPath: string, cwd: string): string {
	const cwdReal = canonicalExisting(cwd);
	const rel = path.relative(cwdReal, absPath);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
	if (rel === "") return ".";
	return toPosix(path.normalize(absPath));
}
