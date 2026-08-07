/**
 * Persist supervised boards under .pi/meta-loop/runs/ for TUI + resume visibility.
 * Writes are atomic (temp + fsync + rename). runId is containment-validated.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskBoard, Verdict } from "./types.ts";

export type RunStatus = "running" | "done" | "error" | "stopped" | "incomplete";

export interface PersistedRun {
	runId: string;
	cwd: string;
	goal: string;
	status: RunStatus;
	label: string;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	board: TaskBoard;
	verdicts: Verdict[];
	summary?: string;
	error?: string;
	/** Short live activity (worker progress tail) */
	activity?: string;
}

export interface OwnerLockHolder {
	pid: number;
	hostname: string;
	runId: string;
	/** Unique ownership generation. Handles must match this token before mutating the lock. */
	generation: string;
	acquiredAt: string;
	heartbeatAt: string;
	leaseSec: number;
}

export type OwnerLockHandle =
	| {
			ok: true;
			/** Heartbeat. Returns false when generation is missing/mismatched (ownership lost). */
			refresh: () => boolean;
			release: () => void;
	  }
	| {
			ok: false;
			holder: OwnerLockHolder | null;
			reason: string;
	  };

const OWNER_LOCK_NAME = "owner.lock.json";
const LATEST_NAME = "latest.json";
const DEFAULT_LEASE_SEC = 60;
// Generation critical sections contain only synchronous filesystem operations.
// A guard this old is abandoned (important for remote hosts, whose PID cannot be probed).
const GENERATION_GUARD_STALE_MS = 60_000;

interface GenerationGuardOwner {
	token: string;
	pid: number;
	hostname: string;
	generation: string;
	createdAt: string;
}

interface FileIdentity {
	dev: bigint;
	ino: bigint;
}

interface GenerationGuardSnapshot extends FileIdentity {
	raw: string;
	owner: GenerationGuardOwner | null;
	mtimeMs: number;
}

interface GuardClaimant {
	token: string;
	pid: number;
	hostname: string;
	/** Election metadata only. Never use a claimant's wall clock for lease expiry. */
	createdAtMs: number;
}

interface GuardClaimMarkerSnapshot extends FileIdentity {
	claimant: GuardClaimant | null;
	mtimeMs: number;
}

interface GuardClaimEntry {
	path: string;
	name: string;
	sequence: number;
	claimant: GuardClaimant;
	snapshot: GenerationGuardSnapshot;
	leasePath: string;
	lease: GuardClaimMarkerSnapshot | null;
}

/** runId: [A-Za-z0-9_-] only — rejects path separators, '..', and empty. */
export function isValidRunId(runId: string): boolean {
	if (typeof runId !== "string" || runId.length === 0 || runId.length > 200) return false;
	// Explicit traversal / separator guards (also excluded by the charset).
	if (runId === "." || runId === ".." || runId.includes("..")) return false;
	if (runId.includes("/") || runId.includes("\\") || runId.includes("\0")) return false;
	if (runId.includes(path.sep) && path.sep !== "/" && path.sep !== "\\") return false;
	return /^[A-Za-z0-9_-]+$/.test(runId);
}

/** Map board phase (+ abort) to persisted run status. */
export function runStatusFromPhase(phase: string, aborted: boolean): RunStatus {
	if (aborted || phase === "stopped") return "stopped";
	if (phase === "done") return "done";
	if (phase === "incomplete") return "incomplete";
	if (phase === "plan_failed" || phase === "degraded") return "error";
	return "error";
}

/** Elapsed that freezes after finishedAt/updatedAt when not running. */
export function runElapsed(run: Pick<PersistedRun, "startedAt" | "finishedAt" | "updatedAt" | "status">): string {
	if (run.status === "running" && !run.finishedAt) {
		return formatElapsed(run.startedAt);
	}
	const end = run.finishedAt
		? Date.parse(run.finishedAt)
		: run.updatedAt
			? Date.parse(run.updatedAt)
			: Date.now();
	return formatElapsed(run.startedAt, Number.isFinite(end) ? end : Date.now());
}

export function writeArtifact(cwd: string, runId: string, name: string, content: string): string | null {
	try {
		if (!isValidRunId(runId)) return null;
		// Artifact names must stay inside the run dir (no traversal).
		if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
			return null;
		}
		const dir = ensureRunDir(cwd, runId);
		const file = path.join(dir, name);
		atomicWriteFile(file, content);
		assertWrittenPathInsideCwd(cwd, file);
		return file;
	} catch {
		return null;
	}
}

/** Cooperative stop signal (disk). Polled by the extension; works across agents. */
export function stopRequestPath(cwd: string, runId: string): string {
	return path.join(runDir(cwd, runId), "STOP");
}

export function requestStop(cwd: string, runId: string, reason = "user"): void {
	try {
		if (!isValidRunId(runId)) return;
		ensureRunDir(cwd, runId);
		atomicWriteFile(stopRequestPath(cwd, runId), `${reason} ${new Date().toISOString()}\n`);
	} catch {
		/* */
	}
}

export function hasStopRequest(cwd: string, runId: string): boolean {
	try {
		if (!isValidRunId(runId)) return false;
		return fs.existsSync(stopRequestPath(cwd, runId));
	} catch {
		return false;
	}
}

export function clearStopRequest(cwd: string, runId: string): void {
	try {
		if (!isValidRunId(runId)) return;
		fs.rmSync(stopRequestPath(cwd, runId), { force: true });
	} catch {
		/* */
	}
}

