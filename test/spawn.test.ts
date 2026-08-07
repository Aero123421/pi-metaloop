import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildRoleArgv,
	estimateCommandLineLength,
	killRoleProcessTree,
	loadRole,
	runRole,
	spawnManagedProcess,
	WINDOWS_CMDLINE_SOFT_LIMIT,
	type LoadedRole,
} from "../src/spawn.ts";

describe("spawn argv (ENAMETOOLONG guard)", () => {
	const role: LoadedRole = {
		name: "worker",
		systemPrompt: "x".repeat(50_000), // large prompt is on disk, not argv
		model: "qwen-token-plan/qwen3.8-max",
		tools: ["read", "write", "edit"],
	};

	it("does not put task body on argv", () => {
		const argv = buildRoleArgv(role, "C:/tmp/prompt.md");
		const joined = argv.join(" ");
		assert.ok(!joined.includes("Task:"));
		assert.ok(argv.includes("--append-system-prompt"));
		assert.ok(argv.includes("C:/tmp/prompt.md"));
		assert.ok(argv.some((a) => a.startsWith("Role:")));
	});

	it("maps explicit empty tools to pi --no-tools", () => {
		const argv = buildRoleArgv({ ...role, tools: [] }, "C:/tmp/prompt.md");
		assert.ok(argv.includes("--no-tools"));
		assert.ok(!argv.includes("--tools"));
	});

	it("leaves tools unspecified to inherit pi defaults", () => {
		const argv = buildRoleArgv({ ...role, tools: undefined }, "C:/tmp/prompt.md");
		assert.ok(!argv.includes("--no-tools"));
		assert.ok(!argv.includes("--tools"));
	});

	it("maps a non-empty allowlist to pi --tools", () => {
		const argv = buildRoleArgv(role, "C:/tmp/prompt.md");
		const index = argv.indexOf("--tools");
		assert.ok(index >= 0);
		assert.equal(argv[index + 1], "read,write,edit");
		assert.ok(!argv.includes("--no-tools"));
	});

	it("loadRole intersects worker tools with strict built-in allowlist (drops bash/custom)", () => {
		const loaded = loadRole("worker", {
			tools: ["read", "write", "edit", "bash", "grep", "my_custom_write"],
		});
		assert.deepEqual(loaded.tools, ["read", "write", "edit", "grep"]);
		const argv = buildRoleArgv(loaded, "C:/tmp/prompt.md", [
			"--no-extensions",
			"-e",
			"C:/tmp/scope-guard.ts",
		]);
		const index = argv.indexOf("--tools");
		assert.ok(index >= 0);
		assert.equal(argv[index + 1], "read,write,edit,grep");
		assert.ok(!String(argv[index + 1]).includes("bash"));
		assert.ok(!String(argv[index + 1]).includes("my_custom"));
		// Production native worker path: discovery off + explicit scope-guard only.
		assert.ok(argv.includes("--no-extensions"));
		const eIdx = argv.indexOf("-e");
		assert.ok(eIdx >= 0);
		assert.equal(argv[eIdx + 1], "C:/tmp/scope-guard.ts");
		assert.ok(argv.indexOf("--no-extensions") < eIdx);
	});

	it("keeps command line well under Windows limit even with huge conceptual task", () => {
		// Previously task was argv; 40k task would blow CreateProcess.
		const argv = buildRoleArgv(role, "C:/Users/nanoc/AppData/Local/Temp/pi-meta-loop-worker-abc/prompt.md");
		const len = estimateCommandLineLength("C:/Program Files/nodejs/node.exe", [
			"C:/Users/nanoc/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
			...argv,
		]);
		assert.ok(
			len < WINDOWS_CMDLINE_SOFT_LIMIT,
			`cmd line length ${len} should be < ${WINDOWS_CMDLINE_SOFT_LIMIT}`,
		);
	});
});

