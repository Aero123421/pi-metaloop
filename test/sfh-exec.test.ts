import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	SFH_PRESET_TOOLS,
	generateFlowYaml,
	isSfhPresetTool,
	killSfhProcessTree,
	runSfhFlow,
	sanitizeId,
	validateSfhAccess,
	validateSfhTool,
	writeFlowFile,
	type FlowSpec,
} from "../src/sfh-exec.ts";

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

function baseSpec(over: Partial<FlowSpec> = {}): FlowSpec {
	return {
		name: "meta-loop-x",
		timeoutSec: 60,
		maxParallel: 2,
		defaultAccess: "read",
		branches: [{ id: "a", tool: "pi", access: "read", prompt: "p" }],
		integrationPrompt: "i {{steps.fanout.outputs}}",
		integrationAccess: "read",
		...over,
	};
}

describe("sfh tool fixed enum", () => {
	it("includes sfh --help presets (pi/claude/codex + peers)", () => {
		for (const t of ["pi", "claude", "codex", "opencode", "grok", "agy", "cursor"] as const) {
			assert.ok(SFH_PRESET_TOOLS.includes(t), `missing preset ${t}`);
			assert.equal(isSfhPresetTool(t), true);
			assert.equal(validateSfhTool(t), null);
		}
		// default undefined → pi
		assert.equal(validateSfhTool(undefined), null);
		assert.equal(isSfhPresetTool(undefined), true);
	});

	it("rejects unknown branch.tool and does not generate flow", () => {
		assert.throws(
			() =>
				generateFlowYaml(
					baseSpec({
						branches: [{ id: "evil", tool: "not-a-real-tool", access: "read", prompt: "x" }],
					}),
				),
			/unknown sfh tool "not-a-real-tool"/,
		);
	});

	it("rejects unknown integrate tool and does not generate flow", () => {
		assert.throws(
			() =>
				generateFlowYaml(
					baseSpec({
						integrationTool: "gemini-evil",
					}),
				),
			/unknown sfh tool "gemini-evil"/,
		);
	});

	it("rejects non-enum access before bare YAML emission", () => {
		assert.equal(validateSfhAccess("write"), null);
		assert.throws(
			() => generateFlowYaml(baseSpec({ defaultAccess: "read\nevil: true" })),
			/invalid sfh access/,
		);
		assert.throws(
			() => generateFlowYaml(baseSpec({ integrationAccess: "full: injected" })),
			/invalid sfh access/,
		);
		assert.throws(
			() =>
				generateFlowYaml(
					baseSpec({ branches: [{ id: "a", tool: "pi", access: "", prompt: "x" }] }),
				),
			/invalid sfh access/,
		);
	});

	it("rejects YAML-injection-looking tool names", () => {
		assert.throws(
			() =>
				generateFlowYaml(
					baseSpec({
						branches: [
							{
								id: "a",
								tool: "pi\n    evil: true",
								access: "read",
								prompt: "x",
							},
						],
					}),
				),
			/unknown sfh tool/,
		);
	});
});

