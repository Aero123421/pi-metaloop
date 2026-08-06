/**
 * Configuration loader. Project-local `.pi/meta-loop.json` overrides the
 * repo-bundled default config.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface RoleConfig {
	model?: string;
	tools?: string[];
}

export interface SupervisorSettings {
	/** hook 的な自動監査を有効にするか */
	auto: boolean;
	/** 前回監査からこの分数が経過したら定期監査（標準 30） */
	checkIntervalMinutes: number;
	/** 前回監査からの Worker 起動数がこの値に達したら監査（標準 4） */
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
	},
	limits: {
		maxTasks: 8,
		concurrency: 1,
		perTaskOutputCap: 51200,
	},
};

function repoConfigPath(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "config", "meta-loop.json");
}

const STANDARDS_CAP = 8000;

/**
 * 点検基準の読み込み。拡張デフォルト（config/standards.md）＋
 * プロジェクト個別（<cwd>/.pi/meta-loop-standards.md）を追加で結合する。
 * Supervisor の判定根拠・Orchestrator のチケット設計に使う。
 */
export function loadStandards(cwd: string): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const sources: Array<{ label: string; file: string }> = [
		{ label: "デフォルト基準", file: path.join(here, "..", "config", "standards.md") },
		{ label: "プロジェクト個別基準", file: path.join(cwd, CONFIG_DIR_NAME, "meta-loop-standards.md") },
	];
	const parts: string[] = [];
	for (const { label, file } of sources) {
		try {
			if (!fs.existsSync(file)) continue;
			const text = fs.readFileSync(file, "utf-8").trim();
			if (text) parts.push(`### ${label}\n${text}`);
		} catch {
			// ignore unreadable standards
		}
	}
	if (parts.length === 0) return "";
	let combined = parts.join("\n\n");
	if (combined.length > STANDARDS_CAP) combined = combined.slice(0, STANDARDS_CAP) + "\n...[基準が長いため切り詰め]";
	return combined;
}

function readJsonIfExists(p: string): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(p)) return null;
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}

export function loadConfig(cwd: string): MetaLoopConfig {
	const projectOverride = readJsonIfExists(path.join(cwd, CONFIG_DIR_NAME, "meta-loop.json"));
	const repoConfig = readJsonIfExists(repoConfigPath());
	const merged: any = { ...defaultConfig };
	for (const layer of [repoConfig, projectOverride]) {
		if (!layer) continue;
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
			merged.executor = { ...merged.executor, ...layer.executor };
		}
	}
	return merged as MetaLoopConfig;
}
