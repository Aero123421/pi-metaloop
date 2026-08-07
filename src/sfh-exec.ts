/**
 * sfh execution backend.
 *
 * Turns a group ticket (execution: "sfh") into a flow.yaml and runs it via
 * the sfh binary. The generated flow carries PI_META_LOOP_DEPTH=1 so any pi
 * launched by sfh can never re-orchestrate.
 *
 * This module stays dependency-light (node built-ins only) so the flow
 * generator can be unit-tested without pi.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Branch, IntegrationContract, Ticket } from "./types.ts";
import { getProcessTreeTerminationSchedule } from "./process-tree-termination.ts";

// Deliberately not importing CONFIG_DIR_NAME here: this module must load
// without the pi package (testability). pi uses ".pi" by default.
const CONFIG_DIR = ".pi";
const KILL_GRACE_MS = 3000;
const POST_FORCE_SETTLE_MS = 2000;
const TREE_POLL_MS = 50;

function isPosixProcessGroupAlive(pid: number | undefined): boolean {
	if (pid == null || pid <= 0) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * sfh preset tools from `sfh --help`:
 * "Preset tools: codex, claude, opencode, grok, agy, pi, cursor."
 * Fixed enum — unknown tools must not reach flow.yaml.
 */
export const SFH_PRESET_TOOLS = [
	"pi",
	"claude",
	"codex",
	"opencode",
	"grok",
	"agy",
	"cursor",
] as const;

export type SfhPresetTool = (typeof SFH_PRESET_TOOLS)[number];

const SFH_TOOL_SET: ReadonlySet<string> = new Set(SFH_PRESET_TOOLS);
const SFH_ACCESS_SET: ReadonlySet<string> = new Set(["read", "write", "full"]);

export interface ExecutorOptions {
	binary: string;
	timeoutSec: number;
	maxParallel: number;
}

export interface SfhRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	runDir?: string;
	costUsd?: number;
	elapsedSec?: number;
}

export function sanitizeId(id: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "task";
}

/** True when tool is an sfh preset (or undefined → default pi). */
export function isSfhPresetTool(tool: string | undefined): boolean {
	const t = (tool ?? "pi").trim();
	return SFH_TOOL_SET.has(t);
}

/**
 * Validate a branch/integrate tool against the fixed sfh preset enum.
 * Returns null if ok, otherwise an error message.
 */
export function validateSfhTool(tool: string | undefined, label = "tool"): string | null {
	const t = (tool ?? "pi").trim();
	if (!t) return `${label}: empty tool is not allowed`;
	if (!SFH_TOOL_SET.has(t)) {
		return `${label}: unknown sfh tool "${t}" (allowed: ${SFH_PRESET_TOOLS.join(", ")})`;
	}
	return null;
}

/** Validate access before emitting it as a bare YAML scalar. */
export function validateSfhAccess(access: string | undefined, label = "access"): string | null {
	const value = access ?? "read";
	if (!SFH_ACCESS_SET.has(value)) {
		return `${label}: invalid sfh access ${JSON.stringify(value)} (allowed: read, write, full)`;
	}
	return null;
}

/** Indent a block-scalar body for YAML `prompt: |`. */
function yamlBlock(text: string, indent: number): string {
	const pad = " ".repeat(indent);
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (line.length > 0 ? pad + line : ""))
		.join("\n");
}

/** JSON-string quote for free YAML scalars (name/model/effort/id). */
function yamlQuoted(value: string): string {
	return JSON.stringify(value);
}

export interface FlowSpec {
	name: string;
	branches: Array<{
		id: string;
		tool?: string;
		model?: string;
		effort?: string;
		access?: string;
		prompt: string;
	}>;
	integrationPrompt: string;
	integrationTool?: string;
	integrationModel?: string;
	integrationEffort?: string;
	integrationAccess?: string;
	defaultModel?: string;
	defaultEffort?: string;
	defaultAccess?: string;
	timeoutSec: number;
	maxParallel: number;
}

/**
 * Generate a deterministic, schema-friendly sfh flow definition.
 * Throws if any branch/integrate tool is outside the fixed sfh preset enum
 * (flow is not generated).
 */
