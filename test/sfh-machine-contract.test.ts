import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { runSfhFlow, runSfhPreflight } from "../src/sfh-exec.ts";

it("matches the installed SFH schema-v1 run envelope", async (t) => {
	const found = spawnSync("sfh", ["--version"], { encoding: "utf-8" });
	if (found.status !== 0) return t.skip("sfh is not installed");

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-meta-loop-sfh-contract-"));
	const flow = path.join(cwd, "flow.yaml");
	fs.writeFileSync(flow, [
		"api_version: 1",
		'name: "pi-meta-loop-contract"',
		"steps:",
		"  - id: version",
		'    cmd: ["sfh", "--version"]',
		"    effects: read",
	].join("\n"));

	try {
		const preflight = runSfhPreflight("sfh", flow, cwd);
		assert.equal(preflight.ok, true, preflight.errorMessage ?? "preflight failed");
		assert.equal(preflight.schemaVersion, 1);

		const result = await runSfhFlow({ binary: "sfh", flowFile: flow, cwd, wallClockSec: 30 });
		assert.equal(result.exitCode, 0, result.stderr);
		assert.equal(result.schemaVersion, 1);
		assert.ok(result.runId);
		assert.ok(result.runDir);
		assert.match(result.stdout, /^sfh \d+\./);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
