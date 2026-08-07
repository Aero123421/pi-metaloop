import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertSfhToolAllowed,
	buildConfigFromLayers,
	captureSfhAccessCeiling,
	defaultConfig,
	effectiveNativeWorkerTools,
	nativeWorkerToolsDenial,
	resolveMaxTasksCeiling,
	resolveSfhBranchAccess,
	resolveSfhIntegrateAccess,
	type MetaLoopConfig,
} from "../src/config.ts";

function executorLayer(ex: Record<string, unknown>): Record<string, unknown> {
	return { executor: ex };
}

describe("role tool ceilings", () => {
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

		assert.deepEqual(effectiveNativeWorkerTools(["bash", "read", "BASH"]), ["read"]);
		assert.match(nativeWorkerToolsDenial(["read", "bash"]) ?? "", /bash/i);
		assert.equal(nativeWorkerToolsDenial(["read", "edit"]), null);
	});
});

describe("sfh tool allowlist", () => {
	it("treats undefined as unrestricted", () => {
		const cfg = buildConfigFromLayers();
		assert.equal(cfg.executor.sfhAllowedTools, undefined);
		assert.equal(assertSfhToolAllowed("codex", cfg), null);
		assert.equal(assertSfhToolAllowed(undefined, cfg), null);
	});

	it("treats an explicit empty list as deny-all", () => {
		const cfg = buildConfigFromLayers([executorLayer({ sfhAllowedTools: [] })]);
		assert.deepEqual(cfg.executor.sfhAllowedTools, []);
		assert.match(assertSfhToolAllowed("pi", cfg) ?? "", /not allowed.*none/);
		assert.match(assertSfhToolAllowed(undefined, cfg) ?? "", /not allowed.*none/);
	});

	it("lets project lists narrow unrestricted/list ceilings but never expand deny-all", () => {
		const fromUnrestricted = buildConfigFromLayers(
			[],
			[executorLayer({ sfhAllowedTools: ["pi"] })],
		);
		assert.deepEqual(fromUnrestricted.executor.sfhAllowedTools, ["pi"]);
		assert.equal(assertSfhToolAllowed("pi", fromUnrestricted), null);
		assert.match(assertSfhToolAllowed("codex", fromUnrestricted) ?? "", /not allowed/);

		const intersection = buildConfigFromLayers(
			[executorLayer({ sfhAllowedTools: ["pi", "codex"] })],
			[executorLayer({ sfhAllowedTools: ["codex", "claude"] })],
		);
		assert.deepEqual(intersection.executor.sfhAllowedTools, ["codex"]);

		const denyAll = buildConfigFromLayers(
			[executorLayer({ sfhAllowedTools: [] })],
			[executorLayer({ sfhAllowedTools: ["pi"] })],
		);
		assert.deepEqual(denyAll.executor.sfhAllowedTools, []);
	});

	it("preserves a base allowlist when the project omits the setting", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ sfhAllowedTools: ["pi"] })],
			[executorLayer({ sfhModel: "project-model" })],
		);
		assert.deepEqual(cfg.executor.sfhAllowedTools, ["pi"]);
	});
});