export function generateFlowYaml(spec: FlowSpec): string {
	for (const branch of spec.branches) {
		const toolError = validateSfhTool(branch.tool, `branch ${branch.id}`);
		if (toolError) throw new Error(toolError);
		const accessError = validateSfhAccess(branch.access, `branch ${branch.id} access`);
		if (accessError) throw new Error(accessError);
	}
	{
		const toolError = validateSfhTool(spec.integrationTool, "integrate");
		if (toolError) throw new Error(toolError);
		const accessError = validateSfhAccess(spec.integrationAccess, "integrate access");
		if (accessError) throw new Error(accessError);
		if (spec.defaultAccess !== undefined) {
			const defaultAccessError = validateSfhAccess(spec.defaultAccess, "defaults access");
			if (defaultAccessError) throw new Error(defaultAccessError);
		}
	}
	if (!Number.isFinite(spec.timeoutSec) || spec.timeoutSec <= 0) {
		throw new Error("timeoutSec must be a positive finite number");
	}
	if (!Number.isFinite(spec.maxParallel) || spec.maxParallel <= 0) {
		throw new Error("maxParallel must be a positive finite number");
	}

	const lines: string[] = [];
	lines.push(`api_version: 1`);
	// Free scalars must be JSON-quoted (hostile newlines / ": " / injection).
	lines.push(`name: ${yamlQuoted(spec.name)}`);
	lines.push(`defaults:`);
	lines.push(`  timeout_sec: ${spec.timeoutSec}`);
	lines.push(`  max_parallel: ${Math.max(1, spec.maxParallel)}`);
	if (spec.defaultModel) lines.push(`  model: ${yamlQuoted(spec.defaultModel)}`);
	if (spec.defaultEffort) lines.push(`  effort: ${yamlQuoted(spec.defaultEffort)}`);
	// access/tool stay bare after enum validation (runtime tests match /access: read/).
	if (spec.defaultAccess) lines.push(`  access: ${spec.defaultAccess}`);
	lines.push(`  env:`);
	lines.push(`    PI_META_LOOP_DEPTH: "1"`);
	lines.push(``);
	lines.push(`steps:`);
	lines.push(`  - id: fanout`);
	lines.push(`    parallel:`);
	for (const branch of spec.branches) {
		const tool = (branch.tool ?? "pi").trim();
		lines.push(`      - id: ${yamlQuoted(branch.id)}`);
		lines.push(`        tool: ${tool}`);
		if (branch.model) lines.push(`        model: ${yamlQuoted(branch.model)}`);
		if (branch.effort) lines.push(`        effort: ${yamlQuoted(branch.effort)}`);
		lines.push(`        access: ${branch.access ?? "read"}`);
		lines.push(`        timeout_sec: ${spec.timeoutSec}`);
		lines.push(`        prompt: |`);
		lines.push(yamlBlock(branch.prompt, 10));
	}
	const integrateTool = (spec.integrationTool ?? "pi").trim();
	lines.push(`  - id: integrate`);
	lines.push(`    tool: ${integrateTool}`);
	if (spec.integrationModel) lines.push(`    model: ${yamlQuoted(spec.integrationModel)}`);
	if (spec.integrationEffort) lines.push(`    effort: ${yamlQuoted(spec.integrationEffort)}`);
	lines.push(`    access: ${spec.integrationAccess ?? "read"}`);
	lines.push(`    timeout_sec: ${spec.timeoutSec}`);
	lines.push(`    prompt: |`);
	lines.push(yamlBlock(spec.integrationPrompt, 6));
	lines.push(``);
	return lines.join("\n");
}

export function renderBranchPrompt(branch: Branch, ticket: Ticket, userGoal: string): string {
	return [
		"あなたは並列グループチケットの1ブランチです。担当範囲だけを実行し、結果を報告してください。",
		"",
		`## あなたの担当`,
		branch.prompt,
		"",
		`## グループの目的`,
		ticket.goal,
		...(ticket.context ? ["", "## 補足コンテキスト", ticket.context] : []),
		"",
		`## ユーザーの要求（原文）`,
		userGoal,
		"",
		"他のブランチの作業は別のエージェントが並行して担当しています。担当外に手を出さないでください。",
	].join("\n");
}

export function renderIntegrationPrompt(ticket: Ticket, userGoal: string): string {
	const acceptance = ticket.integration?.acceptance ?? [];
	return [
		"これは統合ステップです。並列ブランチの出力を受け取り、単一の統合報告にまとめてください。",
		"",
		"## 統合約（acceptance）",
		...(acceptance.length > 0 ? acceptance.map((a) => `- ${a}`) : ["- 全ブランチの出力を網羅する"]),
		...(ticket.integration?.output ? ["", `## 期待する成果物: ${ticket.integration.output}`] : []),
		"",
		"## グループの目的",
		ticket.goal,
		"",
		"## ユーザーの要求（原文）",
		userGoal,
		"",
		"## 各ブランチの出力",
		"{{steps.fanout.outputs}}",
		"",
		"acceptance を満たす統合報告を Markdown で出力してください。重複は排除し、矛盾点は列挙し、各記述に出典ブランチを明記してください。",
	].join("\n");
}

