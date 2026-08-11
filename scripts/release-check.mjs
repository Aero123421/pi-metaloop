import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

assert.equal(lock.version, pkg.version, "package-lock version differs from package.json");
assert.equal(lock.packages?.[""]?.version, pkg.version, "package-lock root version differs from package.json");
assert.match(fs.readFileSync("CHANGELOG.md", "utf8"), new RegExp(`^## \\[${pkg.version.replaceAll(".", "\\.")}\\]`, "m"));

for (const file of [
	"config/meta-loop.json",
	"skills/meta-loop-setup/assets/user-config.template.json",
	"skills/meta-loop-setup/assets/project-config.template.json",
	"examples/user-meta-loop.config.example.json",
	"examples/project-meta-loop.config.example.json",
]) JSON.parse(fs.readFileSync(file, "utf8"));

const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v")) assert.equal(tag, `v${pkg.version}`, "release tag differs from package version");

console.log(`release contract ok: ${pkg.version}`);