describe("generateFlowYaml scalar quoting", () => {
	it("keeps access/tool as bare enum scalars (runtime /access: read/ contract)", () => {
		const y = generateFlowYaml(baseSpec());
		assert.match(y, /access: read/);
		assert.match(y, /^\s+tool: pi$/m);
		assert.doesNotMatch(y, /access: "read"/);
		assert.doesNotMatch(y, /tool: "pi"/);
	});

	it("JSON-quotes hostile name/model/effort/id (newline, ': ', injection)", () => {
		const hostileName = "flow\nname: injected";
		const hostileId = "br\nid: x";
		const hostileModel = 'gpt\n  evil: "yes"';
		const hostileEffort = "high\nfoo: bar";
		const y = generateFlowYaml(
			baseSpec({
				name: hostileName,
				defaultModel: hostileModel,
				defaultEffort: hostileEffort,
				branches: [
					{
						id: hostileId,
						tool: "codex",
						model: hostileModel,
						effort: hostileEffort,
						access: "read",
						prompt: "line1\nline2: not-a-key",
					},
				],
				integrationTool: "claude",
				integrationModel: hostileModel,
				integrationEffort: hostileEffort,
			}),
		);

		// Quoted forms must match JSON.stringify exactly
		assert.match(y, new RegExp(`name: ${JSON.stringify(hostileName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.ok(y.includes(`id: ${JSON.stringify(hostileId)}`));
		assert.ok(y.includes(`model: ${JSON.stringify(hostileModel)}`));
		assert.ok(y.includes(`effort: ${JSON.stringify(hostileEffort)}`));

		// Unquoted hostile fragments must not appear as free scalars outside prompt block
		const withoutPrompt = y
			.split("\n")
			.filter((line) => !/^\s{6,}/.test(line) || /^(name|id|model|effort|tool|access|api_|defaults|steps|parallel|timeout|max_)/.test(line.trim()))
			// drop block-scalar prompt bodies (indented content under prompt: |)
			.filter((line) => {
				// keep structural keys; drop deeply indented prompt body lines without a key
				if (/^\s{10,}[^:\s]/.test(line) && !line.trimStart().startsWith("-")) return false;
				if (/^\s{6,}[^:\s#-]/.test(line) && !/^\s+(id|tool|model|effort|access|timeout|prompt|parallel):/.test(line)) {
					// integrate prompt body at indent 6
					if (/^\s{6}[^ ]/.test(line) && !line.includes(":")) return false;
				}
				return true;
			})
			.join("\n");

		// Raw newline-split hostile name must not appear unquoted
		assert.doesNotMatch(withoutPrompt, /^name: flow$/m);
		assert.doesNotMatch(withoutPrompt, /^name: flow\n/m);
		assert.ok(!withoutPrompt.includes("name: flow\n"));
		// injection keys must only live inside quotes
		for (const line of y.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("prompt:")) continue;
			// bare structural keys only
			if (/^(api_version|name|defaults|timeout_sec|max_parallel|model|effort|access|env|PI_META_LOOP_DEPTH|steps|parallel|id|tool|on_error):-?\s*/.test(trimmed)) {
				if (trimmed.startsWith("name:") || trimmed.startsWith("id:") || trimmed.startsWith("model:") || trimmed.startsWith("effort:")) {
					// value side must start with " when free scalar
					const val = trimmed.split(":").slice(1).join(":").trim();
					if (val.length > 0) {
						assert.ok(val.startsWith('"'), `expected quoted scalar: ${trimmed}`);
					}
				}
			}
		}

		// prompt remains a block scalar (content unquoted inside |)
		assert.match(y, /prompt: \|/);
		assert.match(y, /line1/);
		assert.match(y, /line2: not-a-key/);
	});

	it("quotes normal name/id too (no bare free scalars for those keys)", () => {
		const y = generateFlowYaml(baseSpec({ name: "meta-loop-x", branches: [{ id: "a", tool: "pi", prompt: "p" }] }));
		assert.match(y, /name: "meta-loop-x"/);
		assert.match(y, /id: "a"/);
		// fanout/integrate step ids are fixed literals (not user free scalars) — still fine bare
		assert.match(y, /- id: fanout/);
		assert.match(y, /- id: integrate/);
	});
});

describe("sanitizeId", () => {
	it("strips hostile characters", () => {
		assert.equal(sanitizeId("a b/c"), "a-b-c");
		assert.equal(sanitizeId("---"), "task");
	});
});

describe("writeFlowFile path containment", () => {
	it("rejects symlink/junction flow directory escaping project cwd", () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ml-sfh-flow-sym-"));
		const cwd = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });

		const meta = path.join(cwd, ".pi", "meta-loop");
		fs.mkdirSync(meta, { recursive: true });
		const flowsLink = path.join(meta, "flows");
		const linkType = process.platform === "win32" ? "junction" : "dir";
		fs.symlinkSync(outside, flowsLink, linkType);

		assert.throws(
			() => writeFlowFile(cwd, "ticket-1", "api_version: 1\nname: \"x\"\n"),
			/symlink|junction|escape/i,
		);
		assert.equal(fs.existsSync(path.join(outside, "ticket-1.flow.yaml")), false);
		// No leaked files under outside
		assert.deepEqual(fs.readdirSync(outside), []);
	});

	it("writes under real .pi/meta-loop/flows inside cwd", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-sfh-flow-ok-"));
		const file = writeFlowFile(cwd, "ticket-ok", "api_version: 1\nname: \"ok\"\n");
		assert.ok(file.startsWith(cwd));
		assert.ok(fs.existsSync(file));
		assert.match(file.replace(/\\/g, "/"), /\.pi\/meta-loop\/flows\/ticket-ok\.flow\.yaml$/);
	});
});

describe("runSfhFlow abort", () => {
	it("pre-aborted signal returns failure without spawning", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runSfhFlow({
			binary: "definitely-not-a-real-sfh-binary",
			flowFile: "missing.flow.yaml",
			flowName: "x",
			cwd: process.cwd(),
			signal: controller.signal,
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /aborted/i);
	});

	it("keeps ordinary sfh process exits fast", async () => {
		const startedAt = Date.now();
		const result = await runSfhFlow({
			// Node treats the fixed `run` argument as a missing script and exits
			// normally/nonzero; no abort escalation timer should delay settlement.
			binary: process.execPath,
			flowFile: "unused.flow.yaml",
			flowName: "normal-exit-fixture",
			cwd: process.cwd(),
		});
		assert.notEqual(result.exitCode, 0);
		assert.ok(Date.now() - startedAt < 2000, "normal sfh exit waited for kill timers");
	});

	it(
		"preserves forced group escalation after the sfh parent closes",
		{
			timeout: 20_000,
			skip: process.platform === "win32" ? "POSIX executable/process-group fixture" : false,
		},
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-meta-loop-sfh-tree-"));
			const binary = path.join(dir, "fake-sfh");
			const grandchildPidFile = path.join(dir, "grandchild.pid");
			const parentPidFile = `${grandchildPidFile}.parent`;
			const grandchildScript = [
				'const fs = require("node:fs");',
				'process.on("SIGTERM", () => {});',
				'fs.writeFileSync(process.argv[1], String(process.pid));',
				"setInterval(() => {}, 30000);",
			].join(" ");
			fs.writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					'const { spawn } = require("node:child_process");',
					'const fs = require("node:fs");',
					"const childFile = process.argv[3];",
					'fs.writeFileSync(`${childFile}.parent`, String(process.pid));',
					`spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}, childFile], { stdio: "ignore" });`,
					'process.on("SIGTERM", () => process.exit(0));',
					"setInterval(() => {}, 30000);",
				].join("\n"),
				{ mode: 0o755 },
			);

			const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], {
				detached: true,
				stdio: "ignore",
			});
			await once(sentinel, "spawn");
			const sentinelPid = sentinel.pid;
			assert.ok(sentinelPid && sentinelPid > 0);

			const controller = new AbortController();
			let run: ReturnType<typeof runSfhFlow> | undefined;
			let fixtureGroup: number | undefined;
			let grandchildPid: number | undefined;
			try {
				run = runSfhFlow({
					binary,
					flowFile: grandchildPidFile,
					flowName: "fixture",
					cwd: dir,
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

				let resolved = false;
				void run.then(() => {
					resolved = true;
				});
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 1000));
				assert.equal(resolved, false, "sfh close must not cancel forced escalation");
				assert.equal(processIsRunning(fixtureGroup), false);
				assert.equal(processIsRunning(grandchildPid), true);

				const result = await run;
				assert.equal(result.exitCode, 1);
				assert.match(result.stderr, /aborted/i);
				await waitUntil(() => !processIsRunning(grandchildPid!), 3000);
				assert.equal(processIsRunning(sentinelPid), true, "unrelated group was signaled");
			} finally {
				controller.abort();
				if (fixtureGroup && fixtureGroup > 0 && processGroupIsAlive(fixtureGroup)) {
					try {
						process.kill(-fixtureGroup, "SIGKILL");
					} catch {
						/* fixture exited between probe and cleanup */
					}
				}
				if (processIsRunning(sentinelPid)) {
					try {
						process.kill(-sentinelPid, "SIGKILL");
					} catch {
						/* sentinel already dead */
					}
				}
				await run?.catch(() => undefined);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("killSfhProcessTree", () => {
	it("kills an actual owned fixture child and waits for its death", { timeout: 15_000 }, async () => {
		// Never probe a magic PID (especially pid=1) or signal a synthetic -1
		// process group. The detached POSIX child owns the exact group targeted by
		// killSfhProcessTree; Windows targets this child via taskkill /T /F.
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: process.platform !== "win32",
			stdio: "ignore",
			windowsHide: true,
		});
		await once(child, "spawn");
		const pid = child.pid;
		assert.ok(pid && pid > 0, "fixture child must have an owned pid");

		const exited = once(child, "exit");
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			killSfhProcessTree(child, { force: true });
			await Promise.race([
				exited,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error(`fixture child ${pid} did not exit`)), 10_000);
				}),
			]);
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			try {
				process.kill(pid, 0);
				killSfhProcessTree(child, { force: true });
			} catch {
				/* already dead */
			}
		}
	});

	it("no-ops on missing pid", () => {
		killSfhProcessTree({ kill: () => true }, { force: true, platform: "win32" });
	});
});