function runsRoot(cwd: string): string {
	return path.join(cwd, ".pi", "meta-loop", "runs");
}

function pathKey(p: string): string {
	const n = path.normalize(p);
	return process.platform === "win32" ? n.toLowerCase() : n;
}

function isPathInside(root: string, target: string): boolean {
	const rootN = path.normalize(root);
	const targetN = path.normalize(target);
	if (pathKey(rootN) === pathKey(targetN)) return true;
	const prefix = rootN.endsWith(path.sep) ? rootN : rootN + path.sep;
	return pathKey(targetN).startsWith(pathKey(prefix));
}

function canonicalRealpath(p: string): string {
	return path.normalize(fs.realpathSync(p));
}

/** Reject symlink/junction components so board writes cannot leave the project cwd. */
function assertNotSymlink(absPath: string): fs.Stats {
	const st = fs.lstatSync(absPath);
	if (st.isSymbolicLink()) {
		throw new Error(`symlink/junction rejected in meta-loop path: ${absPath}`);
	}
	return st;
}

function resolveCanonicalCwd(cwd: string): string {
	const abs = path.resolve(cwd);
	const st = assertNotSymlink(abs);
	if (!st.isDirectory()) {
		throw new Error(`cwd is not a directory: ${abs}`);
	}
	return canonicalRealpath(abs);
}

/**
 * Create/validate a real directory chain under cwd. Each existing component is
 * lstat'd (symlink/junction → fail closed). After creation, realpath must stay
 * inside the canonical project cwd.
 */
function ensureSafeDirectoryChain(cwd: string, segments: string[]): string {
	const cwdReal = resolveCanonicalCwd(cwd);
	let current = cwdReal;
	for (const segment of segments) {
		if (
			!segment ||
			segment === "." ||
			segment === ".." ||
			segment.includes("/") ||
			segment.includes("\\") ||
			segment.includes("\0") ||
			(segment.includes(path.sep) && path.sep !== "/" && path.sep !== "\\")
		) {
			throw new Error(`invalid meta-loop path segment: ${JSON.stringify(segment)}`);
		}
		const next = path.join(current, segment);
		if (fs.existsSync(next)) {
			const st = assertNotSymlink(next);
			if (!st.isDirectory()) {
				throw new Error(`meta-loop path component is not a directory: ${next}`);
			}
		} else {
			fs.mkdirSync(next, { recursive: false });
			assertNotSymlink(next);
		}
		current = canonicalRealpath(next);
		if (!isPathInside(cwdReal, current)) {
			throw new Error(`meta-loop path escapes project cwd: ${current}`);
		}
	}
	return current;
}

function ensureMetaLoopRunsRoot(cwd: string): string {
	return ensureSafeDirectoryChain(cwd, [".pi", "meta-loop", "runs"]);
}

/**
 * Create/validate a real non-symlink directory under `.pi/meta-loop/<segments>`.
 * Used by board artifacts and sfh flow writes alike.
 */
export function ensureMetaLoopSubdir(cwd: string, ...segments: string[]): string {
	if (segments.length === 0) {
		throw new Error("ensureMetaLoopSubdir requires at least one segment under .pi/meta-loop");
	}
	return ensureSafeDirectoryChain(cwd, [".pi", "meta-loop", ...segments]);
}

/** After a controller write, confirm the real path remains under project cwd. */
export function assertMetaLoopWriteInsideCwd(cwd: string, filePath: string): void {
	assertWrittenPathInsideCwd(cwd, filePath);
}

/** After a write, confirm the resulting real path remains under canonical cwd. */
function assertWrittenPathInsideCwd(cwd: string, filePath: string): void {
	const cwdReal = resolveCanonicalCwd(cwd);
	const abs = path.resolve(filePath);
	// Walk existing parents and reject symlink components (TOCTOU residual check).
	let cursor = abs;
	const seen: string[] = [];
	while (pathKey(cursor) !== pathKey(path.parse(cursor).root) && cursor !== path.dirname(cursor)) {
		seen.push(cursor);
		cursor = path.dirname(cursor);
		if (isPathInside(cwdReal, cursor) || pathKey(cursor) === pathKey(cwdReal)) break;
	}
	for (const p of seen.reverse()) {
		if (!fs.existsSync(p)) continue;
		assertNotSymlink(p);
	}
	const real = fs.existsSync(abs)
		? canonicalRealpath(abs)
		: path.join(canonicalRealpath(path.dirname(abs)), path.basename(abs));
	if (!isPathInside(cwdReal, real)) {
		throw new Error(`meta-loop write escaped project cwd: ${real}`);
	}
}

function assertRunIdContained(cwd: string, runId: string): string {
	if (!isValidRunId(runId)) {
		throw new Error(`Invalid runId (fail closed): ${JSON.stringify(runId)}`);
	}
	const root = path.resolve(runsRoot(cwd));
	const dir = path.resolve(root, runId);
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	if (dir !== root && !dir.startsWith(prefix)) {
		throw new Error(`runId escapes runs root: ${JSON.stringify(runId)}`);
	}
	// path.resolve would collapse ".." — still ensure the final segment is exactly runId
	if (path.basename(dir) !== runId) {
		throw new Error(`runId containment check failed: ${JSON.stringify(runId)}`);
	}
	return dir;
}

export function runDir(cwd: string, runId: string): string {
	return assertRunIdContained(cwd, runId);
}

