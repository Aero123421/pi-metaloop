import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import {
	acquireOwnerLock,
	atomicWriteFile,
	createRunId,
	isValidRunId,
	listRuns,
	readLatestRun,
	readOwnerLock,
	readRun,
	runDir,
	ticketCounts,
	writeRun,
	type PersistedRun,
} from "../src/board-store.ts";
import type { TaskBoard } from "../src/types.ts";

function sampleBoard(): TaskBoard {
	return {
		goal: "ship it",
		planSummary: "p",
		openQuestions: [],
		tickets: [
			{
				id: "t1",
				goal: "a",
				deliverables: [],
				acceptance: ["x"],
				allowed_scope: [],
				forbidden: [],
				dependencies: [],
				status: "done",
			},
			{
				id: "t2",
				goal: "b",
				deliverables: [],
				acceptance: ["x"],
				allowed_scope: [],
				forbidden: [],
				dependencies: ["t1"],
				status: "running",
			},
		],
		phase: "executing",
		reviewCount: 1,
	};
}

function sampleRun(cwd: string, runId: string, board = sampleBoard()): PersistedRun {
	return {
		runId,
		cwd,
		goal: board.goal,
		status: "running",
		label: "executing: t2",
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		board,
		verdicts: [],
		summary: "# summary\nok\n",
	};
}

