/**
 * Configuration loader.
 *
 * Layers (later wins):
 *   1. built-in defaults
 *   2. extension repo config/meta-loop.json
 *   3. user global   ~/.pi/agent/meta-loop/config.json
 *   4. project local <cwd>/.pi/meta-loop/config.json
 *      (legacy flat files also accepted)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EscalationSettings } from "./escalation.ts";
import { defaultEscalation } from "./escalation.ts";

export interface RoleConfig {
	/** pi --model 形式 (provider/model-id)。空 = pi デフォルト継承 */
	model?: string;
	tools?: string[];
}

export interface SupervisorSettings {
	/** hook 的な自動監査を有効にするか */
	auto: boolean;
	/** 前回監査からこの分数が経過したら定期監査（標準 30） */
	checkIntervalMinutes: number;
	/** 前回監査からの Worker 起動数がこの値に達したら監査（標準 6） */
	workerStartThreshold: number;
	/** この数の連続失敗で監査 */
	maxConsecutiveFailures: number;
}

export interface ExecutorSettings {
	/** sfh は必須依存。execution:"sfh" チケットの委譲先 */
	sfhEnabled: boolean;
	sfhBinary: string;
	/** グループごとの壁時計上限（秒）。sfh の timeout_sec に渡す */
	timeoutSec: number;
	/** sfh の最大並列数 */
	maxParallel: number;
	/** sfh ステップのデフォルト model（ブランチ・統合で未指定時）。 */
	sfhModel?: string;
	/** 統合ステップ専用 model。未指定なら sfhModel → roles.worker.model の順。 */
	sfhIntegrateModel?: string;
	/** ツール別のデフォルト model。例: { "pi": "provider/id", "opencode": "..." } */
	sfhToolModels?: Record<string, string>;
	/**
	 * sfh の effort（ツールが解釈。例: low/medium/high）。
	 * ブランチ未指定時の既定。
	 */
	sfhEffort?: string;
	/** ツール別 effort。例: { "codex": "high", "pi": "medium" } */
	sfhToolEfforts?: Record<string, string>;
	/** 統合ステップの effort */
	sfhIntegrateEffort?: string;
	/**
	 * sfh access: read | write | full（ブランチ既定。調査系は read 推奨）
	 */
	sfhAccess?: string;
	/** ツール別 access */
	sfhToolAccess?: Record<string, string>;
	/** 統合ステップの access（既定 read） */
	sfhIntegrateAccess?: string;
	/** グループで許可する tool 名の白リスト。空/省略 = 制限なし */
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

const defaultConfig: MetaLoopConfig = {
	enabled: true,
	roles: {
		orchestrator: { model: "", tools: ["read", "bash", "ls", "find", "grep"] },
		supervisor: { model: "", tools: ["read", "bash", "ls", "find", "grep"] },
		worker: { model: "", tools: ["read", "write", "edit", "bash", "ls", "find", "grep"] },
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

function repoRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readJsonIfExists(p: string): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(p)) return null;
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}

function applyLayer(merged: any, layer: Record<string, unknown> | null): void {
	if (!layer) return;
	if (typeof layer.enabled === "boolean") merged.enabled = layer.enabled;
	if (layer.roles && typeof layer.roles === "object") {
		for (const role of ["orchestrator", "supervisor", "worker"] as const) {
			const r = (layer.roles as any)[role];
			if (r && typeof r === "object") merged.roles[role] = { ...merged.roles[role], ...r };
		}
	}
	if (layer.limits && typeof layer.limits === "object") {
		merged.limits = { ...merged.limits, ...layer.limits };
	}
	if (layer.supervisor && typeof layer.supervisor === "object") {
		merged.supervisor = { ...merged.supervisor, ...layer.supervisor };
	}
	if (layer.executor && typeof layer.executor === "object") {
		const ex = layer.executor as any;
		merged.executor = { ...merged.executor, ...ex };
		// deep-merge toolModels so project can add one tool without wiping others
		if (ex.sfhToolModels && typeof ex.sfhToolModels === "object") {
			merged.executor.sfhToolModels = {
				...(merged.executor.sfhToolModels ?? {}),
				...ex.sfhToolModels,
			};
		}
		if (ex.sfhToolEfforts && typeof ex.sfhToolEfforts === "object") {
			merged.executor.sfhToolEfforts = {
				...(merged.executor.sfhToolEfforts ?? {}),
				...ex.sfhToolEfforts,
			};
		}
		if (ex.sfhToolAccess && typeof ex.sfhToolAccess === "object") {
			merged.executor.sfhToolAccess = {
				...(merged.executor.sfhToolAccess ?? {}),
				...ex.sfhToolAccess,
			};
		}
		if (Array.isArray(ex.sfhAllowedTools)) {
			merged.executor.sfhAllowedTools = ex.sfhAllowedTools.map(String);
		}
	}
	if (layer.escalation && typeof layer.escalation === "object") {
		merged.escalation = { ...merged.escalation, ...layer.escalation };
	}
}

export function loadConfig(cwd: string): MetaLoopConfig {
	const userDir = path.join(getAgentDir(), "meta-loop");
	const projectDir = path.join(cwd, CONFIG_DIR_NAME, "meta-loop");

	const layers: Array<Record<string, unknown> | null> = [
		readJsonIfExists(path.join(repoRoot(), "config", "meta-loop.json")),
		// user global
		readJsonIfExists(path.join(userDir, "config.json")),
		// project (folder form preferred)
		readJsonIfExists(path.join(projectDir, "config.json")),
		// legacy flat project file
		readJsonIfExists(path.join(cwd, CONFIG_DIR_NAME, "meta-loop.json")),
	];

	const merged: any = {
		...defaultConfig,
		roles: {
			orchestrator: { ...defaultConfig.roles.orchestrator },
			supervisor: { ...defaultConfig.roles.supervisor },
			worker: { ...defaultConfig.roles.worker },
		},
		supervisor: { ...defaultConfig.supervisor },
		executor: {
			...defaultConfig.executor,
			sfhToolModels: { ...(defaultConfig.executor.sfhToolModels ?? {}) },
			sfhToolEfforts: { ...(defaultConfig.executor.sfhToolEfforts ?? {}) },
			sfhToolAccess: { ...(defaultConfig.executor.sfhToolAccess ?? {}) },
			sfhAllowedTools: [...(defaultConfig.executor.sfhAllowedTools ?? [])],
		},
		escalation: { ...defaultConfig.escalation },
		limits: { ...defaultConfig.limits },
	};
	for (const layer of layers) applyLayer(merged, layer);
	return merged as MetaLoopConfig;
}

const STANDARDS_CAP = 8000;

/**
 * 点検基準の読み込み（後から追加されるものほど後ろに結合）。
 *   1. 拡張デフォルト config/standards.md
 *   2. ユーザー ~/.pi/agent/meta-loop/standards.md
 *   3. プロジェクト .pi/meta-loop/standards.md
 *   4. レガシー .pi/meta-loop-standards.md
 */
export function loadStandards(cwd: string): string {
	const userDir = path.join(getAgentDir(), "meta-loop");
	const projectDir = path.join(cwd, CONFIG_DIR_NAME, "meta-loop");
	const sources: Array<{ label: string; file: string }> = [
		{ label: "デフォルト基準", file: path.join(repoRoot(), "config", "standards.md") },
		{ label: "ユーザー基準", file: path.join(userDir, "standards.md") },
		{ label: "プロジェクト基準", file: path.join(projectDir, "standards.md") },
		{ label: "プロジェクト基準（レガシー）", file: path.join(cwd, CONFIG_DIR_NAME, "meta-loop-standards.md") },
	];
	const parts: string[] = [];
	for (const { label, file } of sources) {
		try {
			if (!fs.existsSync(file)) continue;
			const text = fs.readFileSync(file, "utf-8").trim();
			if (text) parts.push(`### ${label}\n${text}`);
		} catch {
			// ignore
		}
	}
	if (parts.length === 0) return "";
	let combined = parts.join("\n\n");
	if (combined.length > STANDARDS_CAP) combined = combined.slice(0, STANDARDS_CAP) + "\n...[基準が長いため切り詰め]";
	return combined;
}

/** Resolve the model string for an sfh branch (branch.model > toolModels > sfhModel > worker.model for pi). */
export function resolveSfhBranchModel(branch: { tool?: string; model?: string }, config: MetaLoopConfig): string | undefined {
	if (branch.model?.trim()) return branch.model.trim();
	const tool = branch.tool ?? "pi";
	const toolModel = config.executor.sfhToolModels?.[tool];
	if (toolModel?.trim()) return toolModel.trim();
	if (config.executor.sfhModel?.trim()) return config.executor.sfhModel.trim();
	if (tool === "pi" && config.roles.worker.model?.trim()) return config.roles.worker.model.trim();
	return undefined;
}

/** Resolve the model string for the sfh integrate step. */
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

export function resolveSfhBranchAccess(branch: { tool?: string; access?: string }, config: MetaLoopConfig): string {
	if (branch.access?.trim()) return branch.access.trim();
	const tool = branch.tool ?? "pi";
	const v = config.executor.sfhToolAccess?.[tool];
	if (v?.trim()) return v.trim();
	if (config.executor.sfhAccess?.trim()) return config.executor.sfhAccess.trim();
	return "read";
}

export function resolveSfhIntegrateAccess(config: MetaLoopConfig): string {
	if (config.executor.sfhIntegrateAccess?.trim()) return config.executor.sfhIntegrateAccess.trim();
	return "read";
}

/** Returns error if tool is not on the allow-list (when the list is non-empty). */
export function assertSfhToolAllowed(tool: string | undefined, config: MetaLoopConfig): string | null {
	const list = config.executor.sfhAllowedTools ?? [];
	if (list.length === 0) return null;
	const t = tool ?? "pi";
	if (!list.includes(t)) return `sfh tool "${t}" はこのプロジェクトでは許可されていません（許可: ${list.join(", ")}）`;
	return null;
}