export function createRunId(): string {
	const t = new Date().toISOString().replace(/[:.]/g, "-");
	const r = Math.random().toString(36).slice(2, 8);
	return `${t}-${r}`;
}

export function ensureRunDir(cwd: string, runId: string): string {
	if (!isValidRunId(runId)) {
		throw new Error(`Invalid runId (fail closed): ${JSON.stringify(runId)}`);
	}
	// Validate lexical containment first, then create a symlink-free real chain.
	assertRunIdContained(cwd, runId);
	return ensureSafeDirectoryChain(cwd, [".pi", "meta-loop", "runs", runId]);
}

/**
 * Atomic file write: temp file in the same directory → fsync → rename.
 * Windows-safe when the destination already exists.
 */
export function atomicWriteFile(filePath: string, content: string | Buffer): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const base = path.basename(filePath);
	const tmp = path.join(
		dir,
		`.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
	);
	try {
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeFileSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		// Node's rename maps to an atomic replace on supported filesystems. Never
		// delete the destination first: that would create a visibility gap.
		fs.renameSync(tmp, filePath);
		// Persist the directory entry where the platform permits fsync on directories.
		try {
			const dirFd = fs.openSync(dir, "r");
			try {
				fs.fsyncSync(dirFd);
			} finally {
				fs.closeSync(dirFd);
			}
		} catch {
			/* Windows commonly rejects opening/fsyncing directories. */
		}
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* */
		}
		throw err;
	}
}

export function writeRun(cwd: string, run: PersistedRun): void {
	if (!isValidRunId(run.runId)) {
		throw new Error(`Invalid runId (fail closed): ${JSON.stringify(run.runId)}`);
	}
	const dir = ensureRunDir(cwd, run.runId);
	const root = ensureMetaLoopRunsRoot(cwd);
	const payload = { ...run, updatedAt: new Date().toISOString() };
	const boardPath = path.join(dir, "board.json");
	atomicWriteFile(boardPath, JSON.stringify(payload, null, 2));
	assertWrittenPathInsideCwd(cwd, boardPath);
	// Pointer for latest run (Windows-safe; no symlink)
	const latestPath = path.join(root, LATEST_NAME);
	atomicWriteFile(
		latestPath,
		JSON.stringify({ runId: run.runId, updatedAt: payload.updatedAt }, null, 2),
	);
	assertWrittenPathInsideCwd(cwd, latestPath);
	if (payload.summary) {
		const summaryPath = path.join(dir, "summary.md");
		atomicWriteFile(summaryPath, payload.summary);
		assertWrittenPathInsideCwd(cwd, summaryPath);
	}
}

export function readRun(cwd: string, runId: string): PersistedRun | null {
	if (!isValidRunId(runId)) return null;
	const file = path.join(runDir(cwd, runId), "board.json");
	try {
		const raw = fs.readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw) as PersistedRun;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

export function readLatestRun(cwd: string): PersistedRun | null {
	try {
		const raw = fs.readFileSync(path.join(runsRoot(cwd), LATEST_NAME), "utf-8");
		const ptr = JSON.parse(raw) as { runId?: string };
		if (!ptr?.runId || !isValidRunId(ptr.runId)) return null;
		return readRun(cwd, ptr.runId);
	} catch {
		return null;
	}
}

export function listRuns(cwd: string, limit = 10): PersistedRun[] {
	const root = runsRoot(cwd);
	let names: string[] = [];
	try {
		names = fs.readdirSync(root).filter((n) => {
			if (n === LATEST_NAME || n === OWNER_LOCK_NAME) return false;
			if (n.startsWith(".")) return false;
			if (!isValidRunId(n)) return false;
			try {
				return fs.statSync(path.join(root, n)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
	const runs: PersistedRun[] = [];
	for (const name of names) {
		const r = readRun(cwd, name);
		if (r) runs.push(r);
	}
	runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return runs.slice(0, limit);
}

export function ticketCounts(board: TaskBoard): {
	total: number;
	done: number;
	running: number;
	pending: number;
	failed: number;
	partial: number;
	blocked: number;
} {
	const tickets = board.tickets ?? [];
	const count = (s: string) => tickets.filter((t) => t.status === s).length;
	return {
		total: tickets.length,
		done: count("done"),
		running: count("running"),
		pending: count("pending"),
		failed: count("failed") + count("cancelled"),
		partial: count("partial"),
		blocked: count("blocked"),
	};
}

export function formatElapsed(startedAt: string, now = Date.now()): string {
	const ms = Math.max(0, now - Date.parse(startedAt));
	const sec = Math.floor(ms / 1000);
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m >= 60) {
		const h = Math.floor(m / 60);
		return `${h}h${m % 60}m`;
	}
	return m > 0 ? `${m}m${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function ownerLockPath(cwd: string): string {
	return path.join(runsRoot(cwd), OWNER_LOCK_NAME);
}

function readOwnerLockFile(lockPath: string): OwnerLockHolder | null {
	try {
		const raw = fs.readFileSync(lockPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<OwnerLockHolder>;
		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return null;
		if (typeof parsed.hostname !== "string") return null;
		if (typeof parsed.runId !== "string") return null;
		if (typeof parsed.generation !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(parsed.generation)) {
			return null;
		}
		if (typeof parsed.acquiredAt !== "string") return null;
		if (typeof parsed.heartbeatAt !== "string") return null;
		const leaseSec =
			typeof parsed.leaseSec === "number" && Number.isFinite(parsed.leaseSec) && parsed.leaseSec > 0
				? parsed.leaseSec
				: DEFAULT_LEASE_SEC;
		return {
			pid: parsed.pid,
			hostname: parsed.hostname,
			runId: parsed.runId,
			generation: parsed.generation,
			acquiredAt: parsed.acquiredAt,
			heartbeatAt: parsed.heartbeatAt,
			leaseSec,
		};
	} catch {
		return null;
	}
}

/** Best-effort PID liveness. EPERM ⇒ alive; ESRCH / missing ⇒ dead. */
export function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "EPERM") return true;
		return false;
	}
}

