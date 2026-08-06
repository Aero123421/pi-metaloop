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

// Deliberately not importing CONFIG_DIR_NAME here: this module must load
// without the pi package (testability). pi uses ".pi" by default.
const CONFIG_DIR = ".pi";

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

/** Indent a block-scalar body for YAML `prompt: |`. */
function yamlBlock(text: string, indent: number): string {
	const pad = " ".repeat(indent);
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (line.length > 0 ? pad + line : ""))
		.join("\n");
}

export interface FlowSpec {
	name: string;
	branches: Array<{ id: string; tool?: string; model?: string; access?: string; prompt: string }>;
	integrationPrompt: string;
	integrationTool?: string;
	integrationModel?: string;
	defaultModel?: string;
	timeoutSec: number;
	maxParallel: number;
}

/** Generate a deterministic, schema-friendly sfh flow definition. */
export function generateFlowYaml(spec: FlowSpec): string {
	const lines: string[] = [];
	lines.push(`api_version: 1`);
	lines.push(`name: ${spec.name}`);
	lines.push(`defaults:`);
	lines.push(`  timeout_sec: ${spec.timeoutSec}`);
	lines.push(`  max_parallel: ${Math.max(1, spec.maxParallel)}`);
	if (spec.defaultModel) lines.push(`  model: ${JSON.stringify(spec.defaultModel)}`);
	lines.push(`  env:`);
	lines.push(`    PI_META_LOOP_DEPTH: "1"`);
	lines.push(``);
	lines.push(`steps:`);
	lines.push(`  - id: fanout`);
	lines.push(`    parallel:`);
	for (const branch of spec.branches) {
		lines.push(`      - id: ${branch.id}`);
		lines.push(`        tool: ${branch.tool ?? "pi"}`);
		if (branch.model) lines.push(`        model: ${JSON.stringify(branch.model)}`);
		lines.push(`        access: ${branch.access ?? "read"}`);
		lines.push(`        timeout_sec: ${spec.timeoutSec}`);
		lines.push(`        prompt: |`);
		lines.push(yamlBlock(branch.prompt, 10));
	}
	lines.push(`  - id: integrate`);
	lines.push(`    tool: ${spec.integrationTool ?? "pi"}`);
	if (spec.integrationModel) lines.push(`    model: ${JSON.stringify(spec.integrationModel)}`);
	lines.push(`    access: read`);
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
		"これは統合せきです。並列ブランチの出力を受け取り、単一の統合報告にまとめてください。",
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

/** Run an sfh flow in the foreground. stdout carries the integrated result. */
export function runSfhFlow(opts: {
	binary: string;
	flowFile: string;
	flowName: string;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (chunk: string) => void;
}): Promise<SfhRunResult> {
	return new Promise((resolve) => {
		const depth = Number.parseInt(process.env.PI_META_LOOP_DEPTH ?? "0", 10) || 0;
		const proc = spawn(opts.binary, ["run", opts.flowFile], {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_META_LOOP_DEPTH: String(depth + 1) },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (c: Buffer) => {
			stdout += c.toString("utf-8");
		});
		proc.stderr.on("data", (c: Buffer) => {
			const text = c.toString("utf-8");
			stderr += text;
			opts.onProgress?.(text.slice(-300));
		});
		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// already gone
			}
		};
		opts.signal?.addEventListener("abort", onAbort);
		proc.on("close", (code) => {
			opts.signal?.removeEventListener("abort", onAbort);
			const run = findRunDirForFlow(opts.cwd, opts.flowName);
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				runDir: run?.runDir,
				costUsd: run?.costUsd,
				elapsedSec: run?.elapsedSec,
			});
		});
		proc.on("error", (err) => {
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
		});
	});
}
