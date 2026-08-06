/**
 * Configuration loader with capability-monotonic project overrides.
 *
 * Layers: default → repo → user → project(folder) → legacy project
 * Project layer may only NARROW dangerous capabilities, never expand them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EscalationSettings } from "./escalation.ts";
import { defaultEscalation } from "./escalation.ts";

export interface RoleConfig {
	model?: string;
	tools?: string[];
}

export interface SupervisorSettings {
	auto: boolean;
	checkIntervalMinutes: number;
	workerStartThreshold: number;
	maxConsecutiveFailures: number;
}

export interface ExecutorSettings {
	sfhEnabled: boolean;
	sfhBinary: string;
	timeoutSec: number;
	maxParallel: number;
	sfhModel?: string;
	sfhIntegrateModel?: string;
	sfhToolModels?: Record<string, string>;
	sfhEffort?: string;
	sfhToolEfforts?: Record<string, string>;
	sfhIntegrateEffort?: string;
	sfhAccess?: string;
	sfhToolAccess?: Record<string, string>;
	sfhIntegrateAccess?: string;
	sfhAllowedTools?: string[];
}

export interface MetaLoopConfig {
	enabled: boolean;
	roles: {
		orchestrator: RoleConfig;
		supervisor: RoleConfig;
		worker: RoleConfig;
	};
	supervisor: SupervisorSettings;
	executor: ExecutorSettings;
	escalation: EscalationSettings;
	limits: {
		maxTasks: number;
		concurrency: number;
		perTaskOutputCap: number;
	};
}

const READ_TOOLS = ["read", "ls", "find", "grep"];
const WORKER_TOOLS = ["read", "write", "edit", "ls", "find", "grep"];

const defaultConfig: MetaLoopConfig = {
	enabled: true,
	roles: {
		orchestrator: { model: "", tools: [...READ_TOOLS] },
		supervisor: { model: "", tools: [...READ_TOOLS] },
		worker: { model: "", tools: [...WORKER_TOOLS] },
	},
	supervisor: {
		auto: true,
		checkIntervalMinutes: 30,
		workerStartThreshold: 6,
		maxConsecutiveFailures: 2,
	},
	executor: {
		sfhEnabled: true,
		sfhBinary: "sfh",
		timeoutSec: 1800,
		maxParallel: 4,
		sfhModel: "",
		sfhIntegrateModel: "",
		sfhToolModels: {},
		sfhEffort: "",
		sfhToolEfforts: {},
		sfhIntegrateEffort: "",
		sfhAccess: "read",
		sfhToolAccess: {},
		sfhIntegrateAccess: "read",
		sfhAllowedTools: [],
	},
	escalation: { ...defaultEscalation },
	limits: {
		maxTasks: 8,
		concurrency: 1,
		perTaskOutputCap: 51200,
	},
};

const ACCESS_RANK: Record<string, number> = { read: 0, write: 1, full: 2 };

function repoRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readJsonIfExists(p: string): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(p)) return null;
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch (err) {
		console.error(`[pi-meta-loop] failed to read config ${p}:`, err);
		return null;
	}
}

function intersectTools(ceiling: string[] | undefined, request: string[] | undefined): string[] | undefined {
	if (!request) return ceiling;
	if (!ceiling || ceiling.length === 0) return request;
	const set = new Set(ceiling);
	return request.filter((t) => set.has(t));
}

function minAccess(a?: string, b?: string): string {
	const ra = ACCESS_RANK[(a ?? "read").toLowerCase()] ?? 0;
	const rb = ACCESS_RANK[(b ?? "read").toLowerCase()] ?? 0;
	const m = Math.min(ra, rb);
	return m <= 0 ? "read" : m === 1 ? "write" : "full";
}

function intersectAllowList(ceiling: string[] | undefined, request: string[] | undefined): string[] {
	// empty ceiling = unrestricted; empty request = no change when applying project
	if (request === undefined) return ceiling ?? [];
	if (request.length === 0) {
		// empty request means "unrestricted" intent — do not expand past ceiling
		return ceiling && ceiling.length > 0 ? ceiling : [];
	}
	if (!ceiling || ceiling.length === 0) return request;
	const set = new Set(ceiling);
	return request.filter((t) => set.has(t));
}

type LayerKind = "base" | "project";

function applyLayer(merged: MetaLoopConfig, layer: Record<string, unknown> | null, kind: LayerKind): void {
	if (!layer) return;
	if (typeof layer.enabled === "boolean") {
		// project may only disable, not re-enable if user disabled — actually user might enable; project disable ok
		if (kind === "project") merged.enabled = merged.enabled && layer.enabled;
		else merged.enabled = layer.enabled;
	}
	if (layer.roles && typeof layer.roles === "object") {
		for (const role of ["orchestrator", "supervisor", "worker"] as const) {
			const r = (layer.roles as any)[role];
			if (!r || typeof r !== "object") continue;
			const cur = merged.roles[role];
			if (kind === "project") {
				merged.roles[role] = {
					model: typeof r.model === "string" ? r.model : cur.model,
					tools: intersectTools(cur.tools, Array.isArray(r.tools) ? r.tools.map(String) : undefined) ?? cur.tools,
				};
			} else {
				merged.roles[role] = {
					...cur,
					...r,
					tools: Array.isArray(r.tools) ? r.tools.map(String) : cur.tools,
				};
			}
		}
	}
	if (layer.limits && typeof layer.limits === "object") {
		const L = layer.limits as any;
		merged.limits = {
			maxTasks: clampInt(L.maxTasks ?? merged.limits.maxTasks, 1, 64),
			concurrency: clampInt(L.concurrency ?? merged.limits.concurrency, 1, 8),
			perTaskOutputCap: clampInt(L.perTaskOutputCap ?? merged.limits.perTaskOutputCap, 1000, 5_000_000),
		};
	}
	if (layer.supervisor && typeof layer.supervisor === "object") {
		merged.supervisor = { ...merged.supervisor, ...(layer.supervisor as object) };
	}
	if (layer.escalation && typeof layer.escalation === "object") {
		merged.escalation = { ...merged.escalation, ...(layer.escalation as object) };
	}
	if (layer.executor && typeof layer.executor === "object") {
		const ex = layer.executor as any;
		const cur = merged.executor;
		if (kind === "project") {
			// project cannot change binary or expand access/tools
			merged.executor = {
				...cur,
				sfhEnabled: ex.sfhEnabled === false ? false : cur.sfhEnabled,
				timeoutSec: clampInt(ex.timeoutSec ?? cur.timeoutSec, 30, 86_400),
				maxParallel: clampInt(ex.maxParallel ?? cur.maxParallel, 1, 16),
				sfhModel: typeof ex.sfhModel === "string" ? ex.sfhModel : cur.sfhModel,
				sfhIntegrateModel: typeof ex.sfhIntegrateModel === "string" ? ex.sfhIntegrateModel : cur.sfhIntegrateModel,
				sfhEffort: typeof ex.sfhEffort === "string" ? ex.sfhEffort : cur.sfhEffort,
				sfhIntegrateEffort: typeof ex.sfhIntegrateEffort === "string" ? ex.sfhIntegrateEffort : cur.sfhIntegrateEffort,
				sfhAccess: minAccess(cur.sfhAccess, ex.sfhAccess),
				sfhIntegrateAccess: minAccess(cur.sfhIntegrateAccess ?? "read", ex.sfhIntegrateAccess ?? "read"),
				sfhAllowedTools: intersectAllowList(cur.sfhAllowedTools, Array.isArray(ex.sfhAllowedTools) ? ex.sfhAllowedTools.map(String) : undefined),
				sfhToolModels: { ...(cur.sfhToolModels ?? {}), ...(ex.sfhToolModels && typeof ex.sfhToolModels === "object" ? ex.sfhToolModels : {}) },
				sfhToolEfforts: { ...(cur.sfhToolEfforts ?? {}), ...(ex.sfhToolEfforts && typeof ex.sfhToolEfforts === "object" ? ex.sfhToolEfforts : {}) },
				sfhToolAccess: mergeAccessMap(cur.sfhToolAccess, ex.sfhToolAccess),
				// sfhBinary intentionally not overridable by project
				sfhBinary: cur.sfhBinary,
			};
		} else {
			merged.executor = {
				...cur,
				...ex,
				sfhToolModels: { ...(cur.sfhToolModels ?? {}), ...(ex.sfhToolModels && typeof ex.sfhToolModels === "object" ? ex.sfhToolModels : {}) },
				sfhToolEfforts: { ...(cur.sfhToolEfforts ?? {}), ...(ex.sfhToolEfforts && typeof ex.sfhToolEfforts === "object" ? ex.sfhToolEfforts : {}) },
				sfhToolAccess: { ...(cur.sfhToolAccess ?? {}), ...(ex.sfhToolAccess && typeof ex.sfhToolAccess === "object" ? ex.sfhToolAccess : {}) },
				sfhAllowedTools: Array.isArray(ex.sfhAllowedTools) ? ex.sfhAllowedTools.map(String) : cur.sfhAllowedTools,
			};
		}
	}
}

function mergeAccessMap(ceiling?: Record<string, string>, request?: Record<string, string>): Record<string, string> {
	const out = { ...(ceiling ?? {}) };
	if (!request || typeof request !== "object") return out;
	for (const [k, v] of Object.entries(request)) {
		out[k] = minAccess(out[k] ?? "full", v);
	}
	return out;
}

function clampInt(n: unknown, min: number, max: number): number {
	const v = typeof n === "number" ? n : Number(n);
	if (!Number.isFinite(v)) return min;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

function cloneDefault(): MetaLoopConfig {
	return {
		enabled: defaultConfig.enabled,
		roles: {
			orchestrator: { ...defaultConfig.roles.orchestrator, tools: [...(defaultConfig.roles.orchestrator.tools ?? [])] },
			supervisor: { ...defaultConfig.roles.supervisor, tools: [...(defaultConfig.roles.supervisor.tools ?? [])] },
			worker: { ...defaultConfig.roles.worker, tools: [...(defaultConfig.roles.worker.tools ?? [])] },
		},
		supervisor: { ...defaultConfig.supervisor },
		executor: {
			...defaultConfig.executor,
			sfhToolModels: {},
			sfhToolEfforts: {},
			sfhToolAccess: {},
			sfhAllowedTools: [],
		},
		escalation: { ...defaultConfig.escalation },
		limits: { ...defaultConfig.limits },
	};
}

export function loadConfig(cwd: string): MetaLoopConfig {
	const userDir = path.join(getAgentDir(), "meta-loop");
	const projectDir = path.join(cwd, CONFIG_DIR_NAME, "meta-loop");
	const merged = cloneDefault();

	// base layers (may expand from defaults)
	applyLayer(merged, readJsonIfExists(path.join(repoRoot(), "config", "meta-loop.json")), "base");
	applyLayer(merged, readJsonIfExists(path.join(userDir, "config.json")), "base");
	// legacy project first, then folder form (folder wins)
	const legacy = readJsonIfExists(path.join(cwd, CONFIG_DIR_NAME, "meta-loop.json"));
	const folder = readJsonIfExists(path.join(projectDir, "config.json"));
	if (legacy && folder) {
		console.error("[pi-meta-loop] both .pi/meta-loop.json and .pi/meta-loop/config.json exist; folder form wins");
	}
	applyLayer(merged, legacy, "project");
	applyLayer(merged, folder, "project");

	// Force sfh integrate default stays whatever user set; no hard-coded read-only wipe
	return merged;
}

const STANDARDS_CAP = 8000;

export function loadStandards(cwd: string): string {
	const userDir = path.join(getAgentDir(), "meta-loop");
	const projectDir = path.join(cwd, CONFIG_DIR_NAME, "meta-loop");
	// High priority last in array, then join from the end within budget
	const sources: Array<{ label: string; file: string; priority: number }> = [
		{ label: "default", file: path.join(repoRoot(), "config", "standards.md"), priority: 1 },
		{ label: "user", file: path.join(userDir, "standards.md"), priority: 2 },
		{ label: "project-legacy", file: path.join(cwd, CONFIG_DIR_NAME, "meta-loop-standards.md"), priority: 3 },
		{ label: "project", file: path.join(projectDir, "standards.md"), priority: 4 },
	];
	const parts: Array<{ label: string; text: string; priority: number }> = [];
	for (const s of sources) {
		try {
			if (!fs.existsSync(s.file)) continue;
			const text = fs.readFileSync(s.file, "utf-8").trim();
			if (text) parts.push({ label: s.label, text, priority: s.priority });
		} catch (err) {
			console.error(`[pi-meta-loop] standards read failed ${s.file}:`, err);
		}
	}
	if (parts.length === 0) return "";
	// Keep highest priority content first within cap
	parts.sort((a, b) => b.priority - a.priority);
	const out: string[] = [];
	let used = 0;
	for (const p of parts) {
		const block = `### ${p.label}\n${p.text}`;
		if (used + block.length + 2 > STANDARDS_CAP) {
			const remain = STANDARDS_CAP - used - 20;
			if (remain > 100) out.push(block.slice(0, remain) + "\n...[truncated]");
			break;
		}
		out.push(block);
		used += block.length + 2;
	}
	return out.join("\n\n");
}

export function resolveSfhBranchModel(branch: { tool?: string; model?: string }, config: MetaLoopConfig): string | undefined {
	if (branch.model?.trim()) return branch.model.trim();
	const tool = branch.tool ?? "pi";
	const toolModel = config.executor.sfhToolModels?.[tool];
	if (toolModel?.trim()) return toolModel.trim();
	if (config.executor.sfhModel?.trim()) return config.executor.sfhModel.trim();
	if (tool === "pi" && config.roles.worker.model?.trim()) return config.roles.worker.model.trim();
	return undefined;
}

export function resolveSfhIntegrateModel(config: MetaLoopConfig): string | undefined {
	if (config.executor.sfhIntegrateModel?.trim()) return config.executor.sfhIntegrateModel.trim();
	if (config.executor.sfhModel?.trim()) return config.executor.sfhModel.trim();
	if (config.roles.worker.model?.trim()) return config.roles.worker.model.trim();
	return undefined;
}

export function resolveSfhBranchEffort(branch: { tool?: string; effort?: string }, config: MetaLoopConfig): string | undefined {
	if (branch.effort?.trim()) return branch.effort.trim();
	const tool = branch.tool ?? "pi";
	const v = config.executor.sfhToolEfforts?.[tool];
	if (v?.trim()) return v.trim();
	if (config.executor.sfhEffort?.trim()) return config.executor.sfhEffort.trim();
	return undefined;
}

export function resolveSfhIntegrateEffort(config: MetaLoopConfig): string | undefined {
	if (config.executor.sfhIntegrateEffort?.trim()) return config.executor.sfhIntegrateEffort.trim();
	if (config.executor.sfhEffort?.trim()) return config.executor.sfhEffort.trim();
	return undefined;
}

/** Branch access: branch > tool map > sfhAccess > read */
export function resolveSfhBranchAccess(branch: { tool?: string; access?: string }, config: MetaLoopConfig): string {
	if (branch.access?.trim()) return normalizeAccess(branch.access);
	const tool = branch.tool ?? "pi";
	const v = config.executor.sfhToolAccess?.[tool];
	if (v?.trim()) return normalizeAccess(v);
	if (config.executor.sfhAccess?.trim()) return normalizeAccess(config.executor.sfhAccess);
	return "read";
}

/** Integrate access: sfhIntegrateAccess > sfhAccess > read */
export function resolveSfhIntegrateAccess(config: MetaLoopConfig): string {
	if (config.executor.sfhIntegrateAccess?.trim()) return normalizeAccess(config.executor.sfhIntegrateAccess);
	if (config.executor.sfhAccess?.trim()) return normalizeAccess(config.executor.sfhAccess);
	return "read";
}

function normalizeAccess(a: string): string {
	const v = a.trim().toLowerCase();
	if (v === "write" || v === "full" || v === "read") return v;
	return "read";
}

export function assertSfhToolAllowed(tool: string | undefined, config: MetaLoopConfig): string | null {
	const list = config.executor.sfhAllowedTools ?? [];
	if (list.length === 0) return null;
	const t = tool ?? "pi";
	if (!list.includes(t)) return `sfh tool "${t}" is not allowed (allowed: ${list.join(", ")})`;
	return null;
}

export { defaultConfig, READ_TOOLS, WORKER_TOOLS };