export function isOwnerLockStale(holder: OwnerLockHolder, now = Date.now()): boolean {
	// Liveness wins over wall-clock metadata on this host. A live process may have
	// paused longer than its lease and must never be overlapped by a takeover.
	if (holder.hostname === os.hostname()) {
		try {
			return !isPidAlive(holder.pid);
		} catch {
			return false;
		}
	}
	// A remote PID cannot be probed, so its heartbeat lease is the fallback.
	const leaseMs = Math.max(1, holder.leaseSec || DEFAULT_LEASE_SEC) * 1000;
	const hb = Date.parse(holder.heartbeatAt);
	return !Number.isFinite(hb) || now - hb > leaseMs;
}

function sameGeneration(a: OwnerLockHolder | null, b: OwnerLockHolder): boolean {
	return a?.generation === b.generation;
}

function processOwnsLock(holder: OwnerLockHolder | null, runId: string): boolean {
	if (!holder) return false;
	return holder.pid === process.pid && holder.hostname === os.hostname() && holder.runId === runId;
}

function generationGuardPath(lockPath: string, generation: string): string {
	return path.join(path.dirname(lockPath), `.${OWNER_LOCK_NAME}.${generation}.guard`);
}

function readGenerationGuard(guardPath: string, expectedGeneration: string): GenerationGuardSnapshot | null {
	let fd: number | null = null;
	try {
		// Read and identify one opened inode. A pathname read followed by stat could
		// otherwise combine the content of an old guard with a replacement inode.
		fd = fs.openSync(guardPath, "r");
		const raw = fs.readFileSync(fd, "utf8");
		const stat = fs.fstatSync(fd, { bigint: true });
		let owner: GenerationGuardOwner | null = null;
		try {
			const parsed = JSON.parse(raw) as Partial<GenerationGuardOwner>;
			if (
				parsed && typeof parsed === "object"
				&& typeof parsed.token === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(parsed.token)
				&& typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0
				&& typeof parsed.hostname === "string"
				&& parsed.generation === expectedGeneration
				&& typeof parsed.createdAt === "string"
			) {
				owner = parsed as GenerationGuardOwner;
			}
		} catch {
			/* A partial/legacy guard is recoverable after its filesystem age expires. */
		}
		return { raw, owner, mtimeMs: Number(stat.mtimeMs), dev: stat.dev, ino: stat.ino };
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* */
			}
		}
	}
}

function sameGuardSnapshot(a: GenerationGuardSnapshot | null, b: GenerationGuardSnapshot): boolean {
	if (!a) return false;
	if (a.owner && b.owner) return a.owner.token === b.owner.token;
	return a.raw === b.raw && a.mtimeMs === b.mtimeMs;
}

function sameFileIdentity(a: FileIdentity | null, b: FileIdentity): boolean {
	return a?.dev === b.dev && a.ino === b.ino;
}

function sameGuardInode(a: GenerationGuardSnapshot | null, b: GenerationGuardSnapshot): boolean {
	return sameFileIdentity(a, b);
}

/**
 * Unlink a failed O_EXCL publication only while its pathname still names the
 * inode opened by this writer. A valid replacement identity is an additional
 * fail-closed check. (The final unlink cannot be made conditional portably,
 * but legitimate writers never reuse these publication paths.)
 */