describe("project-only narrowing", () => {
	it("accepts lower executor timeoutSec and maxParallel", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ timeoutSec: 1_200, maxParallel: 8 })],
			[executorLayer({ timeoutSec: 600, maxParallel: 3 })],
		);
		assert.equal(cfg.executor.timeoutSec, 600);
		assert.equal(cfg.executor.maxParallel, 3);
	});

	it("rejects higher executor timeoutSec and maxParallel", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ timeoutSec: 600, maxParallel: 3 })],
			[executorLayer({ timeoutSec: 1_200, maxParallel: 8 })],
		);
		assert.equal(cfg.executor.timeoutSec, 600);
		assert.equal(cfg.executor.maxParallel, 3);
	});

	it("cannot raise limits but can lower them", () => {
		const cfg = buildConfigFromLayers(
			[{ limits: { maxTasks: 12, concurrency: 6, perTaskOutputCap: 100_000 } }],
			[
				{ limits: { maxTasks: 20, concurrency: 8, perTaskOutputCap: 200_000 } },
				{ limits: { maxTasks: 5, concurrency: 2, perTaskOutputCap: 40_000 } },
			],
		);
		assert.deepEqual(cfg.limits, {
			maxTasks: 5,
			concurrency: 2,
			perTaskOutputCap: 40_000,
		});
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

describe("sfh access ceiling capture", () => {
	it("captures base sfhAccess/sfhToolAccess/sfhIntegrateAccess onto MetaLoopConfig", () => {
		const cfg = buildConfigFromLayers([
			executorLayer({
				sfhAccess: "write",
				sfhIntegrateAccess: "read",
				sfhToolAccess: { pi: "read", opencode: "full" },
			}),
		]);
		assert.ok(cfg.sfhAccessCeiling);
		assert.equal(cfg.sfhAccessCeiling!.sfhAccess, "write");
		assert.equal(cfg.sfhAccessCeiling!.sfhIntegrateAccess, "read");
		assert.equal(cfg.sfhAccessCeiling!.sfhToolAccess.pi, "read");
		assert.equal(cfg.sfhAccessCeiling!.sfhToolAccess.opencode, "full");
	});

	it("unspecified project access fields preserve current values", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ sfhAccess: "full", sfhIntegrateAccess: "write" })],
			[executorLayer({ sfhModel: "project-model" })],
		);
		assert.equal(cfg.executor.sfhAccess, "full");
		assert.equal(cfg.executor.sfhIntegrateAccess, "write");
		assert.equal(resolveSfhBranchAccess({ tool: "pi" }, cfg), "full");
		assert.equal(resolveSfhIntegrateAccess(cfg), "write");
	});

	it("project layer cannot raise access above base ceiling on executor fields", () => {
		const cfg = buildConfigFromLayers(
			[executorLayer({ sfhAccess: "write", sfhIntegrateAccess: "read", sfhToolAccess: { pi: "read" } })],
			[executorLayer({ sfhAccess: "full", sfhIntegrateAccess: "full", sfhToolAccess: { pi: "full" } })],
		);
		assert.equal(cfg.executor.sfhAccess, "write");
		assert.equal(cfg.executor.sfhIntegrateAccess, "read");
		assert.equal(cfg.executor.sfhToolAccess?.pi, "read");
		// ceiling stays at base values
		assert.equal(cfg.sfhAccessCeiling!.sfhAccess, "write");
		assert.equal(cfg.sfhAccessCeiling!.sfhIntegrateAccess, "read");
	});
});

describe("resolveSfhBranchAccess privilege matrix", () => {
	const cases: Array<{
		name: string;
		base: Record<string, unknown>;
		project?: Record<string, unknown>;
		branch: { tool?: string; access?: string };
		expect: string;
	}> = [
		{
			name: "unspecified branch keeps fallback to sfhAccess",
			base: { sfhAccess: "write" },
			branch: { tool: "pi" },
			expect: "write",
		},
		{
			name: "unspecified branch prefers tool map over sfhAccess",
			base: { sfhAccess: "full", sfhToolAccess: { pi: "read" } },
			branch: { tool: "pi" },
			expect: "read",
		},
		{
			name: "ticket branch.access cannot raise above user sfhAccess ceiling",
			base: { sfhAccess: "write" },
			branch: { tool: "pi", access: "full" },
			expect: "write",
		},
		{
			name: "ticket branch.access can narrow below ceiling",
			base: { sfhAccess: "full" },
			branch: { tool: "pi", access: "read" },
			expect: "read",
		},
		{
			name: "user read ceiling blocks ticket write",
			base: { sfhAccess: "read" },
			branch: { access: "write" },
			expect: "read",
		},
		{
			name: "project cannot raise then ticket escalate past user ceiling",
			base: { sfhAccess: "write" },
			project: { sfhAccess: "full" },
			branch: { access: "full" },
			expect: "write",
		},
		{
			name: "project narrows sfhAccess; unspecified branch follows narrowed value",
			base: { sfhAccess: "full" },
			project: { sfhAccess: "read" },
			branch: { tool: "pi" },
			expect: "read",
		},
		{
			name: "tool-specific base ceiling clamps ticket branch.access for that tool",
			base: { sfhAccess: "full", sfhToolAccess: { pi: "read" } },
			branch: { tool: "pi", access: "full" },
			expect: "read",
		},
		{
			name: "tool-specific ceiling does not clamp other tools (falls back to sfhAccess)",
			base: { sfhAccess: "write", sfhToolAccess: { pi: "read" } },
			branch: { tool: "opencode", access: "full" },
			expect: "write",
		},
		{
			name: "project tool map cannot raise new tool above sfhAccess ceiling via resolve",
			base: { sfhAccess: "write" },
			project: { sfhToolAccess: { opencode: "full" } },
			branch: { tool: "opencode" },
			expect: "write",
		},
		{
			name: "default base ceiling is read (from defaults)",
			base: {},
			branch: { access: "full" },
			expect: "read",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			const cfg = buildConfigFromLayers(
				[executorLayer(c.base)],
				c.project ? [executorLayer(c.project)] : [],
			);
			assert.equal(resolveSfhBranchAccess(c.branch, cfg), c.expect);
			if (c.name === "project tool map cannot raise new tool above sfhAccess ceiling via resolve") {
				assert.equal(cfg.executor.sfhToolAccess?.opencode, "write");
			}
		});
	}
});