describe("killRoleProcessTree", () => {
	it("force-kills only an owned fixture child", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 30_000)"], {
			detached: process.platform !== "win32",
			stdio: "ignore",
			windowsHide: true,
		});
		await once(child, "spawn");
		const closed = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("owned fixture child did not exit")),
				10_000,
			);
			timer.unref();
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		try {
			killRoleProcessTree(child, { force: true });
			await closed;
			assert.ok(child.exitCode !== null || child.signalCode !== null);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				killRoleProcessTree(child, { force: true });
			}
		}
	});

	it("no-ops on missing or invalid pid", () => {
		killRoleProcessTree({ kill: () => true }, { force: true });
		killRoleProcessTree({ pid: 0, kill: () => true }, { force: true });
	});
});

describe("runRole pre-abort", () => {
	const role: LoadedRole = {
		name: "worker",
		systemPrompt: "test",
	};

	it("returns immediately with exitCode 1 + aborted when signal already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const t0 = Date.now();
		const result = await runRole(role, "should not spawn", {
			cwd: process.cwd(),
			signal: ac.signal,
		});
		const elapsed = Date.now() - t0;
		assert.equal(result.exitCode, 1);
		assert.match(result.output, /aborted/i);
		// Must not hang waiting on a child
		assert.ok(elapsed < 2000, `pre-abort took too long: ${elapsed}ms`);
	});
});