function removeFailedExclusivePublication(
	filePath: string,
	opened: FileIdentity,
	expectedIdentity?: { field: "token" | "generation"; value: string },
): boolean {
	let fd: number | null = null;
	try {
		fd = fs.openSync(filePath, "r");
		const raw = fs.readFileSync(fd, "utf8");
		const current = fs.fstatSync(fd, { bigint: true });
		if (current.dev !== opened.dev || current.ino !== opened.ino) return false;
		if (expectedIdentity) {
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				const currentIdentity = parsed?.[expectedIdentity.field];
				if (typeof currentIdentity === "string" && currentIdentity !== expectedIdentity.value) return false;
			} catch {
				// A partial write need not contain parseable identity metadata. Matching
				// the originally opened inode is sufficient for that failed publication.
			}
		}
	} catch {
		return false;
	} finally {
		if (fd !== null) {
			try { fs.closeSync(fd); } catch { /* */ }
		}
	}
	try {
		fs.rmSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function isGenerationGuardStale(snapshot: GenerationGuardSnapshot, now = Date.now()): boolean {
	const owner = snapshot.owner;
	// Never time out a locally live process: a paused holder could resume its
	// synchronous compare-and-mutate section after a contender had taken over.
	if (owner?.hostname === os.hostname()) return !isPidAlive(owner.pid);
	// A remote PID cannot be probed. Use publication mtime rather than the
	// remote clock's createdAt, which may be skewed.
	return !Number.isFinite(snapshot.mtimeMs) || now - snapshot.mtimeMs > GENERATION_GUARD_STALE_MS;
}

function guardClaimDigest(generation: string, snapshot: GenerationGuardSnapshot): string {
	// Keep filenames short even when generation is near its 200-character limit.
	const identity = snapshot.owner?.token ?? snapshot.raw;
	return createHash("sha256").update(generation).update("\0").update(identity).digest("hex").slice(0, 32);
}

function guardClaimantIsStale(
	claimant: GuardClaimant,
	lease: GuardClaimMarkerSnapshot | null,
	now = Date.now(),
): boolean {
	// Never reclaim a locally live claimant, even after a long scheduler pause.
	if (claimant.hostname === os.hostname()) return !isPidAlive(claimant.pid);
	// Remote wall clocks are untrusted. Claim/chooser lease files have their own
	// inode, so their filesystem mtime (unlike a hard-linked guard claim) records
	// publication age without depending on claimant-created metadata.
	return lease !== null
		&& (!Number.isFinite(lease.mtimeMs) || now - lease.mtimeMs > GENERATION_GUARD_STALE_MS);
}

function claimantHostDigest(hostname: string): string {
	const encodedRemote = /^remote:([a-f0-9]{16})$/.exec(hostname);
	return encodedRemote?.[1] ?? createHash("sha256").update(hostname).digest("hex").slice(0, 16);
}

function sameGuardClaimant(a: GuardClaimant | null, b: GuardClaimant): boolean {
	return a?.token === b.token
		&& a.pid === b.pid
		&& a.createdAtMs === b.createdAtMs
		&& claimantHostDigest(a.hostname) === claimantHostDigest(b.hostname);
}

function readGuardClaimMarker(markerPath: string): GuardClaimMarkerSnapshot | null {
	let fd: number | null = null;
	try {
		fd = fs.openSync(markerPath, "r");
		const raw = fs.readFileSync(fd, "utf8");
		const stat = fs.fstatSync(fd, { bigint: true });
		let claimant: GuardClaimant | null = null;
		try {
			const parsed = JSON.parse(raw) as Partial<GuardClaimant>;
			if (parsed && typeof parsed === "object"
				&& typeof parsed.token === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(parsed.token)
				&& typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
				&& typeof parsed.hostname === "string"
				&& typeof parsed.createdAtMs === "number" && Number.isSafeInteger(parsed.createdAtMs)) {
				claimant = parsed as GuardClaimant;
			}
		} catch {
			/* A partial marker is fail-closed until its filesystem lease expires. */
		}
		return { claimant, mtimeMs: Number(stat.mtimeMs), dev: stat.dev, ino: stat.ino };
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try { fs.closeSync(fd); } catch { /* */ }
		}
	}
}

function renewGuardClaimMarker(
	markerPath: string,
	claimant: GuardClaimant,
): GuardClaimMarkerSnapshot | null {
	const observed = readGuardClaimMarker(markerPath);
	if (!observed || !sameGuardClaimant(observed.claimant, claimant)) return null;
	let fd: number | null = null;
	try {
		fd = fs.openSync(markerPath, "r+");
		const before = fs.fstatSync(fd, { bigint: true });
		if (before.dev !== observed.dev || before.ino !== observed.ino) return null;
		const now = new Date();
		fs.futimesSync(fd, now, now);
		const after = fs.fstatSync(fd, { bigint: true });
		return {
			claimant,
			mtimeMs: Number(after.mtimeMs),
			dev: after.dev,
			ino: after.ino,
		};
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try { fs.closeSync(fd); } catch { /* */ }
		}
	}
}

function guardClaimantFromEncoded(
	createdAtText: string,
	pidText: string,
	hostDigest: string,
	token: string,
): GuardClaimant | null {
	const createdAtMs = Number(createdAtText);
	const pid = Number(pidText);
	if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(pid) || pid < 1) return null;
	const localHostDigest = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
	return {
		token,
		pid,
		// Only equality with this host matters; avoid unsafe hostname characters in paths.
		hostname: hostDigest === localHostDigest ? os.hostname() : `remote:${hostDigest}`,
		createdAtMs,
	};
}

function parseGuardClaimName(
	name: string,
	prefix: string,
): Pick<GuardClaimEntry, "sequence" | "claimant"> | null {
	if (!name.startsWith(prefix) || !name.endsWith(".guard-claim")) return null;
	const encoded = name.slice(prefix.length, -".guard-claim".length);
	const match = /^(\d+)-(\d+)-(\d+)-([a-f0-9]{16})-([A-Za-z0-9_-]{16,200})$/.exec(encoded);
	if (!match) return null;
	const sequence = Number(match[1]);
	const claimant = guardClaimantFromEncoded(match[2]!, match[3]!, match[4]!, match[5]!);
	if (!Number.isSafeInteger(sequence) || sequence < 1 || !claimant) return null;
	return { sequence, claimant };
}

function parseGuardChoosingName(name: string, prefix: string): GuardClaimant | null {
	if (!name.startsWith(prefix) || !name.endsWith(".guard-choosing")) return null;
	const encoded = name.slice(prefix.length, -".guard-choosing".length);
	const match = /^(\d+)-(\d+)-([a-f0-9]{16})-([A-Za-z0-9_-]{16,200})$/.exec(encoded);
	return match ? guardClaimantFromEncoded(match[1]!, match[2]!, match[3]!, match[4]!) : null;
}

