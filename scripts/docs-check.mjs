/**
 * The Japanese README is the one most of this project's readers open, and it had
 * drifted into describing a *weaker* security posture than the English one while
 * making a *stronger* guarantee about the nesting guard. Nothing caught it.
 *
 * This does not compare prose — translations should read naturally. It checks
 * that both files still cover the same top-level sections, and that a few claims
 * whose wording matters for safety are present in each.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const en = fs.readFileSync("README.md", "utf8");
const ja = fs.readFileSync("README.ja.md", "utf8");

const sectionCount = (text) => text.split("\n").filter((l) => l.startsWith("## ")).length;
assert.equal(
	sectionCount(en),
	sectionCount(ja),
	`README.md has ${sectionCount(en)} top-level sections, README.ja.md has ${sectionCount(ja)}`,
);

/** Claims that must appear in both, so neither can quietly promise more than the code delivers. */
const required = [
	{ label: "verify payload warning", en: /repository's own code/i, ja: /リポジトリ自身のコード/ },
	{ label: "scope ceiling", en: /scopeCeiling/, ja: /scopeCeiling/ },
	{ label: "project cannot choose models", en: /allowProjectModelOverride/, ja: /allowProjectModelOverride/ },
	{ label: "sfh read-only without sandbox", en: /read-only review/i, ja: /read-only review/i },
	{ label: "nesting guard is not a hostile boundary", en: /not\*{0,2} a \*{0,2}hostile/i, ja: /敵対的なセキュリティ境界ではない/ },
	{ label: "sfh is optional", en: /SimpleFlowHarness\).* — optional\*\*/, ja: /SimpleFlowHarness\).* — 任意\*\*/ },
	{ label: "first-run verify guidance", en: /no trusted verify configured/i, ja: /trusted verify が未設定/ },
];

const problems = [];
for (const claim of required) {
	if (!claim.en.test(en)) problems.push(`README.md is missing: ${claim.label}`);
	if (!claim.ja.test(ja)) problems.push(`README.ja.md is missing: ${claim.label}`);
}
assert.deepEqual(problems, [], `README parity:\n  ${problems.join("\n  ")}`);

console.log(`docs parity ok: ${sectionCount(en)} sections, ${required.length} shared claims`);
