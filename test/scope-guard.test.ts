/**
 * The write gate a scoped Worker actually passes through.
 *
 * Enforcement is here — at the tool call, before anything is written — not in the
 * post-hoc filesystem sweep, which can only notice afterwards.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { denyWorkerBashToolCall, installScopeGuard } from "../src/scope-guard.ts";

type ToolCallHandler = (event: { toolName: string; input: unknown }) => Promise<
	{ block: true; reason: string } | undefined
>;

/** Minimal extension host: captures the tool_call handler the guard installs. */
function hostWith(env: { cwd: string; allowed?: string[]; forbidden?: string[] }): ToolCallHandler {
	const previous = {
		cwd: process.env.PI_META_LOOP_CWD,
		allowed: process.env.PI_META_LOOP_ALLOWED_SCOPE,
		forbidden: process.env.PI_META_LOOP_FORBIDDEN,
	};
	process.env.PI_META_LOOP_CWD = env.cwd;
	process.env.PI_META_LOOP_ALLOWED_SCOPE = JSON.stringify(env.allowed ?? []);
	process.env.PI_META_LOOP_FORBIDDEN = JSON.stringify(env.forbidden ?? []);
	let handler: ToolCallHandler | undefined;
	installScopeGuard({
		on: (name: string, fn: ToolCallHandler) => {
			if (name === "tool_call") handler = fn;
		},
	} as never);
	process.env.PI_META_LOOP_CWD = previous.cwd;
	process.env.PI_META_LOOP_ALLOWED_SCOPE = previous.allowed;
	process.env.PI_META_LOOP_FORBIDDEN = previous.forbidden;
	if (!handler) throw new Error("the guard did not register a tool_call handler");
	return handler;
}

function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	return dir;
}

describe("scoped worker write gate", () => {
	it("refuses bash unconditionally, whatever the command is", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: ["src/**"] });
		for (const command of ["npm test", "ls", "echo hi", "cat src/a.ts"]) {
			const r = await guard({ toolName: "bash", input: { command } });
			// Per-command denylists do not converge; there is no command worth inspecting.
			assert.equal(r?.block, true, `bash should be refused: ${command}`);
			assert.match(r!.reason, /bash is not available/);
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("points at the replacements rather than just saying no", () => {
		const r = denyWorkerBashToolCall();
		assert.match(r.reason, /trusted verify/);
		assert.match(r.reason, /write\/edit inside allowed_scope/);
	});

	it("allows a write inside the ticket's scope", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: ["src/**"] });
		assert.equal(await guard({ toolName: "write", input: { path: path.join(cwd, "src/a.ts") } }), undefined);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("blocks a write outside it", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: ["src/**"] });
		const r = await guard({ toolName: "edit", input: { path: path.join(cwd, "docs/a.md") } });
		assert.equal(r?.block, true);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("blocks every write when the ticket declared no scope", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: [] });
		const r = await guard({ toolName: "write", input: { path: path.join(cwd, "src/a.ts") } });
		assert.equal(r?.block, true);
		assert.match(r!.reason, /empty allowed_scope/);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("blocks a mutating call with no path at all", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: ["src/**"] });
		const r = await guard({ toolName: "write", input: {} });
		assert.equal(r?.block, true);
		assert.match(r!.reason, /path missing/);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("honours forbidden paths inside an allowed scope", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: ["src/**"], forbidden: ["src/secret.ts"] });
		const r = await guard({ toolName: "write", input: { path: path.join(cwd, "src/secret.ts") } });
		assert.equal(r?.block, true);
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("leaves read-only tools alone", async () => {
		const cwd = tmpRepo();
		const guard = hostWith({ cwd, allowed: ["src/**"] });
		for (const toolName of ["read", "grep", "find", "ls"]) {
			assert.equal(await guard({ toolName, input: { path: "/etc/passwd" } }), undefined);
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("a symlink inside the scope cannot redirect a write outside it", async () => {
		const cwd = tmpRepo();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "guard-out-"));
		const link = path.join(cwd, "src", "link");
		try {
			fs.symlinkSync(outside, link, "junction");
		} catch {
			fs.rmSync(cwd, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
			return; // no symlink privilege on this machine
		}
		const guard = hostWith({ cwd, allowed: ["src/**"] });
		const r = await guard({ toolName: "write", input: { path: path.join(link, "pwned.txt") } });
		assert.equal(r?.block, true, "the guard resolves the link before deciding");
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	});
});