function listGuardClaims(
	dir: string,
	prefix: string,
	generation: string,
	expected: GenerationGuardSnapshot,
): GuardClaimEntry[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const claims: GuardClaimEntry[] = [];
	for (const name of names) {
		const parsed = parseGuardClaimName(name, prefix);
		if (!parsed) continue;
		const claimPath = path.join(dir, name);
		const snapshot = readGenerationGuard(claimPath, generation);
		if (!sameGuardSnapshot(snapshot, expected) || !sameGuardInode(snapshot, expected)) continue;
		const leasePath = `${claimPath}.lease`;
		const lease = readGuardClaimMarker(leasePath);
		claims.push({
			path: claimPath,
			name,
			snapshot: snapshot!,
			leasePath,
			// Even a process killed mid-write leaves a filesystem mtime. Claimant
			// identity comes from the unique encoded path, not malformed payload.
			lease,
			...parsed,
		});
	}
	return claims;
}

function removeStaleGuardClaim(claim: GuardClaimEntry): boolean {
	if (!guardClaimantIsStale(claim.claimant, claim.lease)) return false;
	const currentClaim = readGenerationGuard(claim.path, claim.snapshot.owner?.generation ?? "");
	if (!currentClaim) return true;
	if (!sameGuardSnapshot(currentClaim, claim.snapshot) || !sameGuardInode(currentClaim, claim.snapshot)) return false;
	if (claim.lease) {
		const currentLease = readGuardClaimMarker(claim.leasePath);
		if (!sameFileIdentity(currentLease, claim.lease)) return false;
		// If the original marker carried a complete identity, retain token safety.
		// A malformed partial marker is identified by its unique pathname + inode.
		if (claim.lease.claimant
			&& !sameGuardClaimant(currentLease?.claimant ?? null, claim.claimant)) return false;
		// Re-evaluate age from the inode just opened: a resumed claimant may have
		// renewed its lease after our directory scan but before cleanup.
		if (!guardClaimantIsStale(claim.claimant, currentLease)) return false;
	}
	try { fs.rmSync(claim.path); } catch { return !fs.existsSync(claim.path); }
	if (claim.lease) {
		removeFailedExclusivePublication(claim.leasePath, claim.lease, { field: "token", value: claim.claimant.token });
	}
	return true;
}

function removeStaleLegacyGuardClaim(
	dir: string,
	digest: string,
	generation: string,
	expected: GenerationGuardSnapshot,
): void {
	// Versions before per-attempt claims used this deterministic hard link. It
	// has no claimant identity, so reclaim it only when the guard owner itself is
	// stale. Removing this old link cannot remove a new claim (new paths are UUID'd).
	if (!isGenerationGuardStale(expected)) return;
	const legacyPath = path.join(dir, `.${OWNER_LOCK_NAME}.${digest}.guard-claim`);
	const legacy = readGenerationGuard(legacyPath, generation);
	if (!sameGuardSnapshot(legacy, expected) || !sameGuardInode(legacy, expected)) return;
	try {
		fs.rmSync(legacyPath);
	} catch {
		/* another recoverer may have removed it */
	}
}

/**
 * Remove exactly the observed guard incarnation. Each attempt hard-links the
 * inode to a never-reused claim path. A small filesystem bakery election keeps
 * two valid claimants out of the unlink section; unique paths make stale claim
 * cleanup safe because an old callback can never target a replacement claim.
 */
