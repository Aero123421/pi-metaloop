import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-meta-loop-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, npm_config_cache: path.join(cwd, ".npm-cache") };

try {
	execFileSync(npm, ["pack", "--pack-destination", cwd], { env, stdio: "ignore" });
	fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}\n');
	const archive = path.join(cwd, `pi-meta-loop-${pkg.version}.tgz`);
	execFileSync(npm, ["install", archive, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
		cwd,
		env,
		stdio: "ignore",
	});
	const installed = JSON.parse(fs.readFileSync(path.join(cwd, "node_modules", "pi-meta-loop", "package.json"), "utf8"));
	assert.equal(installed.version, pkg.version);
	console.log(`package smoke ok: ${installed.name}@${installed.version}`);
} finally {
	fs.rmSync(cwd, { recursive: true, force: true });
}
