/**
 * Spawns isolated `pi` subprocesses (JSON mode) for each role, like the
 * official subagent extension. Agent system prompts live in ../agents/*.md.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RoleRunResult, UsageStats } from "./types.ts";
import type { RoleConfig } from "./config.ts";

export type RoleName = "orchestrator" | "supervisor" | "worker";

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
		// Agent prompt missing: run with defaults, identity carried by the task text.
	}
	return {
		name,
		systemPrompt,
		model: roleConfig.model || fmModel,
		tools: roleConfig.tools ?? fmTools,
	};
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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
	// Fallback: assume `pi` is on PATH.
	return { command: "pi", args };
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

export async function runRole(
	role: LoadedRole,
	task: string,
	opts: {
		cwd: string;
		signal?: AbortSignal;
		outputCap?: number;
		onProgress?: (text: string) => void;
		/** extra CLI args (e.g. -e scope-guard.ts) */
		extraArgs?: string[];
		/** extra env vars for the child process */
		extraEnv?: Record<string, string>;
	},
): Promise<RoleRunResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (role.model) args.push("--model", role.model);
	if (role.tools && role.tools.length > 0) args.push("--tools", role.tools.join(","));
	if (opts.extraArgs?.length) args.push(...opts.extraArgs);

	const promptPath = await writePromptToTempFile(role.name, role.systemPrompt);

	const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const messages: Message[] = [];
	let stderr = "";

	const result = await new Promise<RoleRunResult>((resolve) => {
		const invocation = getPiInvocation([...args, "--append-system-prompt", promptPath, `Task: ${task}`]);
		// Nesting guard: subprocess roles (and anything they spawn) must never
		// re-register the orchestration extension.
		const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_META_LOOP_DEPTH: String(depth + 1),
				...(opts.extraEnv ?? {}),
			},
		});

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
				// Ignore non-JSON lines.
			}
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {}
		};
		opts.signal?.addEventListener("abort", onAbort);

		proc.on("close", (code) => {
			opts.signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			let output = getFinalText(messages);
			const cap = opts.outputCap ?? 51200;
			if (output.length > cap) output = output.slice(0, cap) + "\n...[truncated]";
			resolve({ output: output || (stderr ? `[exit ${code}] ${stderr.slice(0, 2000)}` : ""), exitCode: code ?? 0, usage });
		});
	});

	try {
		fs.rmSync(path.dirname(promptPath), { recursive: true, force: true });
	} catch {}

	return result;
}

async function writePromptToTempFile(role: string, systemPrompt: string): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-meta-loop-${role}-`));
	const filePath = path.join(dir, "prompt.md");
	fs.writeFileSync(filePath, systemPrompt, "utf-8");
	return filePath;
}

/** Extract the first fenced ```json block (or the first {...} blob) and parse it. */
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
