import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildConfigFromLayers, unsupportedSfhAccessSettings } from "../src/config.ts";
import { evaluateFilesystemEvidence } from "../src/runtime.ts";
import type { FilesystemSnapshot } from "../src/fs-snapshot.ts";
import type { Ticket } from "../src/types.ts";

describe("project cannot choose the supervising model", () => {
	it("keeps base role models by default", () => {
		const cfg = buildConfigFromLayers(
			[{ roles: { supervisor: { model: "trusted/strong" }, worker: { model: "trusted/worker" } } }],
			[{ roles: { supervisor: { model: "attacker/cheap" }, worker: { model: "attacker/cheap" } } }],
		);
		assert.equal(cfg.supervisor === undefined, false);
		assert.equal(cfg.roles.supervisor.model, "trusted/strong");
		assert.equal(cfg.roles.worker.model, "trusted/worker");
		assert.equal(cfg.allowProjectModelOverride, false);
	});

	it("honors an explicit user opt-in", () => {
		const cfg = buildConfigFromLayers(
			[{ allowProjectModelOverride: true, roles: { supervisor: { model: "trusted/strong" } } }],
			[{ roles: { supervisor: { model: "project/preferred" } } }],
		);
		assert.equal(cfg.roles.supervisor.model, "project/preferred");
	});

	it("a project cannot grant itself the opt-in", () => {
		const cfg = buildConfigFromLayers(
			[{ roles: { supervisor: { model: "trusted/strong" } } }],
			[{ allowProjectModelOverride: true, roles: { supervisor: { model: "attacker/cheap" } } }],
		);
		assert.equal(cfg.allowProjectModelOverride, false);
		assert.equal(cfg.roles.supervisor.model, "trusted/strong");
	});

	it("tool narrowing still applies while models are pinned", () => {
		const cfg = buildConfigFromLayers(
			[{ roles: { orchestrator: { model: "trusted/strong", tools: ["read", "ls", "grep"] } } }],
			[{ roles: { orchestrator: { model: "attacker/cheap", tools: ["read"] } } }],
		);
		assert.equal(cfg.roles.orchestrator.model, "trusted/strong");
		assert.deepEqual(cfg.roles.orchestrator.tools, ["read"]);
	});
});

describe("unsupported sfh access is reported up front", () => {
	it("lists every mutating access setting", () => {
		const cfg = buildConfigFromLayers([
			{
				executor: {
					sfhAccess: "write",
					sfhIntegrateAccess: "full",
					sfhToolAccess: { pi: "read", codex: "write" },
				},
			},
		]);
		assert.deepEqual(unsupportedSfhAccessSettings(cfg).sort(), [
			"executor.sfhAccess=write",
			"executor.sfhIntegrateAccess=full",
			"executor.sfhToolAccess.codex=write",
		]);
	});

	it("is silent for a read-only configuration", () => {
		const cfg = buildConfigFromLayers([{ executor: { sfhAccess: "read" } }]);
		assert.deepEqual(unsupportedSfhAccessSettings(cfg), []);
	});
});

describe("evidence failures are attributed, not assumed", () => {
	const ticket: Ticket = {
		id: "t1",
		goal: "g",
		deliverables: [],
		acceptance: ["a"],
		allowed_scope: ["src/**"],
		forbidden: [],
		dependencies: [],
		status: "running",
	};
	const snapshot = (ok: boolean): FilesystemSnapshot => ({
		ok,
		cwd: "/tmp/x",
		parent: "/tmp",
		entries: new Map(),
		entryCount: 0,
		hashedBytes: 0,
		elapsedMs: 1,
		error: ok ? undefined : "entry limit exceeded",
	});

	it("marks a coverage failure as external, not the Worker's fault", () => {
		const pre = evaluateFilesystemEvidence("/tmp/x", ticket, snapshot(false), snapshot(true));
		assert.equal(pre.fatalAttribution, "external");
		assert.match(pre.fatalError ?? "", /pre/);

		const post = evaluateFilesystemEvidence("/tmp/x", ticket, snapshot(true), snapshot(false));
		assert.equal(post.fatalAttribution, "external");
		assert.match(post.fatalError ?? "", /post/);
	});

	it("reports no fatal error when both snapshots succeeded", () => {
		const ok = evaluateFilesystemEvidence("/tmp/x", ticket, snapshot(true), snapshot(true));
		assert.equal(ok.fatalError, undefined);
		assert.equal(ok.fatalAttribution, undefined);
	});
});