describe("resolveSfhIntegrateAccess privilege matrix", () => {
	const cases: Array<{
		name: string;
		base: Record<string, unknown>;
		project?: Record<string, unknown>;
		expect: string;
	}> = [
		{
			name: "uses sfhIntegrateAccess when set",
			base: { sfhAccess: "full", sfhIntegrateAccess: "write" },
			expect: "write",
		},
		{
			name: "falls back to sfhAccess when integrate unset in layer (default integrate still present)",
			// build from explicit ceiling-only path: empty base keeps defaults integrate=read, access=read
			base: {},
			expect: "read",
		},
		{
			name: "project cannot raise integrate above user ceiling",
			base: { sfhIntegrateAccess: "read", sfhAccess: "full" },
			project: { sfhIntegrateAccess: "full" },
			expect: "read",
		},
		{
			name: "project can narrow integrate",
			base: { sfhIntegrateAccess: "full" },
			project: { sfhIntegrateAccess: "read" },
			expect: "read",
		},
		{
			name: "user write integrate ceiling blocks project full",
			base: { sfhIntegrateAccess: "write" },
			project: { sfhIntegrateAccess: "full" },
			expect: "write",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			const cfg = buildConfigFromLayers(
				[executorLayer(c.base)],
				c.project ? [executorLayer(c.project)] : [],
			);
			assert.equal(resolveSfhIntegrateAccess(cfg), c.expect);
		});
	}

	it("ticket branch.access escalation does not raise integrate access", () => {
		// Branch and integrate ceilings are independent; runtime must not max them together.
		const cfg = buildConfigFromLayers([executorLayer({ sfhIntegrateAccess: "read", sfhAccess: "read" })]);
		assert.equal(resolveSfhIntegrateAccess(cfg), "read");
		assert.equal(resolveSfhBranchAccess({ access: "full" }, cfg), "read");
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

describe("resolve without ceiling keeps legacy fallback (compat)", () => {
	it("branch.access wins when no ceiling attached", () => {
		const cfg: MetaLoopConfig = {
			...defaultConfig,
			executor: { ...defaultConfig.executor, sfhAccess: "read", sfhToolAccess: {}, sfhIntegrateAccess: "read" },
			sfhAccessCeiling: undefined,
		};
		assert.equal(resolveSfhBranchAccess({ access: "full" }, cfg), "full");
	});

	it("captureSfhAccessCeiling then clamps subsequent resolve", () => {
		const cfg: MetaLoopConfig = {
			...defaultConfig,
			executor: {
				...defaultConfig.executor,
				sfhAccess: "write",
				sfhToolAccess: {},
				sfhIntegrateAccess: "read",
			},
		};
		captureSfhAccessCeiling(cfg);
		assert.equal(resolveSfhBranchAccess({ access: "full" }, cfg), "write");
		assert.equal(resolveSfhIntegrateAccess(cfg), "read");
	});
});