function removeGenerationGuardIfOwned(
	guardPath: string,
	generation: string,
	expected: GenerationGuardSnapshot,
): boolean {
	const dir = path.dirname(guardPath);
	const digest = guardClaimDigest(generation, expected);
	const prefix = `.${OWNER_LOCK_NAME}.${digest}.`;
	const claimant: GuardClaimant = {
		token: randomUUID(),
		pid: process.pid,
		hostname: os.hostname(),
		createdAtMs: Date.now(),
	};
	const hostDigest = createHash("sha256").update(claimant.hostname).digest("hex").slice(0, 16);
	const choosingPath = path.join(dir, `${prefix}${claimant.createdAtMs}-${claimant.pid}-${hostDigest}-${claimant.token}.guard-choosing`);
	let claimPath: string | null = null;
	let claimLeasePath: string | null = null;
	try {
		if (!tryExclusiveCreate(choosingPath, JSON.stringify(claimant))) return false;
		removeStaleLegacyGuardClaim(dir, digest, generation, expected);

		let claims = listGuardClaims(dir, prefix, generation, expected);
		for (const claim of claims) removeStaleGuardClaim(claim);
		claims = listGuardClaims(dir, prefix, generation, expected);
		const sequence = claims.reduce((max, claim) => Math.max(max, claim.sequence), 0) + 1;
		const claimName = `${prefix}${sequence}-${claimant.createdAtMs}-${claimant.pid}-${hostDigest}-${claimant.token}.guard-claim`;
		claimPath = path.join(dir, claimName);
		claimLeasePath = `${claimPath}.lease`;
		// Publish the independent filesystem-time lease before the hard link. Thus
		// every claim created by this protocol is born with a fresh, per-claim mtime.
		if (!tryExclusiveCreate(claimLeasePath, JSON.stringify(claimant))) return false;
		fs.linkSync(guardPath, claimPath);
	} catch {
		if (claimPath) {
			try { fs.rmSync(claimPath); } catch { /* */ }
		}
		if (claimLeasePath) {
			try { fs.rmSync(claimLeasePath); } catch { /* unique token path */ }
		}
		return false;
	} finally {
		try { fs.rmSync(choosingPath, { force: true }); } catch { /* unique token path */ }
	}

	try {
		const claimed = readGenerationGuard(claimPath, generation);
		if (!sameGuardSnapshot(claimed, expected) || !sameGuardInode(claimed, expected)) return false;

		// A chooser that started before our ticket could publish an equal/lower
		// ticket. A chooser starting after this scan must observe our ticket and
		// choose a higher sequence, so it cannot enter ahead of us.
		let names: string[];
		try { names = fs.readdirSync(dir); } catch { return false; }
		for (const name of names) {
			if (!name.startsWith(prefix) || !name.endsWith(".guard-choosing")) continue;
			const chooserPath = path.join(dir, name);
			const chooser = parseGuardChoosingName(name, prefix);
			const marker = readGuardClaimMarker(chooserPath);
			if (chooser && marker
				&& guardClaimantIsStale(chooser, marker)
				&& removeFailedExclusivePublication(
					chooserPath,
					marker,
					{ field: "token", value: chooser.token },
				)) continue;
			return false;
		}

		const ownName = path.basename(claimPath);
		for (const claim of listGuardClaims(dir, prefix, generation, expected)) {
			if (claim.name === ownName) continue;
			if (guardClaimantIsStale(claim.claimant, claim.lease)
				&& removeStaleGuardClaim(claim)) continue;
			const own = parseGuardClaimName(ownName, prefix)!;
			if (claim.sequence < own.sequence || (claim.sequence === own.sequence && claim.name < ownName)) return false;
		}

		// A remote claimant that resumes after its lease elapsed must fence itself:
		// renew only if both its lease and hard-link claim still exist, then make
		// the filesystem mtime fresh before entering the final unlink section.
		const renewedLease = renewGuardClaimMarker(claimLeasePath, claimant);
		if (!renewedLease) return false;
		const currentClaim = readGenerationGuard(claimPath, generation);
		if (!sameGuardSnapshot(currentClaim, expected) || !sameGuardInode(currentClaim, claimed!)) return false;
		const currentLease = readGuardClaimMarker(claimLeasePath);
		if (!sameFileIdentity(currentLease, renewedLease)
			|| !sameGuardClaimant(currentLease?.claimant ?? null, claimant)) return false;

		const current = readGenerationGuard(guardPath, generation);
		if (!sameGuardSnapshot(current, expected) || !sameGuardInode(current, claimed!)) return false;
		fs.rmSync(guardPath);
		return true;
	} catch {
		return false;
	} finally {
		try { fs.rmSync(claimPath, { force: true }); } catch { /* unique path is never reused */ }
		try { fs.rmSync(claimLeasePath, { force: true }); } catch { /* unique path is never reused */ }
	}
}

/**
 * Serialize compare-and-mutate operations for one generation. Guards carry a
 * unique ownership token so crashed owners can be recovered and old callbacks
 * cannot unlink a replacement guard.
 */
function tryGenerationGuard(lockPath: string, generation: string): (() => void) | null {
	const guardPath = generationGuardPath(lockPath, generation);
	for (let attempt = 0; attempt < 16; attempt++) {
		const owner: GenerationGuardOwner = {
			token: randomUUID(),
			pid: process.pid,
			hostname: os.hostname(),
			generation,
			createdAt: new Date().toISOString(),
		};
		let opened: FileIdentity | null = null;
		let published = false;
		try {
			const fd = fs.openSync(guardPath, "wx");
			try {
				const stat = fs.fstatSync(fd, { bigint: true });
				opened = { dev: stat.dev, ino: stat.ino };
				fs.writeFileSync(fd, JSON.stringify(owner));
				fs.fsyncSync(fd);
				published = true;
			} finally {
				fs.closeSync(fd);
			}
			const owned = readGenerationGuard(guardPath, generation);
			if (!owned || owned.owner?.token !== owner.token) return null;
			return () => {
				removeGenerationGuardIfOwned(guardPath, generation, owned);
			};
		} catch (err) {
			if (opened && !published) {
				// The writer may have paused after close while a stale-partial
				// recoverer installed a replacement. First compare the current
				// pathname's inode/token with the inode this writer originally opened,
				// then use the same claimed bakery removal as every stale recoverer.
				// This keeps replacement publishers out of the compare/unlink window.
				const failed = readGenerationGuard(guardPath, generation);
				if (sameFileIdentity(failed, opened) && failed?.owner?.token === owner.token) {
					removeGenerationGuardIfOwned(guardPath, generation, failed);
				}
				return null;
			}
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
		}

		const existing = readGenerationGuard(guardPath, generation);
		if (!existing) continue;
		if (!isGenerationGuardStale(existing)) return null;
		// Only the remover that claimed the exact stale token may clear it.
		removeGenerationGuardIfOwned(guardPath, generation, existing);
	}
	return null;
}

/**
 * Cross-process owner lock (PID + heartbeat + lease).
 * Stale (lease exceeded or dead PID on same host) locks may be taken over.
 * `force: true` takes over a live lock as well.
 */
