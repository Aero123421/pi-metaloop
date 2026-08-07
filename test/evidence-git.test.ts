/**
 * Real-git-repo tests for captureGitSnapshot / diffGitSnapshots.
 * Uses tmp dirs only — never touches the project worktree.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { captureGitSnapshot, diffGitSnapshots } from "../src/evidence.ts";
import { isBlockedGitBashCommand } from "../src/scope-guard.ts";

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		windowsHide: true,
	});
	if (r.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (exit ${r.status}): ${r.stderr || r.stdout || r.error?.message || ""}`,
		);
	}
	return String(r.stdout ?? "");
}

function initTmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-git-"));
	git(dir, ["init"]);
	git(dir, ["config", "user.email", "evidence-test@example.com"]);
	git(dir, ["config", "user.name", "Evidence Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	git(dir, ["config", "core.autocrlf", "false"]);
	fs.writeFileSync(path.join(dir, "README.md"), "initial\n", "utf-8");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-m", "init"]);
	return dir;
}

function rmRepo(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
}

describe("captureGitSnapshot / diffGitSnapshots (real git)", () => {
	it("detects content mutation of a pre-existing dirty file", () => {
		const dir = initTmpRepo();
		try {
			// Pre-ticket dirty (untracked)
			fs.writeFileSync(path.join(dir, "dirty.txt"), "v1\n", "utf-8");
			const before = captureGitSnapshot(dir);
			assert.equal(before.ok, true, before.error);
			assert.ok(before.head);
			assert.ok(before.indexHash);
			assert.equal(before.fileHashes.get("dirty.txt") !== undefined, true);

			// Additional mutation during ticket
			fs.writeFileSync(path.join(dir, "dirty.txt"), "v2-mutated\n", "utf-8");
			const after = captureGitSnapshot(dir);
			assert.equal(after.ok, true, after.error);

			const diff = diffGitSnapshots(before, after);
			assert.ok(
				diff.mutatedPreDirty.includes("dirty.txt"),
				`expected dirty.txt in mutatedPreDirty, got ${JSON.stringify(diff)}`,
			);
			assert.equal(diff.headChanged, false);
			assert.ok(!diff.newFiles.includes("dirty.txt"));
		} finally {
			rmRepo(dir);
		}
	});

	it("detects HEAD change from commit during ticket", () => {
		const dir = initTmpRepo();
		try {
			const before = captureGitSnapshot(dir);
			assert.equal(before.ok, true, before.error);
			const headBefore = before.head;

			fs.writeFileSync(path.join(dir, "during.txt"), "committed-in-ticket\n", "utf-8");
			git(dir, ["add", "during.txt"]);
			git(dir, ["commit", "-m", "ticket-commit"]);

			const after = captureGitSnapshot(dir);
			assert.equal(after.ok, true, after.error);
			assert.notEqual(after.head, headBefore);

			const diff = diffGitSnapshots(before, after);
			assert.equal(diff.headChanged, true, `expected headChanged, got ${JSON.stringify(diff)}`);
			assert.equal(diff.indexChanged, true);
		} finally {
			rmRepo(dir);
		}
	});

	it("detects index mutation without a commit", () => {
		const dir = initTmpRepo();
		try {
			const before = captureGitSnapshot(dir);
			fs.writeFileSync(path.join(dir, "staged.txt"), "staged-in-ticket\n", "utf-8");
			git(dir, ["add", "staged.txt"]);
			const after = captureGitSnapshot(dir);
			assert.equal(after.ok, true, after.error);

			const diff = diffGitSnapshots(before, after);
			assert.equal(diff.headChanged, false);
			assert.equal(diff.indexChanged, true);
			assert.ok(diff.newFiles.includes("staged.txt"));
		} finally {
			rmRepo(dir);
		}
	});

	it("detects new files added during ticket", () => {
		const dir = initTmpRepo();
		try {
			const before = captureGitSnapshot(dir);
			assert.equal(before.ok, true, before.error);
			assert.equal(before.fileHashes.size, 0);

			fs.writeFileSync(path.join(dir, "brand-new.txt"), "hello\n", "utf-8");
			const after = captureGitSnapshot(dir);
			assert.equal(after.ok, true, after.error);

			const diff = diffGitSnapshots(before, after);
			assert.ok(
				diff.newFiles.includes("brand-new.txt"),
				`expected brand-new.txt in newFiles, got ${JSON.stringify(diff)}`,
			);
			assert.equal(diff.headChanged, false);
			assert.deepEqual(diff.mutatedPreDirty, []);
		} finally {
			rmRepo(dir);
		}
	});

	it("fail-closed: non-git directory yields ok=false with error", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-nogit-"));
		try {
			const snap = captureGitSnapshot(dir);
			assert.equal(snap.ok, false);
			assert.ok(snap.error && snap.error.length > 0);
			assert.equal(snap.head, null);
		} finally {
			rmRepo(dir);
		}
	});
});

describe("scope-guard bash git blocks", () => {
	it("blocks git worktree/index/HEAD/ref mutations", () => {
		assert.equal(isBlockedGitBashCommand("git commit -m 'x'"), true);
		assert.equal(isBlockedGitBashCommand("git push origin main"), true);
		assert.equal(isBlockedGitBashCommand("git reset --hard"), true);
		assert.equal(isBlockedGitBashCommand("git checkout -b feature"), true);
		assert.equal(isBlockedGitBashCommand("git clean -fd"), true);
		assert.equal(isBlockedGitBashCommand("git restore ."), true);
		assert.equal(isBlockedGitBashCommand("git stash push -m x"), true);
		assert.equal(isBlockedGitBashCommand("git add src/x.ts"), true);
		assert.equal(isBlockedGitBashCommand("git merge topic"), true);
		assert.equal(isBlockedGitBashCommand("git rebase main"), true);
		assert.equal(isBlockedGitBashCommand("git switch topic"), true);
		assert.equal(isBlockedGitBashCommand("git -c alias.ship=push ship"), true);
		assert.equal(isBlockedGitBashCommand("git status | git push origin main"), true);
		assert.equal(isBlockedGitBashCommand("npm test && git commit -am 'x'"), true);
		assert.equal(isBlockedGitBashCommand("git -C /tmp/repo commit -m x"), true);
		assert.equal(isBlockedGitBashCommand("git.exe commit -m x"), true);
		assert.equal(isBlockedGitBashCommand("env FLAG=1 git.exe push origin main"), true);
		assert.equal(isBlockedGitBashCommand("sh -c 'git commit -m x'"), true);
		assert.equal(isBlockedGitBashCommand('cmd /c "git.exe reset --hard"'), true);
	});

	it("allows read-only git and non-git commands", () => {
		assert.equal(isBlockedGitBashCommand("git status"), false);
		assert.equal(isBlockedGitBashCommand("git diff --stat"), false);
		assert.equal(isBlockedGitBashCommand("git log -1"), false);
		assert.equal(isBlockedGitBashCommand("git rev-parse HEAD"), false);
		assert.equal(isBlockedGitBashCommand("npm test"), false);
		assert.equal(isBlockedGitBashCommand("echo git commit"), false);
	});
});
