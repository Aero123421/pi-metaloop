import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	captureFilesystemSnapshot,
	diffFilesystemSnapshots,
	filesystemEvidencePath,
} from "../src/fs-snapshot.ts";
import { checkPath, findScopeViolations } from "../src/evidence.ts";
import { inspectBashCommand } from "../src/scope-guard.ts";

function fixture(): { parent: string; cwd: string; cleanup: () => void } {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "meta-loop-fs-"));
	const cwd = path.join(parent, "repo");
	fs.mkdirSync(cwd);
	return {
		parent,
		cwd,
		cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
	};
}

function ownerLockPath(cwd: string): string {
	return path.join(cwd, ".pi", "meta-loop", "runs", "owner.lock.json");
}

function writeOwnerLock(cwd: string, holder: Record<string, unknown>): void {
	const lockPath = ownerLockPath(cwd);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const tmp = `${lockPath}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(holder, null, 2));
	fs.renameSync(tmp, lockPath);
}

function ownerHolder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		pid: process.pid,
		hostname: os.hostname(),
		runId: "run-1",
		generation: "generation-1234567890",
		acquiredAt: "2026-01-01T00:00:00.000Z",
		heartbeatAt: "2026-01-01T00:00:00.000Z",
		leaseSec: 60,
		...overrides,
	};
}

describe("bounded implementation-worker filesystem snapshots", () => {
	it("preserves unchanged pre-existing files and detects their later mutation", () => {
		const f = fixture();
		try {
			fs.mkdirSync(path.join(f.cwd, "src"));
			const dirty = path.join(f.cwd, "src", "dirty.txt");
			fs.writeFileSync(dirty, "uncommitted-v1\n");
			const before = captureFilesystemSnapshot(f.cwd);
			const unchanged = captureFilesystemSnapshot(f.cwd);
			assert.equal(before.ok, true, before.error);
			assert.deepEqual(diffFilesystemSnapshots(before, unchanged).changedPaths, []);

			fs.writeFileSync(dirty, "uncommitted-v2\n");
			const after = captureFilesystemSnapshot(f.cwd);
			const changed = diffFilesystemSnapshots(before, after).changedPaths;
			assert.ok(changed.some((p) => p.endsWith("/src/dirty.txt")));
		} finally {
			f.cleanup();
		}
	});

	it("detects ignored-file and cwd-parent writes that git evidence misses", () => {
		const f = fixture();
		try {
			fs.writeFileSync(path.join(f.cwd, ".gitignore"), "ignored/\n");
			fs.mkdirSync(path.join(f.cwd, "ignored"));
			const ignored = path.join(f.cwd, "ignored", "cache.bin");
			fs.writeFileSync(ignored, "v1");
			const before = captureFilesystemSnapshot(f.cwd);
			assert.equal(before.ok, true, before.error);

			fs.writeFileSync(ignored, "v2");
			const parentWrite = path.join(f.parent, "escaped.txt");
			fs.writeFileSync(parentWrite, "outside");
			const after = captureFilesystemSnapshot(f.cwd);
			assert.equal(after.ok, true, after.error);

			const evidencePaths = diffFilesystemSnapshots(before, after).changedPaths.map((p) =>
				filesystemEvidencePath(p, f.cwd),
			);
			assert.ok(evidencePaths.includes("ignored/cache.bin"), JSON.stringify(evidencePaths));
			assert.ok(evidencePaths.some((p) => path.basename(p) === "escaped.txt"), JSON.stringify(evidencePaths));
			const violations = findScopeViolations(evidencePaths, f.cwd, ["src/**"], []);
			assert.ok(violations.some((v) => v.includes("ignored/cache.bin")));
			assert.ok(violations.some((v) => v.includes("escaped.txt")));
		} finally {
			f.cleanup();
		}
	});

	it("reports changed files without false ancestor-directory violations", () => {
		const f = fixture();
		try {
			const before = captureFilesystemSnapshot(f.cwd);
			fs.mkdirSync(path.join(f.cwd, "src", "new"), { recursive: true });
			fs.writeFileSync(path.join(f.cwd, "src", "new", "file.ts"), "export {};\n");
			const after = captureFilesystemSnapshot(f.cwd);
			const paths = diffFilesystemSnapshots(before, after).changedPaths.map((p) =>
				filesystemEvidencePath(p, f.cwd),
			);
			assert.deepEqual(paths, ["src/new/file.ts"]);
			assert.deepEqual(findScopeViolations(paths, f.cwd, ["src/new/file.ts"], []), []);
		} finally {
			f.cleanup();
		}
	});

	it("ignores concurrent host owner-lock heartbeat rewrites", async () => {
		const f = fixture();
		let timer: NodeJS.Timeout | undefined;
		try {
			const holder = ownerHolder();
			writeOwnerLock(f.cwd, holder);
			const before = captureFilesystemSnapshot(f.cwd);
			let rewrites = 0;
			timer = setInterval(() => {
				rewrites += 1;
				writeOwnerLock(f.cwd, {
					...holder,
					heartbeatAt: new Date(Date.now() + rewrites * 1000).toISOString(),
				});
			}, 2);
			await new Promise((resolve) => setTimeout(resolve, 20));
			clearInterval(timer);
			timer = undefined;
			assert.ok(rewrites > 0);
			const after = captureFilesystemSnapshot(f.cwd);
			assert.equal(before.ok, true, before.error);
			assert.equal(after.ok, true, after.error);
			assert.deepEqual(diffFilesystemSnapshots(before, after).changedPaths, []);
		} finally {
			if (timer) clearInterval(timer);
			f.cleanup();
		}
	});

	it("detects owner-lock deletion and every ownership/lease field change", () => {
		const f = fixture();
		try {
			const original = ownerHolder();
			writeOwnerLock(f.cwd, original);
			const before = captureFilesystemSnapshot(f.cwd);
			assert.equal(before.ok, true, before.error);

			for (const changed of [
				{ pid: process.pid + 1 },
				{ hostname: `${os.hostname()}-other` },
				{ runId: "run-2" },
				{ generation: "generation-abcdefghij" },
				{ acquiredAt: "2026-01-02T00:00:00.000Z" },
				{ leaseSec: 120 },
				{ ownershipEpoch: "unknown-fields-also-fail-closed" },
			]) {
				writeOwnerLock(f.cwd, { ...original, ...changed, heartbeatAt: "2026-01-03T00:00:00.000Z" });
				const after = captureFilesystemSnapshot(f.cwd);
				const diff = diffFilesystemSnapshots(before, after);
				assert.ok(diff.modified.some((p) => p.endsWith("/owner.lock.json")), JSON.stringify(changed));
			}

			fs.rmSync(ownerLockPath(f.cwd));
			const deleted = diffFilesystemSnapshots(before, captureFilesystemSnapshot(f.cwd));
			assert.ok(deleted.deleted.some((p) => p.endsWith("/owner.lock.json")));
		} finally {
			f.cleanup();
		}
	});

	it("fails closed when entry or cwd-depth coverage limits are exceeded", () => {
		const f = fixture();
		try {
			fs.writeFileSync(path.join(f.cwd, "a"), "a");
			fs.writeFileSync(path.join(f.cwd, "b"), "b");
			const countLimited = captureFilesystemSnapshot(f.cwd, { maxEntries: 1 });
			assert.equal(countLimited.ok, false);
			assert.match(countLimited.error ?? "", /entry limit/i);

			fs.mkdirSync(path.join(f.cwd, "deep"));
			fs.writeFileSync(path.join(f.cwd, "deep", "x"), "x");
			const depthLimited = captureFilesystemSnapshot(f.cwd, { cwdMaxDepth: 0 });
			assert.equal(depthLimited.ok, false);
			assert.match(depthLimited.error ?? "", /depth limit/i);
		} finally {
			f.cleanup();
		}
	});

	it("fails closed for an unavailable cwd", () => {
		const missing = path.join(os.tmpdir(), `meta-loop-missing-${Date.now()}-${Math.random()}`);
		const snap = captureFilesystemSnapshot(missing);
		assert.equal(snap.ok, false);
		assert.ok(snap.error);
	});

	it("checkPath fails closed through symlink/junction ancestor with missing deep descendants", () => {
		const f = fixture();
		try {
			const outside = path.join(f.parent, "external-target");
			fs.mkdirSync(outside);
			fs.mkdirSync(path.join(f.cwd, "src"), { recursive: true });
			const link = path.join(f.cwd, "src", "out");
			const linkType = process.platform === "win32" ? "junction" : "dir";
			fs.symlinkSync(outside, link, linkType);

			// Deep descendants do not exist yet — old resolvePath only realpath'd the
			// immediate parent and would have treated this as lexical src/**.
			const deep = "src/out/new/deep/pwned.txt";
			const result = checkPath(deep, f.cwd, ["src/**"], []);
			assert.equal(result.ok, false, "symlink ancestor must not authorize external writes");
			assert.match(result.reason ?? "", /outside|allowed_scope|not allowed/i);

			// Production write path (bash redirection) must also refuse.
			const bash = inspectBashCommand(`printf pwned > ${deep}`, f.cwd, ["src/**"], []);
			assert.equal(bash.ok, false);
			assert.match(bash.reason ?? "", /outside|allowed_scope|not allowed|scope/i);

			// Flag-based writers/exec bypass redirection checkPath; must not be success
			// even when the lexical path looks in-scope via a symlink/junction ancestor.
			for (const command of [
				`sort -o ${deep} src/in.ts`,
				`sort --output=${deep} src/in.ts`,
				`yq -i '.x=1' ${deep}`,
				`yq --inplace '.x=1' ${deep}`,
				`diff --output=${deep} /dev/null README.md`,
				`git diff --no-index --output=${deep} /dev/null README.md`,
				`rg --pre=sh . ${deep}`,
			]) {
				const sneaky = inspectBashCommand(command, f.cwd, ["src/**"], []);
				assert.equal(sneaky.ok, false, command);
				assert.match(
					sneaky.reason ?? "",
					/allowlist|blocked git|outside|allowed_scope|not allowed|scope/i,
					command,
				);
			}

			// In-scope non-symlink path still allowed.
			assert.equal(checkPath("src/ok.txt", f.cwd, ["src/**"], []).ok, true);
		} finally {
			f.cleanup();
		}
	});
});

describe("implementation-worker bash inspection", () => {
	const cwd = process.cwd();
	const allowed = ["src/**"];
	const inspect = (command: string) => inspectBashCommand(command, cwd, allowed, []);

	it("path-checks redirection and tee targets", () => {
		assert.equal(inspect("printf ok > src/generated.ts").ok, true);
		assert.equal(inspect("printf ok > ../escaped.txt").ok, false);
		assert.equal(inspect("printf ok | tee src/generated.ts").ok, true);
		assert.equal(inspect("printf ok | tee ../escaped.txt").ok, false);
		assert.equal(inspect("printf ok 2>&1").ok, true);
		assert.equal(inspect("printf ok > $TARGET").ok, false);
	});

	it("recurses through env/sh/cmd and blocks inline node/python", () => {
		assert.equal(inspect("env sh -c 'printf ok > ../escaped.txt'").ok, false);
		assert.equal(inspect('cmd /c "git.exe commit -m x"').ok, false);
		assert.equal(inspect("node -e \"require('fs').writeFileSync('../x','x')\"").ok, false);
		assert.equal(inspect("python -c \"open('../x','w').write('x')\"").ok, false);
		assert.equal(inspect("python3.12 -c \"open('../x','w').write('x')\"").ok, false);
		assert.equal(inspect("echo $(git commit -m x)").ok, false);
		assert.equal(inspect("node --test test/unit.test.js").ok, false);
		assert.equal(inspect("python scripts/check.py").ok, false);
		assert.equal(inspect("touch ../../escaped").ok, false);
	});

	it("denies diff/git output flags and rg --pre without treating them as success", () => {
		// Production repros: no '>' so checkPath never runs; reserved paths and
		// child launch must still fail closed at inspectBashCommand.
		for (const command of [
			"diff --output=.git/config /dev/null README.md",
			"git diff --no-index --output=.pi/meta-loop/runs/owner.lock.json /dev/null README.md",
			"git diff --output=src/pwned.ts HEAD",
			"GIT_EXTERNAL_DIFF=evil git diff HEAD",
			"git -c core.pager=evil log -1",
			"rg --pre=sh . src/payload.sh",
			"rg --pre sh . src/payload.sh",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /allowlist|blocked git|env-prefix|loader|PATH/i, command);
		}
	});

	it("fails closed on process substitution, base64 -o, and env-prefix PATH/LD_PRELOAD", () => {
		for (const command of [
			"cat <(printf x)",
			"printf x > >(cat)",
			"base64 -o ../escaped.txt src/a.ts",
			"base64 --output=../escaped.txt src/a.ts",
			"LD_PRELOAD=./x.so cat src/a.ts",
			"PATH=/evil cat src/a.ts",
			"env LD_PRELOAD=./x.so cat src/a.ts",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(
				result.reason ?? "",
				/process substitution|allowlist|env-prefix|loader|PATH/i,
				command,
			);
		}
	});

	it("rejects an empty native allowed_scope", () => {
		const result = inspectBashCommand("npm test", cwd, [], []);
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /allowed_scope/);
	});
});