export function acquireOwnerLock(
	cwd: string,
	opts: { runId: string; leaseSec?: number; force?: boolean },
): OwnerLockHandle {
	const runId = opts.runId;
	if (!isValidRunId(runId)) {
		return { ok: false, holder: null, reason: "invalid_run_id" };
	}
	const leaseSec =
		typeof opts.leaseSec === "number" && Number.isFinite(opts.leaseSec) && opts.leaseSec > 0
			? opts.leaseSec
			: DEFAULT_LEASE_SEC;
	const force = opts.force === true;
	let root: string;
	try {
		root = ensureMetaLoopRunsRoot(cwd);
	} catch (err) {
		return {
			ok: false,
			holder: null,
			reason: `meta_loop_path_unsafe: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const lockPath = path.join(root, OWNER_LOCK_NAME);
	const generation = randomUUID();

	// A failed generation-guard attempt means another operation is completing.
	// Re-read a few times so takeover contenders normally observe its result.
	for (let attempt = 0; attempt < 8; attempt++) {
		const existing = readOwnerLockFile(lockPath);
		if (!existing) {
			const nowIso = new Date().toISOString();
			const holder: OwnerLockHolder = {
				pid: process.pid,
				hostname: os.hostname(),
				runId,
				generation,
				acquiredAt: nowIso,
				heartbeatAt: nowIso,
				leaseSec,
			};
			// Hard-link O_EXCL is the only publication path. Never replace an owner lock.
			if (tryExclusiveCreate(lockPath, JSON.stringify(holder, null, 2))) {
				return buildLockHandle(cwd, holder);
			}
			continue;
		}

		if (processOwnsLock(existing, runId)) {
			// Re-entrant handles share the current generation. A later generation
			// for the same pid/runId is deliberately not considered equivalent.
			const handle = buildLockHandle(cwd, existing);
			handle.refresh();
			return handle;
		}
		if (!force && !isOwnerLockStale(existing)) {
			return { ok: false, holder: existing, reason: "busy" };
		}

		const releaseGuard = tryGenerationGuard(lockPath, existing.generation);
		if (!releaseGuard) continue;
		try {
			const current = readOwnerLockFile(lockPath);
			if (!current || !sameGeneration(current, existing)) continue;
			// Staleness may have changed while we waited for a heartbeat operation.
			if (!force && !isOwnerLockStale(current)) {
				return { ok: false, holder: current, reason: "busy" };
			}

			// Remove only after generation comparison while holding that generation's
			// guard. Publication is still O_EXCL, so a concurrent fresh acquirer can
			// win the gap but can never be overwritten by this takeover.
			fs.rmSync(lockPath);
			const nowIso = new Date().toISOString();
			const holder: OwnerLockHolder = {
				pid: process.pid,
				hostname: os.hostname(),
				runId,
				generation,
				acquiredAt: nowIso,
				heartbeatAt: nowIso,
				leaseSec,
			};
			if (tryExclusiveCreate(lockPath, JSON.stringify(holder, null, 2))) {
				return buildLockHandle(cwd, holder);
			}
		} finally {
			releaseGuard();
		}
	}

	const holder = readOwnerLockFile(lockPath);
	return { ok: false, holder, reason: holder ? "lost_race" : "write_failed" };
}

function tryExclusiveCreate(filePath: string, content: string): boolean {
	// Fully persist a private inode, then use link(2) as the O_EXCL publication.
	// A failed/paused writer can only clean its never-published UUID path and can
	// never unlink a replacement owner lock or claim marker by shared pathname.
	const privatePath = path.join(
		path.dirname(filePath),
		`.meta-loop-publish-${process.pid}-${randomUUID()}`,
	);
	try {
		const fd = fs.openSync(privatePath, "wx");
		try {
			fs.writeFileSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.linkSync(privatePath, filePath);
		return true;
	} catch {
		return false;
	} finally {
		try { fs.rmSync(privatePath, { force: true }); } catch { /* unique private path */ }
	}
}

function buildLockHandle(cwd: string, ownership: OwnerLockHolder): Extract<OwnerLockHandle, { ok: true }> {
	const lockPath = ownerLockPath(cwd);
	let released = false;
	const stillOwns = (): boolean => {
		const current = readOwnerLockFile(lockPath);
		return !!current && sameGeneration(current, ownership);
	};
	return {
		ok: true,
		refresh(): boolean {
			if (released) return false;
			// Missing/mismatched generation is ownership loss even before the guard.
			if (!stillOwns()) {
				released = true;
				return false;
			}
			const releaseGuard = tryGenerationGuard(lockPath, ownership.generation);
			if (!releaseGuard) {
				// Guard contention while we still appear to own is not loss; missing lock is.
				if (!stillOwns()) {
					released = true;
					return false;
				}
				return true;
			}
			try {
				const current = readOwnerLockFile(lockPath);
				if (!current || !sameGeneration(current, ownership)) {
					released = true;
					return false;
				}
				const next: OwnerLockHolder = {
					...current,
					heartbeatAt: new Date().toISOString(),
				};
				atomicWriteFile(lockPath, JSON.stringify(next, null, 2));
				assertWrittenPathInsideCwd(cwd, lockPath);
				return true;
			} catch {
				// Heartbeat write failed — still owned only if generation remains ours.
				if (!stillOwns()) {
					released = true;
					return false;
				}
				return true;
			} finally {
				releaseGuard();
			}
		},
		release(): void {
			if (released) return;
			const releaseGuard = tryGenerationGuard(lockPath, ownership.generation);
			if (!releaseGuard) {
				if (!stillOwns()) released = true;
				return;
			}
			try {
				const current = readOwnerLockFile(lockPath);
				if (!sameGeneration(current, ownership)) {
					released = true;
					return;
				}
				fs.rmSync(lockPath);
				released = true;
			} catch {
				/* Leave unreleased so a caller may retry. */
			} finally {
				releaseGuard();
			}
		},
	};
}

/** Read current owner lock (null if missing/corrupt). */
export function readOwnerLock(cwd: string): OwnerLockHolder | null {
	return readOwnerLockFile(ownerLockPath(cwd));
}
