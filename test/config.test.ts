import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildConfigFromLayers,
	defaultConfig,
	effectiveNativeWorkerTools,
	loadConfig,
	nativeWorkerToolsDenial,
	resolveMaxTasksCeiling,
	type MetaLoopConfig,
} from "../src/config.ts";

function executorLayer(ex: Record<string, unknown>): Record<string, unknown> {
	return { executor: ex };
}

describe("role tool ceilings", () => {
	it("disables meta-loop for an unsupported project config version", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-meta-loop-config-version-"));
		const configDir = path.join(cwd, ".pi", "meta-loop");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ config_version: 999 }));
		const originalError = console.error;
		console.error = () => {};
		try {
			assert.equal(loadConfig(cwd).enabled, false);
		} finally {
			console.error = originalError;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps omitted project tools at inherited defaults", () => {
		const cfg = buildConfigFromLayers([], [{ roles: { worker: {} } }]);
		assert.deepEqual(cfg.roles.worker.tools, defaultConfig.roles.worker.tools);
	});

	it("preserves explicit project deny-all and never expands an empty base list", () => {
		const narrowed = buildConfigFromLayers([], [{ roles: { worker: { tools: [] } } }]);
		assert.deepEqual(narrowed.roles.worker.tools, []);

		const cannotExpand = buildConfigFromLayers(
			[{ roles: { worker: { tools: [] } } }],
			[{ roles: { worker: { tools: ["read", "write"] } } }],
		);
		assert.deepEqual(cannotExpand.roles.worker.tools, []);
	});

	it("intersects project tools with the inherited role allowlist", () => {
		const cfg = buildConfigFromLayers(
			[{ roles: { worker: { tools: ["read", "edit"] } } }],
			[{ roles: { worker: { tools: ["edit", "bash"] } } }],
		);
		assert.deepEqual(cfg.roles.worker.tools, ["edit"]);
	});

	it("never grants bash on effective native worker tools (config/alias request stripped)", () => {
		assert.deepEqual(defaultConfig.roles.worker.tools, [
			"read",
			"write",
			"edit",
			"ls",
			"find",
			"grep",
		]);
		assert.ok(!defaultConfig.roles.worker.tools?.includes("bash"));

		// Base may list bash; project cannot re-add it, and load always strips it.
		const cfg = buildConfigFromLayers(
			[{ roles: { worker: { tools: ["read", "write", "edit", "bash", "grep"] } } }],
			[{ roles: { worker: { tools: ["read", "bash", "grep"] } } }],
		);
		assert.deepEqual(cfg.roles.worker.tools, ["read", "grep"]);
		assert.ok(!cfg.roles.worker.tools?.includes("bash"));

		const baseOnly = buildConfigFromLayers([
			{ roles: { worker: { tools: ["read", "write", "bash"] } } },
		]);
		assert.deepEqual(baseOnly.roles.worker.tools, ["read", "write"]);

		assert.deepEqual(effectiveNativeWorkerTools(["bash", "read", "BASH", "my_write"]), ["read"]);
		assert.match(nativeWorkerToolsDenial(["read", "bash"]) ?? "", /bash/i);
		assert.match(nativeWorkerToolsDenial(["read", "custom_tool"]) ?? "", /custom_tool/i);
		assert.equal(nativeWorkerToolsDenial(["read", "edit"]), null);
	});

	it("project cannot introduce verifyCommands; base commands can be narrowed only", () => {
		const introduced = buildConfigFromLayers(
			[],
			[executorLayer({ verifyCommands: [["npm", "test"]] })],
		);
		assert.deepEqual(introduced.executor.verifyCommands, []);

		const narrowed = buildConfigFromLayers(
			[executorLayer({ verifyCommands: [["npm", "test"], ["npx", "tsc", "--noEmit"]] })],
			[executorLayer({ verifyCommands: [["npm", "test"], ["evil", "pwn"]] })],
		);
		assert.deepEqual(narrowed.executor.verifyCommands, [["npm", "test"]]);

		const base = buildConfigFromLayers([
			executorLayer({ verifyCommands: [["node", "--test"]], verifyTimeoutSec: 120 }),
		]);
		assert.deepEqual(base.executor.verifyCommands, [["node", "--test"]]);
		assert.equal(base.executor.verifyTimeoutSec, 120);
	});

	it("project may select but never define a user-approved verify profile", () => {
		const selected = buildConfigFromLayers(
			[executorLayer({ verifyProfiles: { node: [["npm", "test"], ["npm", "run", "typecheck"]] } })],
			[executorLayer({ verifyProfile: "node" })],
		);
		assert.equal(selected.executor.verifyProfile, "node");
		assert.deepEqual(selected.executor.verifyCommands, [["npm", "test"], ["npm", "run", "typecheck"]]);

		const unknown = buildConfigFromLayers(
			[executorLayer({ verifyProfiles: { node: [["npm", "test"]] } })],
			[executorLayer({ verifyProfile: "evil", verifyProfiles: { evil: [["evil", "run"]] } })],
		);
		assert.deepEqual(unknown.executor.verifyCommands, []);
		assert.equal(unknown.executor.verifyProfiles?.evil, undefined);
	});
});

