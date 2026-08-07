/**
 * Spawns isolated `pi` subprocesses (JSON mode) for each role.
 *
 * Windows CreateProcess command-line limit is ~32KB. Task bodies and long
 * context MUST NOT be placed on argv — they go via stdin (pi -p merges piped
 * stdin into the initial prompt). Role system prompts stay on a temp file
 * via --append-system-prompt <path>.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RoleRunResult, UsageStats } from "./types.ts";
import type { RoleConfig } from "./config.ts";
import { getProcessTreeTerminationSchedule } from "./process-tree-termination.ts";

export type RoleName = "orchestrator" | "supervisor" | "worker";

/** Soft warn threshold; hard fail only if argv still huge after stdin offload. */
export const WINDOWS_CMDLINE_SOFT_LIMIT = 28_000;

/** Grace period after soft kill before force tree-kill (ms). */
const KILL_GRACE_MS = 3000;
/** Bound for observing direct-child close + POSIX process-group death after force. */
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

export interface LoadedRole {
	name: RoleName;
	systemPrompt: string;
	model?: string;
	tools?: string[];
}

function agentsDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "agents");
}

export function loadRole(name: RoleName, roleConfig: RoleConfig): LoadedRole {
	const filePath = path.join(agentsDir(), `${name}.md`);
	let systemPrompt = "";
	let fmModel: string | undefined;
	let fmTools: string[] | undefined;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(raw);
		systemPrompt = body;
		fmModel = frontmatter.model;
		fmTools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	} catch {
		/* missing agent file */
	}
	return {
		name,
		systemPrompt,
		model: roleConfig.model || fmModel,
		// Config tools win; never silently expand beyond config when set
		tools: roleConfig.tools ?? fmTools,
	};
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** Rough byte length of a Windows-style quoted command line (conservative). */
export function estimateCommandLineLength(command: string, args: string[]): number {
	const quote = (s: string) => {
		if (!/[ \t"]/u.test(s)) return s;
		return `"${s.replace(/"/g, '\\"')}"`;
	};
	return [command, ...args].map(quote).join(" ").length;
}

function getFinalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

async function writePromptToTempFile(role: string, systemPrompt: string): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-meta-loop-${role}-`));
	const filePath = path.join(dir, "prompt.md");
	fs.writeFileSync(filePath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {
		/* windows */
	}
	return filePath;
}

/**
 * Build argv for a role run. Task body is NEVER included — caller pipes it on stdin.
 * Exported for unit tests (ENAMETOOLONG guard).
 */
export function buildRoleArgv(
	role: LoadedRole,
	promptPath: string,
	extraArgs?: string[],
): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (role.model) args.push("--model", role.model);
	// undefined inherits pi's defaults; [] must stay an explicit deny-all.
	if (role.tools !== undefined) {
		if (role.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", role.tools.join(","));
	}
	if (extraArgs?.length) args.push(...extraArgs);
	// File path only (short). Do not inline system prompt text.
	args.push("--append-system-prompt", promptPath);
	// Tiny argv anchor so -p always has a message token; full task is on stdin.
	args.push(`Role:${role.name}`);
	return args;
}

/**
 * Kill a role process tree.
 * - win32: `taskkill /pid <pid> /T /F` when force is requested (full tree)
 * - POSIX: signal the process group (`-pid`) when spawned detached
 * Returns true only when the tree/group signal itself succeeded.
 */
export function killRoleProcessTree(
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

export interface ManagedSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

/**
 * Spawn a child with abort + wall-clock timeout + process-tree kill.
 * Used by runRole; exported for unit tests with lightweight children (e.g. node -e).
 */
export function spawnManagedProcess(opts: {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
	signal?: AbortSignal;
	/** Wall-clock timeout in seconds. Exceeded → tree kill, exitCode 1. */
	timeoutSec?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}): Promise<ManagedSpawnResult> {
	return new Promise((resolve) => {
		// Pre-aborted: do not spawn.
		if (opts.signal?.aborted) {
			resolve({
				exitCode: 1,
				stdout: "",
				stderr: "aborted",
				timedOut: false,
				aborted: true,
			});
			return;
		}

		const terminationSchedule = getProcessTreeTerminationSchedule(
			process.platform,
			KILL_GRACE_MS,
		);
		const isWin = process.platform === "win32";
		const proc = spawn(opts.command, opts.args ?? [], {
			cwd: opts.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: opts.env ?? process.env,
			// POSIX: new process group so kill(-pid) covers the whole tree.
			detached: !isWin,
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let wallTimer: ReturnType<typeof setTimeout> | undefined;
		let postForceTimer: ReturnType<typeof setTimeout> | undefined;
		let terminationStarted = false;
		let directChildClosed = false;

		const clearTimers = () => {
			if (killTimer !== undefined) {
				clearTimeout(killTimer);
				killTimer = undefined;
			}
			if (wallTimer !== undefined) {
				clearTimeout(wallTimer);
				wallTimer = undefined;
			}
			if (postForceTimer !== undefined) {
				clearTimeout(postForceTimer);
				postForceTimer = undefined;
			}
		};

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimers();
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode, stdout, stderr, timedOut, aborted });
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
				// Verify that the exact detached POSIX group we own has disappeared.
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
			const initialSucceeded = killRoleProcessTree(proc, { force: initialStep.force });
			if (delayedStep === undefined) {
				// Windows: /T /F ran synchronously in this abort/timeout callback while
				// proc still denotes the owned direct child. Never retain its PID for a
				// delayed second taskkill; only bounded settlement remains.
				waitAfterForce(initialSucceeded);
				return;
			}

			// POSIX only: a TERM-cooperative direct child can close while a
			// TERM-resistant descendant remains in the owned detached group.
			killTimer = setTimeout(() => {
				killTimer = undefined;
				// Do not signal a numeric POSIX group that is already gone. A surviving
				// descendant keeps the owned group observable and receives SIGKILL.
				const forceSucceeded = isPosixProcessGroupAlive(proc.pid)
					? killRoleProcessTree(proc, { force: delayedStep.force })
					: true;
				waitAfterForce(forceSucceeded);
			}, delayedStep.delayMs);
		};

		const onAbort = () => {
			if (aborted) return;
			aborted = true;
			stderr += "\n[spawn] aborted\n";
			startTermination();
		};
		// Register immediately after spawn, then re-check to close the race between
		// the pre-spawn aborted check and listener installation.
		opts.signal?.addEventListener("abort", onAbort);
		if (opts.signal?.aborted) onAbort();

		proc.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			stdout += text;
			if (stdout.length > 5_000_000) stdout = stdout.slice(-2_000_000);
			opts.onStdout?.(text);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			stderr += text;
			if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
			opts.onStderr?.(text);
		});

		proc.stdin?.on("error", (err) => {
			stderr += `\nstdin: ${err.message}`;
		});
		if (opts.stdin != null) {
			try {
				proc.stdin?.write(opts.stdin, "utf-8");
				proc.stdin?.end();
			} catch (err) {
				stderr += `\nstdin write failed: ${err instanceof Error ? err.message : String(err)}`;
				startTermination();
			}
		} else {
			try {
				proc.stdin?.end();
			} catch {
				/* */
			}
		}

		if (opts.timeoutSec != null && opts.timeoutSec > 0) {
			wallTimer = setTimeout(() => {
				timedOut = true;
				stderr += `\n[spawn] timeout after ${opts.timeoutSec}s\n`;
				startTermination();
			}, opts.timeoutSec * 1000);
		}

		proc.on("error", (err) => {
			stderr += `\n${err.message}`;
			// During cancellation, the forced tree pass owns settlement. A spawn
			// error without cancellation has no process tree and can finish fast.
			if (!terminationStarted) finish(1);
		});
		proc.on("close", (code, signal) => {
			directChildClosed = true;
			// Windows already performed its only forced taskkill synchronously; close
			// may settle without any further PID-based action. POSIX must preserve its
			// delayed owned-group escalation.
			if (terminationStarted) {
				if (isWin && postForceTimer !== undefined) finish(1);
				return;
			}
			if (code === null && signal) finish(1);
			else finish(code ?? 1);
		});
	});
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export async function runRole(
	role: LoadedRole,
	task: string,
	opts: {
		cwd: string;
		signal?: AbortSignal;
		/** Wall-clock timeout in seconds. Exceeded → tree kill + exitCode 1. */
		timeoutSec?: number;
		outputCap?: number;
		onProgress?: (text: string) => void;
		extraArgs?: string[];
		extraEnv?: Record<string, string>;
	},
): Promise<RoleRunResult> {
	// Pre-aborted signal: resolve immediately without spawning or temp files.
	if (opts.signal?.aborted) {
		return {
			output: "aborted",
			exitCode: 1,
			usage: emptyUsage(),
		};
	}

	const promptPath = await writePromptToTempFile(role.name, role.systemPrompt);
	const usage: UsageStats = emptyUsage();
	const messages: Message[] = [];
	const STDERR_CAP = 200_000;

	// Cap absurd tasks for model context, not for argv (stdin carries this).
	const taskBody =
		task.length > 400_000 ? task.slice(0, 400_000) + "\n...[task truncated]" : task;
	const stdinPayload = `Task:\n${taskBody}\n`;

	try {
		const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
		const childEnv = {
			...process.env,
			...(opts.extraEnv ?? {}),
			PI_META_LOOP_DEPTH: String(depth + 1),
		};
		const argv = buildRoleArgv(role, promptPath, opts.extraArgs);
		const invocation = getPiInvocation(argv);

		const cmdLen = estimateCommandLineLength(invocation.command, invocation.args);
		if (cmdLen > WINDOWS_CMDLINE_SOFT_LIMIT) {
			return {
				output: `[spawn] command line too long (${cmdLen} chars). Refusing to start (ENAMETOOLONG guard).`,
				exitCode: 1,
				usage,
			};
		}

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					messages.push(msg);
					if (msg.role === "assistant") {
						usage.turns++;
						const u: any = (msg as any).usage;
						if (u) {
							usage.input += u.input ?? 0;
							usage.output += u.output ?? 0;
							usage.cacheRead += u.cacheRead ?? 0;
							usage.cacheWrite += u.cacheWrite ?? 0;
							usage.cost += u.cost?.total ?? u.cost ?? 0;
						}
						opts.onProgress?.(getFinalText(messages).slice(-400));
					}
				}
			} catch {
				/* ignore non-JSON */
			}
		};

		const managed = await spawnManagedProcess({
			command: invocation.command,
			args: invocation.args,
			cwd: opts.cwd,
			env: childEnv,
			stdin: stdinPayload,
			signal: opts.signal,
			timeoutSec: opts.timeoutSec,
			onStdout: (chunk) => {
				buffer += chunk;
				if (buffer.length > 5_000_000) buffer = buffer.slice(-2_000_000);
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			},
		});

		if (buffer.trim()) processLine(buffer);

		let output = getFinalText(messages);
		const cap = opts.outputCap ?? 51200;
		if (output.length > cap) output = output.slice(0, cap) + "\n...[truncated]";

		const code = managed.exitCode;
		let stderr = managed.stderr;
		if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);

		if (managed.aborted && !output) {
			return { output: "aborted", exitCode: 1, usage };
		}
		if (managed.timedOut && !output) {
			return {
				output: `[exit ${code}] ${stderr.slice(0, 2000) || `timeout after ${opts.timeoutSec}s`}`,
				exitCode: 1,
				usage,
			};
		}

		return {
			output: output || (stderr ? `[exit ${code}] ${stderr.slice(0, 2000)}` : ""),
			exitCode: code,
			usage,
		};
	} finally {
		try {
			fs.rmSync(path.dirname(promptPath), { recursive: true, force: true });
		} catch {
			/* */
		}
	}
}

export function extractJson<T = unknown>(text: string): T | null {
	const fence = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/);
	let candidate = fence?.[1];
	if (!candidate) {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) candidate = text.slice(start, end + 1);
	}
	if (!candidate) return null;
	try {
		return JSON.parse(candidate) as T;
	} catch {
		return null;
	}
}