function processGroupIsAlive(groupId: number): boolean {
	try {
		process.kill(-groupId, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// Linux containers do not always reap orphaned grandchildren promptly. A
	// zombie cannot execute and is considered dead for this process-tree test.
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const stateOffset = stat.lastIndexOf(") ") + 2;
			if (stateOffset >= 2 && stat[stateOffset] === "Z") return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("spawnManagedProcess timeout + abort", () => {
	it("pre-aborted signal does not spawn and resolves exitCode 1", async () => {
		const ac = new AbortController();
		ac.abort();
		const t0 = Date.now();
		const result = await spawnManagedProcess({
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			signal: ac.signal,
		});
		const elapsed = Date.now() - t0;
		assert.equal(result.exitCode, 1);
		assert.equal(result.aborted, true);
		assert.equal(result.timedOut, false);
		assert.match(result.stderr, /aborted/i);
		assert.ok(elapsed < 2000, `pre-abort took too long: ${elapsed}ms`);
	});

	it("timeoutSec tree-kills a hanging child and records timeout", async () => {
		// Lightweight hang: sleep ~30s unless killed. timeoutSec=1 must win quickly.
		const hangScript =
			process.platform === "win32"
				? "setTimeout(()=>{}, 30000)"
				: "setTimeout(()=>{}, 30000)";
		const t0 = Date.now();
		const result = await spawnManagedProcess({
			command: process.execPath,
			args: ["-e", hangScript],
			timeoutSec: 1,
		});
		const elapsed = Date.now() - t0;
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, true);
		assert.match(result.stderr, /timeout/i);
		// Should finish near 1s + grace, not 30s. Allow headroom for CI/Windows.
		assert.ok(elapsed < 12_000, `timeout kill took too long: ${elapsed}ms`);
		assert.ok(elapsed >= 800, `timeout fired too early: ${elapsed}ms`);
	});

	it("mid-run abort kills child and reports aborted", async () => {
		const ac = new AbortController();
		const hang = spawnManagedProcess({
			command: process.execPath,
			args: ["-e", "setTimeout(()=>{}, 30000)"],
			signal: ac.signal,
		});
		// Abort shortly after start
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		const result = await hang;
		assert.equal(result.exitCode, 1);
		assert.equal(result.aborted, true);
		assert.match(result.stderr, /aborted/i);
	});

	it(
		"does not settle on direct close before force-killing a TERM-resistant grandchild",
		{
			timeout: 20_000,
			skip: process.platform === "win32" ? "POSIX process-group fixture" : false,
		},
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-meta-loop-tree-"));
			const parentPidFile = path.join(dir, "parent.pid");
			const grandchildPidFile = path.join(dir, "grandchild.pid");
			const grandchildScript = [
				'const fs = require("node:fs");',
				'process.on("SIGTERM", () => {});',
				'fs.writeFileSync(process.argv[1], String(process.pid));',
				"setInterval(() => {}, 30000);",
			].join(" ");
			const parentScript = [
				'const { spawn } = require("node:child_process");',
				'const fs = require("node:fs");',
				"const parentFile = process.argv[1];",
				"const childFile = process.argv[2];",
				"fs.writeFileSync(parentFile, String(process.pid));",
				`spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}, childFile], { stdio: "ignore" });`,
				'process.on("SIGTERM", () => process.exit(0));',
				"setInterval(() => {}, 30000);",
			].join(" ");

			// This sentinel owns another detached group. It proves cancellation is
			// scoped to the fixture's exact PID/group rather than a broad process kill.
			const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], {
				detached: true,
				stdio: "ignore",
			});
			await once(sentinel, "spawn");
			const sentinelPid = sentinel.pid;
			assert.ok(sentinelPid && sentinelPid > 0);

			const controller = new AbortController();
			let managed: Promise<Awaited<ReturnType<typeof spawnManagedProcess>>> | undefined;
			let fixtureGroup: number | undefined;
			let grandchildPid: number | undefined;
			try {
				managed = spawnManagedProcess({
					command: process.execPath,
					args: ["-e", parentScript, parentPidFile, grandchildPidFile],
					signal: controller.signal,
				});
				await waitUntil(
					() => fs.existsSync(parentPidFile) && fs.existsSync(grandchildPidFile),
					5000,
				);
				fixtureGroup = Number.parseInt(fs.readFileSync(parentPidFile, "utf-8"), 10);
				grandchildPid = Number.parseInt(fs.readFileSync(grandchildPidFile, "utf-8"), 10);
				assert.ok(fixtureGroup > 0 && grandchildPid > 0);
				assert.notEqual(fixtureGroup, sentinelPid);
				assert.notEqual(grandchildPid, sentinelPid);

				let resolved = false;
				void managed.then(() => {
					resolved = true;
				});
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 1000));
				assert.equal(resolved, false, "direct child close must not cancel forced escalation");
				assert.equal(processIsRunning(fixtureGroup), false, "TERM should close the direct child");
				assert.equal(
					processIsRunning(grandchildPid),
					true,
					"TERM-resistant grandchild should survive until the forced group signal",
				);

				const result = await managed;
				assert.equal(result.exitCode, 1);
				assert.equal(result.aborted, true);
				assert.match(result.stderr, /aborted/i);
				await waitUntil(() => !processIsRunning(grandchildPid!), 3000);
				assert.equal(processIsRunning(sentinelPid), true, "unrelated owned group was signaled");
			} finally {
				controller.abort();
				if (fixtureGroup && fixtureGroup > 0 && processGroupIsAlive(fixtureGroup)) {
					try {
						process.kill(-fixtureGroup, "SIGKILL");
					} catch {
						/* fixture group exited between the owned-group probe and cleanup */
					}
				}
				if (processIsRunning(sentinelPid)) {
					try {
						process.kill(-sentinelPid, "SIGKILL");
					} catch {
						/* sentinel already dead */
					}
				}
				await managed?.catch(() => undefined);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("normal short child exits 0 and clears timers", async () => {
		const startedAt = Date.now();
		const result = await spawnManagedProcess({
			command: process.execPath,
			args: ["-e", "process.stdout.write('ok'); process.exit(0)"],
			timeoutSec: 5,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, false);
		assert.equal(result.aborted, false);
		assert.equal(result.stdout, "ok");
		assert.ok(Date.now() - startedAt < 2000, "normal exit waited for kill timers");
	});
});