describe("project-only narrowing", () => {
	it("accepts a lower executor timeoutSec", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ timeoutSec: 1_200 })],
			[executorLayer({ timeoutSec: 600 })],
		);
		assert.equal(cfg.executor.timeoutSec, 600);
	});

	it("rejects a higher executor timeoutSec", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ timeoutSec: 600 })],
			[executorLayer({ timeoutSec: 1_200 })],
		);
		assert.equal(cfg.executor.timeoutSec, 600);
	});

	it("can narrow task/output limits but cannot change the audit budget", () => {
		const cfg = buildConfigFromLayers(
			[{ limits: { maxTasks: 12, perTaskOutputCap: 100_000, maxSupervisions: 9 } }],
			[
				{ limits: { maxTasks: 20, perTaskOutputCap: 200_000, maxSupervisions: 40 } },
				{ limits: { maxTasks: 5, perTaskOutputCap: 40_000, maxSupervisions: 3 } },
			],
		);
		assert.deepEqual(cfg.limits, {
			maxTasks: 5,
			perTaskOutputCap: 40_000,
			maxSupervisions: 9,
			scopeCeiling: undefined,
		});
	});

	it("project may tighten but never widen the scope ceiling", () => {
		const widened = buildConfigFromLayers(
			[{ limits: { scopeCeiling: ["src/**"] } }],
			[{ limits: { scopeCeiling: ["src/**", "infra/**"] } }],
		);
		assert.deepEqual(widened.limits.scopeCeiling, ["src/**"]);

		const tightened = buildConfigFromLayers(
			[{ limits: { scopeCeiling: ["src/**", "test/**"] } }],
			[{ limits: { scopeCeiling: ["src/**"] } }],
		);
		assert.deepEqual(tightened.limits.scopeCeiling, ["src/**"]);

		// Introducing a ceiling where none existed only restricts the write surface,
		// so a project is allowed to do it.
		const introduced = buildConfigFromLayers([], [{ limits: { scopeCeiling: ["src/**"] } }]);
		assert.deepEqual(introduced.limits.scopeCeiling, ["src/**"]);
	});

	it("cannot re-enable or raise supervisor settings but can lower them", () => {
		const cfg = buildConfigFromLayers(
			[
				{
					supervisor: {
						auto: false,
						checkIntervalMinutes: 30,
						workerStartThreshold: 8,
						maxConsecutiveFailures: 4,
					},
				},
			],
			[
				{
					supervisor: {
						auto: true,
						checkIntervalMinutes: 60,
						workerStartThreshold: 12,
						maxConsecutiveFailures: 9,
					},
				},
				{
					supervisor: {
						checkIntervalMinutes: 10,
						workerStartThreshold: 3,
						maxConsecutiveFailures: 1,
					},
				},
			],
		);
		assert.deepEqual(cfg.supervisor, {
			auto: false,
			checkIntervalMinutes: 10,
			workerStartThreshold: 3,
			maxConsecutiveFailures: 1,
		});
	});
});

describe("max_tasks configured ceiling", () => {
	it("tool input narrows but never raises config", () => {
		assert.equal(resolveMaxTasksCeiling(8, undefined), 8);
		assert.equal(resolveMaxTasksCeiling(8, 3), 3);
		assert.equal(resolveMaxTasksCeiling(8, 64), 8);
		assert.equal(resolveMaxTasksCeiling(100, 100), 64);
		assert.equal(resolveMaxTasksCeiling(8, 0), 1);
	});
});