export function detectSfh(binary: string): string | null {
	try {
		const r = spawnSync(binary, ["--version"], { timeout: 10_000 });
		if (r.error || r.status !== 0) return null;
		return binary;
	} catch {
		return null;
	}
}

export function flowDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR, "meta-loop", "flows");
}

export function writeFlowFile(cwd: string, ticketId: string, yaml: string): string {
	const dir = flowDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sanitizeId(ticketId)}.flow.yaml`);
	fs.writeFileSync(file, yaml, "utf-8");
	return file;
}

/** Find the newest run dir whose flow name matches (for cost/status recovery). */
export function findRunDirForFlow(cwd: string, flowName: string): { runDir: string; costUsd?: number; elapsedSec?: number } | null {
	const root = path.join(cwd, ".sfh", "runs");
	try {
		if (!fs.existsSync(root)) return null;
		const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
		let best: { runDir: string; mtime: number; costUsd?: number; elapsedSec?: number } | null = null;
		for (const e of entries) {
			const runDir = path.join(root, e.name);
			try {
				const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
				if (status.flow !== flowName) continue;
				const mtime = fs.statSync(path.join(runDir, "status.json")).mtimeMs;
				if (!best || mtime > best.mtime) {
					best = { runDir, mtime, costUsd: status.cost_usd, elapsedSec: status.elapsed_sec };
				}
			} catch {
				// skip unreadable runs
			}
		}
		if (!best) return null;
		return { runDir: best.runDir, costUsd: best.costUsd, elapsedSec: best.elapsedSec };
	} catch {
		return null;
	}
}

/**
 * Kill an sfh process tree.
 * - win32: `taskkill /pid <pid> /T /F` when force is requested (full tree)
 * - POSIX: signal the process group (`-pid`) when spawned detached
 * Returns true only when the tree/group signal itself succeeded.
 */
export function killSfhProcessTree(
	proc: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean },
	opts: { force?: boolean; platform?: NodeJS.Platform } = {},
): boolean {
	const platform = opts.platform ?? process.platform;
	const force = opts.force === true;
	const pid = proc.pid;
	if (pid == null || pid <= 0) return false;

	if (platform === "win32") {
		// Managed callers force once, synchronously, before the event loop can
		// observe close and make this direct-child PID eligible for reuse.
		try {
			const result = spawnSync(
				"taskkill",
				["/pid", String(pid), "/T", ...(force ? ["/F"] : [])],
				{ stdio: "ignore", windowsHide: true, timeout: 15_000 },
			);
			if (result.error || result.status !== 0) throw result.error ?? new Error(`taskkill exit ${result.status}`);
			return true;
		} catch {
			try {
				proc.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {
				/* direct child is already gone */
			}
			// A direct-child fallback is not confirmation that the tree was killed.
			return false;
		}
	}

	// POSIX: prefer process-group kill (spawned with detached:true → new group leader).
	const sig: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
	try {
		process.kill(-pid, sig);
		return true;
	} catch {
		try {
			proc.kill(sig);
		} catch {
			/* direct child is already gone */
		}
		return false;
	}
}

/** Run an sfh flow in the foreground. stdout carries the integrated result. */
export function runSfhFlow(opts: {
	binary: string;
	flowFile: string;
	flowName: string;
	cwd: string;
	signal?: AbortSignal;
	/** Hard wall clock for the whole sfh process (seconds) */
	wallClockSec?: number;
	onProgress?: (chunk: string) => void;
}): Promise<SfhRunResult> {
	if (opts.signal?.aborted) {
		return Promise.resolve({ exitCode: 1, stdout: "", stderr: "aborted before sfh spawn" });
	}
	return new Promise((resolve) => {
		const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
		const terminationSchedule = getProcessTreeTerminationSchedule(
			process.platform,
			KILL_GRACE_MS,
		);
		const isWin = process.platform === "win32";
		// POSIX: new process group so we can kill(-pid) the whole tree on abort.
		const proc = spawn(opts.binary, ["run", opts.flowFile], {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_META_LOOP_DEPTH: String(depth + 1) },
			detached: !isWin,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let aborted = false;
		let timedOut = false;
		let terminationStarted = false;
		let directChildClosed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let wallTimer: ReturnType<typeof setTimeout> | undefined;
		let postForceTimer: ReturnType<typeof setTimeout> | undefined;

		const clearTimers = () => {
			if (killTimer !== undefined) clearTimeout(killTimer);
			if (wallTimer !== undefined) clearTimeout(wallTimer);
			if (postForceTimer !== undefined) clearTimeout(postForceTimer);
			killTimer = undefined;
			wallTimer = undefined;
			postForceTimer = undefined;
		};
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimers();
			opts.signal?.removeEventListener("abort", onAbort);
			const run = findRunDirForFlow(opts.cwd, opts.flowName);
			resolve({
				exitCode,
				stdout,
				stderr,
				runDir: run?.runDir,
				costUsd: run?.costUsd,
				elapsedSec: run?.elapsedSec,
			});
		};
		const waitAfterForce = (forceSucceeded: boolean) => {
			// Windows taskkill is synchronous and this is now only settlement: close
			// or the bound can finish it, and neither path signals the numeric PID.
			if (isWin) {
				if (directChildClosed && forceSucceeded) {
					finish(1);
					return;
				}
				postForceTimer = setTimeout(() => finish(1), POST_FORCE_SETTLE_MS);
				return;
			}

			const deadline = Date.now() + POST_FORCE_SETTLE_MS;
			const poll = () => {
				if (settled) return;
				if ((directChildClosed && !isPosixProcessGroupAlive(proc.pid)) || Date.now() >= deadline) {
					finish(1);
					return;
				}
				postForceTimer = setTimeout(poll, TREE_POLL_MS);
			};
			poll();
		};
		const startTermination = () => {
			if (terminationStarted) return;
			terminationStarted = true;
			if (wallTimer !== undefined) {
				clearTimeout(wallTimer);
				wallTimer = undefined;
			}

			const [initialStep, delayedStep] = terminationSchedule;
			const initialSucceeded = killSfhProcessTree(proc, { force: initialStep.force });
			if (delayedStep === undefined) {
				// Windows: /T /F ran synchronously in this abort/timeout callback while
				// proc still denotes the owned direct child. Never retain its PID for a
				// delayed second taskkill; only bounded settlement remains.
				waitAfterForce(initialSucceeded);
				return;
			}

			// POSIX only: preserve TERM followed by delayed KILL of the owned group,
			// even if the sfh direct child closes during the grace period.
			killTimer = setTimeout(() => {
				killTimer = undefined;
				const forceSucceeded = isPosixProcessGroupAlive(proc.pid)
					? killSfhProcessTree(proc, { force: delayedStep.force })
					: true;
				waitAfterForce(forceSucceeded);
			}, delayedStep.delayMs);
		};
		const onAbort = () => {
			if (aborted) return;
			aborted = true;
			stderr += "\n[pi-meta-loop] sfh aborted\n";
			startTermination();
		};

		proc.stdout.on("data", (c: Buffer) => {
			stdout += c.toString("utf-8");
			if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
		});
		proc.stderr.on("data", (c: Buffer) => {
			const text = c.toString("utf-8");
			stderr += text;
			if (stderr.length > 500_000) stderr = stderr.slice(-250_000);
			opts.onProgress?.(text.slice(-300));
		});
		opts.signal?.addEventListener("abort", onAbort);
		if (opts.signal?.aborted) onAbort();
		if (opts.wallClockSec && opts.wallClockSec > 0) {
			wallTimer = setTimeout(() => {
				timedOut = true;
				stderr += `\n[pi-meta-loop] sfh wall clock exceeded (${opts.wallClockSec}s)\n`;
				startTermination();
			}, opts.wallClockSec * 1000);
		}
		proc.on("close", (code, signal) => {
			directChildClosed = true;
			// Windows has already completed its only PID-based tree kill. POSIX close
			// must not cancel the delayed signal to the owned process group.
			if (terminationStarted) {
				if (isWin && postForceTimer !== undefined) finish(1);
				return;
			}
			if (code === null && signal) finish(1);
			else finish(code ?? 1);
		});
		proc.on("error", (err) => {
			stderr += `\n${err.message}`;
			if (!terminationStarted) finish(1);
		});
	});
}
