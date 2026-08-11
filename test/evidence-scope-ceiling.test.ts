import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { scopeRulesOutsideCeiling } from "../src/evidence.ts";
import {
	DEFAULT_EVIDENCE_IGNORE_DIRS,
	DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS,
	captureFilesystemSnapshot,
	diffFilesystemSnapshots,
} from "../src/fs-snapshot.ts";
import { validateTicket } from "../src/runtime.ts";
import type { Ticket } from "../src/types.ts";

function ticket(scope: string[]): Ticket {
	return {
		id: "t1",
		goal: "g",
		deliverables: [],
		acceptance: ["a"],
		allowed_scope: scope,
		forbidden: [],
		dependencies: [],
		status: "pending",
	};
}

describe("harness scope ceiling", () => {
	it("no ceiling keeps today's behavior", () => {
		assert.deepEqual(scopeRulesOutsideCeiling(["**"], undefined), []);
		assert.deepEqual(scopeRulesOutsideCeiling(["**"], []), []);
		assert.equal(validateTicket(ticket(["**"])), null);
	});

	it("rejects the broad forms a plan can reach for", () => {
		const ceiling = ["src/**", "test/**"];
		assert.deepEqual(scopeRulesOutsideCeiling(["**"], ceiling), ["**"]);
		// A bare *.ts matches every .ts file anywhere, so it is not inside src/**.
		assert.deepEqual(scopeRulesOutsideCeiling(["*.ts"], ceiling), ["*.ts"]);
		assert.deepEqual(scopeRulesOutsideCeiling([".github/**"], ceiling), [".github/**"]);
		assert.deepEqual(scopeRulesOutsideCeiling([""], ceiling), [""]);
	});

	it("accepts rules contained by the ceiling", () => {
		const ceiling = ["src/**", "test/**"];
		assert.deepEqual(scopeRulesOutsideCeiling(["src/auth", "src/*.ts", "test/x.test.ts"], ceiling), []);
		assert.deepEqual(scopeRulesOutsideCeiling(["./src/auth/", "src"], ceiling), []);
	});

	it("blocks a ticket whose scope escapes the ceiling", () => {
		const error = validateTicket(ticket(["src/a", "infra/**"]), ["src/**"]);
		assert.match(error ?? "", /outside limits\.scopeCeiling/);
		assert.match(error ?? "", /infra/);
		assert.equal(validateTicket(ticket(["src/a"]), ["src/**"]), null);
	});

	it("applies to sfh group tickets that declare a scope", () => {
		const group: Ticket = {
			...ticket(["infra/**"]),
			execution: "sfh",
			branches: [{ id: "b", prompt: "p" }],
			integration: { acceptance: ["covered"] },
		};
		assert.match(validateTicket(group, ["src/**"]) ?? "", /outside limits\.scopeCeiling/);
	});
});

describe("bounded evidence sweep", () => {
	const mkRepo = () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ml-evidence-")));
		const project = path.join(root, "project");
		fs.mkdirSync(path.join(project, "src"), { recursive: true });
		fs.writeFileSync(path.join(project, "src", "a.ts"), "a");
		return { root, project };
	};

	it("does not descend into dependency and cache trees", () => {
		const { root, project } = mkRepo();
		try {
			const modules = path.join(project, "node_modules", "pkg");
			fs.mkdirSync(modules, { recursive: true });
			fs.writeFileSync(path.join(modules, "index.js"), "1");

			const before = captureFilesystemSnapshot(project);
			assert.equal(before.ok, true);
			// A language server or package manager rewriting a dependency tree is not
			// the ticket's doing, and used to surface as a scope violation.
			fs.writeFileSync(path.join(modules, "index.js"), "2");
			fs.writeFileSync(path.join(modules, "extra.js"), "3");
			const after = captureFilesystemSnapshot(project);

			assert.deepEqual(diffFilesystemSnapshots(before, after).changedPaths, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still sees the ignored directory appear and disappear", () => {
		const { root, project } = mkRepo();
		try {
			const before = captureFilesystemSnapshot(project);
			fs.mkdirSync(path.join(project, "node_modules"));
			const after = captureFilesystemSnapshot(project);
			const changed = diffFilesystemSnapshots(before, after).changedPaths;
			assert.equal(
				changed.some((p) => p.endsWith("/node_modules")),
				true,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps watching real source writes", () => {
		const { root, project } = mkRepo();
		try {
			const before = captureFilesystemSnapshot(project);
			fs.writeFileSync(path.join(project, "src", "a.ts"), "changed");
			const after = captureFilesystemSnapshot(project);
			assert.equal(
				diffFilesystemSnapshots(before, after).changedPaths.some((p) => p.endsWith("/src/a.ts")),
				true,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("records parent files but does not recurse into siblings by default", () => {
		const { root, project } = mkRepo();
		try {
			const sibling = path.join(root, "other-project", "deep");
			fs.mkdirSync(sibling, { recursive: true });
			fs.writeFileSync(path.join(sibling, "file.ts"), "1");

			const before = captureFilesystemSnapshot(project);
			// A write in an unrelated neighbouring repository must not fail this ticket.
			fs.writeFileSync(path.join(sibling, "file.ts"), "2");
			// A write directly beside the project still has to be visible.
			fs.writeFileSync(path.join(root, "escaped.txt"), "x");
			const after = captureFilesystemSnapshot(project);

			const changed = diffFilesystemSnapshots(before, after).changedPaths;
			assert.equal(
				changed.some((p) => p.endsWith("/escaped.txt")),
				true,
				"parent-directory writes remain detected",
			);
			assert.equal(
				changed.some((p) => p.includes("other-project")),
				false,
				"sibling project writes are not attributed to this ticket",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("an explicit override can restore deep sibling coverage", () => {
		const { root, project } = mkRepo();
		try {
			const sibling = path.join(root, "other-project");
			fs.mkdirSync(sibling, { recursive: true });
			fs.writeFileSync(path.join(sibling, "file.ts"), "1");

			const opts = { parentMaxDepth: 3 };
			const before = captureFilesystemSnapshot(project, opts);
			fs.writeFileSync(path.join(sibling, "file.ts"), "2");
			const after = captureFilesystemSnapshot(project, opts);

			assert.equal(
				diffFilesystemSnapshots(before, after).changedPaths.some((p) => p.includes("other-project")),
				true,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ships a default ignore list and a non-recursive parent scan", () => {
		assert.equal(DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS.parentMaxDepth, 0);
		assert.equal(DEFAULT_EVIDENCE_IGNORE_DIRS.includes("node_modules"), true);
		assert.deepEqual(
			DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS.ignoreDirNames,
			DEFAULT_EVIDENCE_IGNORE_DIRS,
		);
	});
});