describe("board-store", () => {
	it("persists and reads latest run (atomic write)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-board-"));
		const board = sampleBoard();
		const runId = createRunId();
		assert.equal(isValidRunId(runId), true);
		const run = sampleRun(cwd, runId, board);
		writeRun(cwd, run);

		const boardPath = path.join(cwd, ".pi", "meta-loop", "runs", runId, "board.json");
		const latestPath = path.join(cwd, ".pi", "meta-loop", "runs", "latest.json");
		const summaryPath = path.join(cwd, ".pi", "meta-loop", "runs", runId, "summary.md");
		assert.ok(fs.existsSync(boardPath));
		assert.ok(fs.existsSync(latestPath));
		assert.ok(fs.existsSync(summaryPath));
		// No leftover temp files
		const rootEntries = fs.readdirSync(path.join(cwd, ".pi", "meta-loop", "runs"));
		assert.ok(!rootEntries.some((n) => n.endsWith(".tmp")));

		const latest = readLatestRun(cwd);
		assert.ok(latest);
		assert.equal(latest!.runId, runId);
		assert.equal(latest!.board.tickets.length, 2);
		assert.equal(readRun(cwd, runId)?.label, "executing: t2");
		assert.equal(listRuns(cwd, 5).length, 1);
		const c = ticketCounts(board);
		assert.equal(c.done, 1);
		assert.equal(c.running, 1);
		assert.equal(c.total, 2);
	});

	it("rejects symlink/junction components under .pi/meta-loop/runs (path traversal)", () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ml-board-sym-"));
		const cwd = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });

		const meta = path.join(cwd, ".pi", "meta-loop");
		fs.mkdirSync(meta, { recursive: true });
		const runsLink = path.join(meta, "runs");
		// Windows: junction; POSIX: directory symlink. Both must be rejected.
		const linkType = process.platform === "win32" ? "junction" : "dir";
		fs.symlinkSync(outside, runsLink, linkType);

		const runId = createRunId();
		assert.throws(() => writeRun(cwd, sampleRun(cwd, runId)), /symlink|junction|escape/i);
		assert.equal(fs.existsSync(path.join(outside, runId)), false);
		assert.equal(fs.existsSync(path.join(outside, "latest.json")), false);

		const lock = acquireOwnerLock(cwd, { runId });
		assert.equal(lock.ok, false);
		if (!lock.ok) assert.match(lock.reason, /meta_loop_path_unsafe|symlink|junction/i);
		assert.equal(fs.existsSync(path.join(outside, "owner.lock.json")), false);
	});

	it("rejects invalid runIds (path traversal / separators) fail-closed", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-board-bad-"));
		const badIds = [
			"../escape",
			"..",
			"foo/bar",
			"foo\\bar",
			"a b",
			"evil.run",
			"",
			"has.dot",
			"semi;colon",
		];
		for (const id of badIds) {
			assert.equal(isValidRunId(id), false, `expected invalid: ${id}`);
			assert.throws(() => runDir(cwd, id));
			assert.throws(() =>
				writeRun(cwd, sampleRun(cwd, id)),
			);
			assert.equal(readRun(cwd, id), null);
		}
		// Must not create anything outside runs root
		const runs = path.join(cwd, ".pi", "meta-loop", "runs");
		if (fs.existsSync(runs)) {
			const names = fs.readdirSync(runs);
			assert.ok(!names.some((n) => n.includes("..") || n === "escape"));
		}
		assert.ok(!fs.existsSync(path.join(cwd, "escape")));
		assert.ok(!fs.existsSync(path.join(cwd, ".pi", "meta-loop", "escape")));
	});

	it("tolerates corrupt board.json and latest.json", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-board-corrupt-"));
		const runId = createRunId();
		const dir = path.join(cwd, ".pi", "meta-loop", "runs", runId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "board.json"), "{not-json!!!", "utf-8");
		fs.writeFileSync(
			path.join(cwd, ".pi", "meta-loop", "runs", "latest.json"),
			"{also-broken",
			"utf-8",
		);
		assert.equal(readRun(cwd, runId), null);
		assert.equal(readLatestRun(cwd), null);

		// latest points to missing / corrupt run
		atomicWriteFile(
			path.join(cwd, ".pi", "meta-loop", "runs", "latest.json"),
			JSON.stringify({ runId: "no-such-run-zzz", updatedAt: new Date().toISOString() }),
		);
		assert.equal(readLatestRun(cwd), null);

		// latest with traversal runId must not escape
		fs.writeFileSync(
			path.join(cwd, ".pi", "meta-loop", "runs", "latest.json"),
			JSON.stringify({ runId: "../secret", updatedAt: new Date().toISOString() }),
			"utf-8",
		);
		assert.equal(readLatestRun(cwd), null);
	});

	it("owner lock: double acquire rejected; release then reacquire", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-"));
		const a = acquireOwnerLock(cwd, { runId: "run-a", leaseSec: 30 });
		assert.equal(a.ok, true);
		if (!a.ok) return;

		const lockPath = path.join(cwd, ".pi", "meta-loop", "runs", "owner.lock.json");
		assert.ok(fs.existsSync(lockPath));
		const held = readOwnerLock(cwd);
		assert.ok(held);
		assert.equal(held!.runId, "run-a");
		assert.equal(held!.pid, process.pid);

		// Different runId while held → busy
		const b = acquireOwnerLock(cwd, { runId: "run-b", leaseSec: 30 });
		assert.equal(b.ok, false);
		if (b.ok) return;
		assert.equal(b.reason, "busy");
		assert.ok(b.holder);
		assert.equal(b.holder!.runId, "run-a");

		// Same run re-entrant ok (does not steal from original holder)
		const again = acquireOwnerLock(cwd, { runId: "run-a", leaseSec: 30 });
		assert.equal(again.ok, true);

		a.refresh();
		const afterHb = readOwnerLock(cwd);
		assert.ok(afterHb);
		assert.equal(afterHb!.runId, "run-a");
		assert.equal(afterHb!.pid, process.pid);

		// Releasing a re-entrant handle drops the shared lock file — expected.
		if (again.ok) again.release();
		assert.equal(readOwnerLock(cwd), null);
		// Original handle release is idempotent after peer release
		a.release();
		assert.equal(readOwnerLock(cwd), null);

		const c = acquireOwnerLock(cwd, { runId: "run-c", leaseSec: 30 });
		assert.equal(c.ok, true);
		if (c.ok) c.release();
	});

	it("owner lock: a separate process is rejected while the owner is alive", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-process-"));
		const moduleUrl = new URL("../src/board-store.ts", import.meta.url).href;
		const script = [
			`import { acquireOwnerLock } from ${JSON.stringify(moduleUrl)};`,
			`const lock = acquireOwnerLock(${JSON.stringify(cwd)}, { runId: "child-run", leaseSec: 30 });`,
			`process.stdout.write(JSON.stringify({ ok: lock.ok, pid: process.pid }) + "\\n");`,
			`setTimeout(() => { if (lock.ok) lock.release(); }, 1200);`,
		].join("\n");
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		try {
			const firstLine = await new Promise<string>((resolve, reject) => {
				let stdout = "";
				let stderr = "";
				const timer = setTimeout(() => reject(new Error(`child lock timeout: ${stderr}`)), 10_000);
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf-8");
					const newline = stdout.indexOf("\n");
					if (newline >= 0) {
						clearTimeout(timer);
						resolve(stdout.slice(0, newline));
					}
				});
				child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
				child.on("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
			});
			const childState = JSON.parse(firstLine) as { ok: boolean; pid: number };
			assert.equal(childState.ok, true);

			const contender = acquireOwnerLock(cwd, { runId: "parent-run", leaseSec: 30 });
			assert.equal(contender.ok, false);
			if (!contender.ok) {
				assert.equal(contender.reason, "busy");
				assert.equal(contender.holder?.pid, childState.pid);
				assert.equal(contender.holder?.runId, "child-run");
			}
		} finally {
			child.kill();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) return resolve();
				const timer = setTimeout(resolve, 5000);
				if (typeof timer.unref === "function") timer.unref();
				child.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	});

	it("owner lock: never reclaims a locally-live process with an expired heartbeat", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-live-expired-"));
		const lockPath = path.join(cwd, ".pi", "meta-loop", "runs", "owner.lock.json");
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		atomicWriteFile(lockPath, JSON.stringify({
			pid: process.pid,
			hostname: os.hostname(),
			runId: "paused-live-run",
			generation: "paused-live-generation",
			acquiredAt: new Date(Date.now() - 300_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 300_000).toISOString(),
			leaseSec: 1,
		}, null, 2));

		const contender = acquireOwnerLock(cwd, { runId: "must-not-overlap", leaseSec: 1 });
		assert.equal(contender.ok, false);
		if (!contender.ok) {
			assert.equal(contender.reason, "busy");
			assert.equal(contender.holder?.runId, "paused-live-run");
		}
		assert.equal(readOwnerLock(cwd)?.generation, "paused-live-generation");
	});

	it("owner lock: stale heartbeat/pid allows takeover; force takeover", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-stale-"));
		const lockPath = path.join(cwd, ".pi", "meta-loop", "runs", "owner.lock.json");
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });

		// Dead PID + expired heartbeat
		const stale = {
			pid: 2_147_483_646, // almost surely not alive
			hostname: os.hostname(),
			runId: "old-run",
			generation: "stale-generation-token",
			acquiredAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
			leaseSec: 5,
		};
		// Confirm dead (if somehow alive, still stale via lease)
		atomicWriteFile(lockPath, JSON.stringify(stale, null, 2));

		const taken = acquireOwnerLock(cwd, { runId: "new-run", leaseSec: 30 });
		assert.equal(taken.ok, true, "stale lock should be takeable");
		if (!taken.ok) return;
		const holder = readOwnerLock(cwd);
		assert.ok(holder);
		assert.equal(holder!.runId, "new-run");
		assert.equal(holder!.pid, process.pid);

		// Live lock cannot be taken without force
		const blocked = acquireOwnerLock(cwd, { runId: "other", leaseSec: 30 });
		assert.equal(blocked.ok, false);
		if (!blocked.ok) assert.equal(blocked.reason, "busy");

		const forced = acquireOwnerLock(cwd, { runId: "forced", leaseSec: 30, force: true });
		assert.equal(forced.ok, true);
		if (!forced.ok) return;
		assert.equal(readOwnerLock(cwd)?.runId, "forced");

		// Return ownership to the old runId with a new generation. The first
		// handle now has the same pid/host/runId, but must not refresh or release it.
		const returned = acquireOwnerLock(cwd, { runId: "new-run", leaseSec: 30, force: true });
		assert.equal(returned.ok, true);
		if (!returned.ok) return;
		const current = readOwnerLock(cwd);
		assert.ok(current);
		assert.equal(current.runId, "new-run");
		assert.notEqual(current.generation, holder!.generation);
		taken.refresh();
		taken.release();
		assert.equal(readOwnerLock(cwd)?.generation, current.generation);

		forced.release(); // stale generation: no-op
		assert.equal(readOwnerLock(cwd)?.generation, current.generation);
		returned.release();
		assert.equal(readOwnerLock(cwd), null);
	});

	it("owner lock: recovers an orphaned generation guard from a crashed owner", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-orphan-"));
		const root = path.join(cwd, ".pi", "meta-loop", "runs");
		const lockPath = path.join(root, "owner.lock.json");
		const generation = "orphan-guard-generation";
		const guardPath = path.join(root, `.owner.lock.json.${generation}.guard`);
		const crashedPid = 2_147_483_646;
		fs.mkdirSync(root, { recursive: true });
		atomicWriteFile(lockPath, JSON.stringify({
			pid: crashedPid,
			hostname: os.hostname(),
			runId: "crashed-run",
			generation,
			acquiredAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
			leaseSec: 30,
		}, null, 2));
		fs.writeFileSync(guardPath, JSON.stringify({
			token: "orphan-guard-owner-token",
			pid: crashedPid,
			hostname: os.hostname(),
			generation,
			createdAt: new Date().toISOString(),
		}));

		const recovered = acquireOwnerLock(cwd, { runId: "recovered-run", leaseSec: 30 });
		assert.equal(recovered.ok, true, "dead guard owner must not permanently block takeover");
		assert.equal(readOwnerLock(cwd)?.runId, "recovered-run");
		assert.ok(!fs.existsSync(guardPath));
		assert.ok(!fs.readdirSync(root).some((name) => name.endsWith(".guard-claim")));

		if (recovered.ok) recovered.release();
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("owner lock: recovers a deterministic claim hard link left by a crashed remover", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-claim-orphan-"));
		const root = path.join(cwd, ".pi", "meta-loop", "runs");
		const lockPath = path.join(root, "owner.lock.json");
		const generation = "orphan-claim-generation";
		const guardToken = "orphan-claim-guard-token";
		const guardPath = path.join(root, `.owner.lock.json.${generation}.guard`);
		const crashedPid = 2_147_483_646;
		fs.mkdirSync(root, { recursive: true });
		atomicWriteFile(lockPath, JSON.stringify({
			pid: crashedPid,
			hostname: os.hostname(),
			runId: "crashed-remover-run",
			generation,
			acquiredAt: new Date().toISOString(),
			heartbeatAt: new Date().toISOString(),
			leaseSec: 30,
		}, null, 2));
		fs.writeFileSync(guardPath, JSON.stringify({
			token: guardToken,
			pid: crashedPid,
			hostname: os.hostname(),
			generation,
			createdAt: new Date().toISOString(),
		}));

		// Simulate the old deterministic remover crashing immediately after link(2).
		const digest = createHash("sha256")
			.update(generation).update("\0").update(guardToken)
			.digest("hex").slice(0, 32);
		const claimPath = path.join(root, `.owner.lock.json.${digest}.guard-claim`);
		fs.linkSync(guardPath, claimPath);
		assert.equal(fs.statSync(guardPath).ino, fs.statSync(claimPath).ino);

		const recovered = acquireOwnerLock(cwd, { runId: "claim-recovered-run", leaseSec: 30 });
		assert.equal(recovered.ok, true, "an orphan claim must not block guard recovery forever");
		assert.equal(readOwnerLock(cwd)?.runId, "claim-recovered-run");
		assert.ok(!fs.existsSync(guardPath));
		assert.ok(!fs.existsSync(claimPath));
		assert.ok(!fs.readdirSync(root).some((name) => name.endsWith(".guard-claim") || name.endsWith(".guard-choosing")));

		if (recovered.ok) recovered.release();
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("owner lock: never reclaims an aged claim from a locally-live process", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-live-claim-"));
		const root = path.join(cwd, ".pi", "meta-loop", "runs");
		const lockPath = path.join(root, "owner.lock.json");
		const generation = "locally-live-claim-generation";
		const guardToken = "locally-live-guard-token";
		const guardPath = path.join(root, `.owner.lock.json.${generation}.guard`);
		const deadPid = 2_147_483_646;
		fs.mkdirSync(root, { recursive: true });
		atomicWriteFile(lockPath, JSON.stringify({
			pid: deadPid,
			hostname: os.hostname(),
			runId: "stale-live-claim-run",
			generation,
			acquiredAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
			leaseSec: 1,
		}, null, 2));
		fs.writeFileSync(guardPath, JSON.stringify({
			token: guardToken,
			pid: deadPid,
			hostname: os.hostname(),
			generation,
			createdAt: new Date(Date.now() - 120_000).toISOString(),
		}));
		const digest = createHash("sha256")
			.update(generation).update("\0").update(guardToken)
			.digest("hex").slice(0, 32);
		const hostDigest = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
		const claimant = {
			token: "locally-live-claim-token",
			pid: process.pid,
			hostname: os.hostname(),
			createdAtMs: 1,
		};
		const claimPath = path.join(
			root,
			`.owner.lock.json.${digest}.1-${claimant.createdAtMs}-${claimant.pid}-${hostDigest}-${claimant.token}.guard-claim`,
		);
		const leasePath = `${claimPath}.lease`;
		fs.writeFileSync(leasePath, JSON.stringify(claimant));
		fs.linkSync(guardPath, claimPath);
		const staleTime = new Date(Date.now() - 120_000);
		fs.utimesSync(leasePath, staleTime, staleTime);

		const blocked = acquireOwnerLock(cwd, { runId: "must-not-reclaim-live-claim", leaseSec: 30 });
		assert.equal(blocked.ok, false);
		assert.ok(fs.existsSync(claimPath));
		assert.ok(fs.existsSync(leasePath));
		assert.equal(fs.statSync(claimPath).ino, fs.statSync(guardPath).ino);
	});

	it("owner lock: remote claim expiry uses lease mtime, not clock-skewed claimant metadata", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-claim-skew-"));
		const root = path.join(cwd, ".pi", "meta-loop", "runs");
		const lockPath = path.join(root, "owner.lock.json");
		const generation = "clock-skew-claim-generation";
		const guardToken = "clock-skew-guard-token";
		const guardPath = path.join(root, `.owner.lock.json.${generation}.guard`);
		const deadPid = 2_147_483_646;
		fs.mkdirSync(root, { recursive: true });
		atomicWriteFile(lockPath, JSON.stringify({
			pid: deadPid,
			hostname: os.hostname(),
			runId: "stale-clock-skew-run",
			generation,
			acquiredAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
			leaseSec: 1,
		}, null, 2));
		fs.writeFileSync(guardPath, JSON.stringify({
			token: guardToken,
			pid: deadPid,
			hostname: os.hostname(),
			generation,
			createdAt: new Date(Date.now() - 120_000).toISOString(),
		}));

		const digest = createHash("sha256")
			.update(generation).update("\0").update(guardToken)
			.digest("hex").slice(0, 32);
		const remoteHostname = "claimant-with-a-slow-clock.example";
		const remoteHostDigest = createHash("sha256").update(remoteHostname).digest("hex").slice(0, 16);
		const claimant = {
			token: "clock-skew-claim-token",
			pid: 424_242,
			hostname: remoteHostname,
			createdAtMs: 1, // Decades stale according to the untrusted remote clock.
		};
		const claimPath = path.join(
			root,
			`.owner.lock.json.${digest}.1-${claimant.createdAtMs}-${claimant.pid}-${remoteHostDigest}-${claimant.token}.guard-claim`,
		);
		const leasePath = `${claimPath}.lease`;
		fs.writeFileSync(leasePath, JSON.stringify(claimant));
		fs.linkSync(guardPath, claimPath);

		const blocked = acquireOwnerLock(cwd, { runId: "fresh-lease-contender", leaseSec: 30 });
		assert.equal(blocked.ok, false, "fresh filesystem lease must beat skewed createdAtMs");
		assert.ok(fs.existsSync(claimPath));
		assert.ok(fs.existsSync(leasePath));
		assert.equal(fs.statSync(claimPath).ino, fs.statSync(guardPath).ino);

		// Replace it with a claimant whose wall clock is far in the future. An
		// expired filesystem lease must still be recoverable.
		fs.rmSync(claimPath);
		fs.rmSync(leasePath);
		const futureClaimant = {
			...claimant,
			token: "future-skew-claim-token",
			createdAtMs: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
		};
		const futureClaimPath = path.join(
			root,
			`.owner.lock.json.${digest}.1-${futureClaimant.createdAtMs}-${futureClaimant.pid}-${remoteHostDigest}-${futureClaimant.token}.guard-claim`,
		);
		const futureLeasePath = `${futureClaimPath}.lease`;
		fs.writeFileSync(futureLeasePath, JSON.stringify(futureClaimant));
		fs.linkSync(guardPath, futureClaimPath);
		const staleTime = new Date(Date.now() - 120_000);
		fs.utimesSync(futureLeasePath, staleTime, staleTime);
		const recovered = acquireOwnerLock(cwd, { runId: "expired-lease-contender", leaseSec: 30 });
		assert.equal(recovered.ok, true, "aged filesystem lease should beat future createdAtMs");
		assert.equal(readOwnerLock(cwd)?.runId, "expired-lease-contender");
		assert.ok(!fs.existsSync(futureClaimPath));
		assert.ok(!fs.existsSync(futureLeasePath));
		if (recovered.ok) recovered.release();
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("owner lock: failed guard publication cannot unlink a replacement inode/token", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-guard-replacement-"));
		const root = path.join(cwd, ".pi", "meta-loop", "runs");
		const lockPath = path.join(root, "owner.lock.json");
		const generation = "failed-publication-generation";
		const guardPath = path.join(root, `.owner.lock.json.${generation}.guard`);
		fs.mkdirSync(root, { recursive: true });
		atomicWriteFile(lockPath, JSON.stringify({
			pid: 2_147_483_646,
			hostname: os.hostname(),
			runId: "stale-publication-run",
			generation,
			acquiredAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
			leaseSec: 1,
		}, null, 2));

		const moduleUrl = new URL("../src/board-store.ts", import.meta.url).href;
		const replacementToken = "replacement-guard-token";
		const script = [
			`import fs from "node:fs";`,
			`import os from "node:os";`,
			`import { syncBuiltinESMExports } from "node:module";`,
			`const guardPath = ${JSON.stringify(guardPath)};`,
			`const oldPath = guardPath + ".failed-old-inode";`,
			`const originalWrite = fs.writeFileSync;`,
			`let replaced = false;`,
			`fs.writeFileSync = function(target, data, ...rest) {`,
			`  if (!replaced && typeof target === "number") {`,
			`    try {`,
			`      const parsed = JSON.parse(String(data));`,
			`      if (parsed.generation === ${JSON.stringify(generation)} && parsed.token) {`,
			`        replaced = true;`,
			`        fs.renameSync(guardPath, oldPath);`,
			`        originalWrite.call(fs, guardPath, JSON.stringify({ token: ${JSON.stringify(replacementToken)}, pid: process.pid, hostname: os.hostname(), generation: ${JSON.stringify(generation)}, createdAt: new Date().toISOString() }));`,
			`        const err = new Error("injected guard publication failure after replacement");`,
			`        err.code = "EIO";`,
			`        throw err;`,
			`      }`,
			`    } catch (err) { if (err?.code === "EIO") throw err; }`,
			`  }`,
			`  return originalWrite.call(fs, target, data, ...rest);`,
			`};`,
			`syncBuiltinESMExports();`,
			`const { acquireOwnerLock } = await import(${JSON.stringify(moduleUrl)});`,
			`const result = acquireOwnerLock(${JSON.stringify(cwd)}, { runId: "replacement-contender", leaseSec: 30 });`,
			`const guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));`,
			`process.stdout.write(JSON.stringify({ ok: result.ok, replaced, guard, oldIno: fs.statSync(oldPath).ino, currentIno: fs.statSync(guardPath).ino }));`,
		].join("\n");
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", script],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(code, 0, stderr);
		const result = JSON.parse(stdout) as {
			ok: boolean;
			replaced: boolean;
			guard: { token: string };
			oldIno: number;
			currentIno: number;
		};
		assert.equal(result.replaced, true);
		assert.equal(result.ok, false);
		assert.equal(result.guard.token, replacementToken);
		assert.notEqual(result.oldIno, result.currentIno);
		assert.equal(JSON.parse(fs.readFileSync(guardPath, "utf8")).token, replacementToken);
	});

	it("owner lock: parallel stale takeovers have exactly one winner and leave no remnants", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-race-"));
		const root = path.join(cwd, ".pi", "meta-loop", "runs");
		const lockPath = path.join(root, "owner.lock.json");
		fs.mkdirSync(root, { recursive: true });
		const stalePid = 2_147_483_646;
		const generation = "parallel-stale-generation";
		atomicWriteFile(lockPath, JSON.stringify({
			pid: stalePid,
			hostname: os.hostname(),
			runId: "stale-run",
			generation,
			acquiredAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
			leaseSec: 1,
		}, null, 2));
		// Simulate a process dying after taking the per-generation O_EXCL guard.
		fs.writeFileSync(
			path.join(root, `.owner.lock.json.${generation}.guard`),
			JSON.stringify({
				token: "parallel-orphan-guard-token",
				pid: stalePid,
				hostname: os.hostname(),
				generation,
				createdAt: new Date(Date.now() - 120_000).toISOString(),
			}),
		);

		const moduleUrl = new URL("../src/board-store.ts", import.meta.url).href;
		const script = [
			`import { acquireOwnerLock } from ${JSON.stringify(moduleUrl)};`,
			`process.stdin.setEncoding("utf8");`,
			`const input = () => new Promise(resolve => process.stdin.once("data", resolve));`,
			`process.stdout.write("ready\\n");`,
			`await input();`,
			`const lock = acquireOwnerLock(${JSON.stringify(cwd)}, { runId: "race-" + process.pid, leaseSec: 30 });`,
			`process.stdout.write(JSON.stringify({ ok: lock.ok, pid: process.pid }) + "\\n");`,
			`await input();`,
			`if (lock.ok) lock.release();`,
			`process.stdout.write("done\\n");`,
		].join("\n");

		const children = Array.from({ length: 6 }, () => {
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", script],
				{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
			);
			let stdout = "";
			const lines: string[] = [];
			const waiters: Array<(line: string) => void> = [];
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
				for (;;) {
					const newline = stdout.indexOf("\n");
					if (newline < 0) break;
					const line = stdout.slice(0, newline);
					stdout = stdout.slice(newline + 1);
					const waiter = waiters.shift();
					if (waiter) waiter(line);
					else lines.push(line);
				}
			});
			const nextLine = () => new Promise<string>((resolve) => {
				const line = lines.shift();
				if (line !== undefined) resolve(line);
				else waiters.push(resolve);
			});
			return { child, nextLine };
		});

		try {
			assert.deepEqual(await Promise.all(children.map((c) => c.nextLine())), Array(6).fill("ready"));
			for (const { child } of children) child.stdin.write("go\n");
			const results = await Promise.all(children.map(async (c) =>
				JSON.parse(await c.nextLine()) as { ok: boolean; pid: number }
			));
			const winners = results.filter((result) => result.ok);
			assert.equal(winners.length, 1);
			assert.equal(readOwnerLock(cwd)?.pid, winners[0]!.pid);

			for (const { child } of children) child.stdin.end("release\n");
			assert.deepEqual(await Promise.all(children.map((c) => c.nextLine())), Array(6).fill("done"));
			await Promise.all(children.map(({ child }) => new Promise<void>((resolve, reject) => {
				if (child.exitCode !== null) {
					return child.exitCode === 0 ? resolve() : reject(new Error(`child exited ${child.exitCode}`));
				}
				child.once("error", reject);
				child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
			})));
		} finally {
			for (const { child } of children) {
				if (child.exitCode === null) child.kill();
			}
		}

		assert.equal(readOwnerLock(cwd), null);
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("atomicWriteFile replaces existing content", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-atomic-"));
		const file = path.join(dir, "x.json");
		atomicWriteFile(file, "one");
		assert.equal(fs.readFileSync(file, "utf-8"), "one");
		atomicWriteFile(file, "two");
		assert.equal(fs.readFileSync(file, "utf-8"), "two");
		assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".tmp")));
	});

	it("owner lock: refresh reports ownership loss after lock deletion; peer process can start", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-lock-deleted-"));
		const lockPath = path.join(cwd, ".pi", "meta-loop", "runs", "owner.lock.json");
		const a = acquireOwnerLock(cwd, { runId: "run-a", leaseSec: 30 });
		assert.equal(a.ok, true);
		if (!a.ok) return;

		// Simulate a worker (or external actor) removing the live owner lock.
		assert.ok(fs.existsSync(lockPath));
		fs.rmSync(lockPath);
		assert.equal(a.refresh(), false, "deleted lock must surface as ownership loss");

		// A second process/run can now acquire — the previous owner must not keep going.
		const moduleUrl = new URL("../src/board-store.ts", import.meta.url).href;
		const script = [
			`import { acquireOwnerLock } from ${JSON.stringify(moduleUrl)};`,
			`const lock = acquireOwnerLock(${JSON.stringify(cwd)}, { runId: "run-b", leaseSec: 30 });`,
			`process.stdout.write(JSON.stringify({ ok: lock.ok, runId: lock.ok ? "run-b" : null, reason: lock.ok ? null : lock.reason }) + "\\n");`,
			`if (lock.ok) lock.release();`,
		].join("\n");
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(code, 0, stderr || stdout);
		const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
		const peer = JSON.parse(line) as { ok: boolean; runId: string | null; reason: string | null };
		assert.equal(peer.ok, true, "peer must acquire after lock deletion");
		assert.equal(peer.runId, "run-b");
		// Original handle remains lost even after peer release.
		assert.equal(a.refresh(), false);
		a.release(); // idempotent after loss
	});
});
