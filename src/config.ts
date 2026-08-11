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
import {
	DEFAULT_EVIDENCE_IGNORE_DIRS,
	DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS,
} from "./fs-snapshot.ts";
import type { VerifyMode } from "./types.ts";

export interface RoleConfig {
	model?: string;
	/** undefined inherits role/pi defaults; [] explicitly disables every tool. */
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
	/** Explicit tool for the sfh integrate step; otherwise inferred from the model id. */
	sfhIntegrateTool?: string;
	sfhAccess?: string;
	sfhToolAccess?: Record<string, string>;
	sfhIntegrateAccess?: string;
	/** undefined is unrestricted; [] denies every sfh preset tool. */
	sfhAllowedTools?: string[];
	/**
	 * Controller-side trusted deterministic verify argv lists (no shell).
	 * Each entry is `[command, ...args]`. Required for native worker `done`.
	 * undefined/[] → verify unset → done forbidden. Project cannot introduce commands.
	 */
	verifyCommands?: string[][];
	/** User/base-approved named argv sets; project may select but never define these. */
	verifyProfiles?: Record<string, string[][]>;
	verifyProfile?: string;
	/** Wall-clock budget for the full verify sequence (seconds). */
	verifyTimeoutSec?: number;
	/**
	 * `per-ticket` (default) verifies after every native ticket. `final` verifies
	 * once after the execute loop and promotes tickets that claimed done, which
	 * suits plans whose intermediate tickets cannot leave the tree green.
	 */
	verifyMode?: VerifyMode;
}

/**
 * Bounds on the post-hoc filesystem evidence sweep.
 *
 * Project layers may only *widen* coverage (drop ignores, scan deeper, allow
 * more entries) — the inverse of every other setting here, because narrower
 * evidence means weaker detection.
 */
export interface EvidenceSettings {
	/** Directory names recorded but not descended into. */
	ignoreDirNames: string[];
	/** Depth below cwd's parent. 0 records direct entries without descending. */
	parentMaxDepth: number;
	maxEntries: number;
	timeoutMs: number;
}

/** Access ceilings captured after base (repo/user/global) layers. Project/ticket cannot raise above these. */
export interface SfhAccessCeiling {
	sfhAccess: string;
	sfhToolAccess: Record<string, string>;
	sfhIntegrateAccess: string;
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
	evidence: EvidenceSettings;
	limits: {
		maxTasks: number;
		perTaskOutputCap: number;
		/**
		 * Upper bound on Supervisor audits per run. Bounds the model spend when a
		 * single dependency failure blocks many tickets at once.
		 */
		maxSupervisions: number;
		/**
		 * Optional harness-level ceiling on ticket `allowed_scope`. When set, every
		 * ticket path must also match one of these rules, so a plan cannot widen the
		 * write surface beyond what the user approved.
		 */
		scopeCeiling?: string[];
	};
	/**
	 * Base-layer (user/global) sfh access ceilings.
	 * Applied as min() over tool map / branch.access / integrate resolution so project or ticket cannot escalate.
	 */
	sfhAccessCeiling?: SfhAccessCeiling;
	/** User/base opt-in allowing project config to choose role models. Default false. */
	allowProjectModelOverride: boolean;
}

export const CONFIG_VERSION = 1;

const READ_TOOLS = ["read", "ls", "find", "grep"];
/**
 * Strict native Worker built-in allowlist — interceptable by scope-guard only.
 * bash and any custom/extension tool names are never granted.
 * Build/test verification is the controller's trusted deterministic path.
 */
const WORKER_TOOLS = ["read", "write", "edit", "ls", "find", "grep"] as const;
const WORKER_TOOL_ALLOWLIST = new Set<string>(WORKER_TOOLS);

/** Default wall-clock for controller verify when unset (seconds). */
export const DEFAULT_VERIFY_TIMEOUT_SEC = 600;

/**
 * Effective Pi tools for a native implementation worker.
 * Strict intersection with WORKER_TOOLS — drops bash and any non-built-in names
 * even when alias/args/config request them. `undefined` → full allowlist; `[]` stays deny-all.
 */
export function effectiveNativeWorkerTools(tools?: string[]): string[] {
	const base = tools === undefined ? [...WORKER_TOOLS] : tools.map(String);
	return base.filter((t) => WORKER_TOOL_ALLOWLIST.has(t.trim().toLowerCase()));
}

/** Non-null when a tool list requests anything outside the strict built-in allowlist. */
export function nativeWorkerToolsDenial(tools?: string[]): string | null {
	if (!tools?.length) return null;
	const rejected = [
		...new Set(
			tools
				.map(String)
				.map((t) => t.trim())
				.filter((t) => t && !WORKER_TOOL_ALLOWLIST.has(t.toLowerCase())),
		),
	];
	if (!rejected.length) return null;
	return `native worker tools must be interceptable built-ins only (${WORKER_TOOLS.join(", ")}); rejected: ${rejected.join(", ")}`;
}

/** Normalize executor.verifyCommands; invalid entries dropped. */
export function normalizeVerifyCommands(raw: unknown): string[][] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[][] = [];
	for (const entry of raw) {
		if (!Array.isArray(entry) || entry.length === 0) continue;
		const argv = entry.map((x) => String(x)).filter((s) => s.length > 0);
		if (!argv.length) continue;
		// Reject shell metacharacters in the executable token — no shell is used, but fail closed on odd paths.
		if (/[\n\r|&;<>()$`]/.test(argv[0])) continue;
		out.push(argv);
	}
	return out;
}

function verifyCommandKey(argv: string[]): string {
	return JSON.stringify(argv);
}

function normalizeVerifyMode(raw: unknown): VerifyMode | undefined {
	return raw === "final" || raw === "per-ticket" ? raw : undefined;
}

/**
 * Settings that resolve to `write`/`full` sfh access. That access is refused at
 * plan and execute time (no OS sandbox can enforce scope), so surfacing it up
 * front turns a late, unactionable ticket failure into one clear warning.
 *
 * The access-resolution ceilings stay intact rather than being clamped here, so
 * the privilege model is still exercised and ready if a sandbox lands.
 */
export function unsupportedSfhAccessSettings(config: MetaLoopConfig): string[] {
	const ex = config.executor;
	const mutating = (value: string | undefined) => value === "write" || value === "full";
	const found: string[] = [];
	if (mutating(ex.sfhAccess)) found.push(`executor.sfhAccess=${ex.sfhAccess}`);
	if (mutating(ex.sfhIntegrateAccess)) found.push(`executor.sfhIntegrateAccess=${ex.sfhIntegrateAccess}`);
	for (const [tool, value] of Object.entries(ex.sfhToolAccess ?? {})) {
		if (mutating(value)) found.push(`executor.sfhToolAccess.${tool}=${value}`);
	}
	return found;
}

function normalizeVerifyProfiles(raw: unknown): Record<string, string[][]> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const profiles: Record<string, string[][]> = {};
	for (const [name, commands] of Object.entries(raw)) {
		if (!name.trim()) continue;
		profiles[name] = normalizeVerifyCommands(commands) ?? [];
	}
	return profiles;
}

/** Project may only keep a subset of base verify commands — never introduce new ones. */
function narrowVerifyCommands(
	ceiling: string[][] | undefined,
	request: string[][] | undefined,
): string[][] | undefined {
	if (request === undefined) return ceiling;
	if (!ceiling?.length) return []; // project cannot introduce when base has none
	const allowed = new Set(ceiling.map(verifyCommandKey));
	return request.filter((argv) => allowed.has(verifyCommandKey(argv)));
}

const defaultConfig: MetaLoopConfig = {
	enabled: true,
	allowProjectModelOverride: false,
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
		sfhIntegrateTool: "",
		sfhAccess: "read",
		sfhToolAccess: {},
		sfhIntegrateAccess: "read",
		// unset → native done forbidden until user/base configures trusted verify
		verifyCommands: undefined,
		verifyProfiles: {},
		verifyProfile: undefined,
		verifyTimeoutSec: DEFAULT_VERIFY_TIMEOUT_SEC,
		verifyMode: "per-ticket",
	},
	escalation: { ...defaultEscalation },
	evidence: {
		ignoreDirNames: [...DEFAULT_EVIDENCE_IGNORE_DIRS],
		parentMaxDepth: DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS.parentMaxDepth,
		maxEntries: DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS.maxEntries,
		timeoutMs: DEFAULT_FILESYSTEM_SNAPSHOT_LIMITS.timeoutMs,
	},
	limits: {
		maxTasks: 8,
		perTaskOutputCap: 51200,
		maxSupervisions: 12,
		scopeCeiling: undefined,
	},
};

const ACCESS_RANK: Record<string, number> = { read: 0, write: 1, full: 2 };

function repoRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Config layers that could not be read, in load order. A broken layer disables
 * meta-loop, and the only prior signal was a `console.error` the TUI never
 * shows — so the reason is recorded here for `/ml-doctor` and the run start.
 */
export interface ConfigProblem {
	file: string;
	message: string;
}

const configProblems = new Map<string, ConfigProblem[]>();

function readJsonIfExists(p: string, problems?: ConfigProblem[]): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(p)) return null;
		const value = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("config root must be a JSON object");
		}
		const parsed = value as Record<string, unknown>;
		if (parsed.config_version !== undefined && parsed.config_version !== CONFIG_VERSION) {
			throw new Error(`unsupported config_version ${String(parsed.config_version)} (supported: ${CONFIG_VERSION})`);
		}
		return parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-meta-loop] failed to read config ${p}:`, err);
		problems?.push({ file: p, message });
		// A present but unreadable layer must never silently broaden capabilities.
		return { enabled: false };
	}
}

/** Why meta-loop is disabled, when a config layer failed to load for this cwd. */
export function getConfigProblems(cwd: string): ConfigProblem[] {
	return configProblems.get(path.resolve(cwd)) ?? [];
}

function intersectTools(ceiling: string[] | undefined, request: string[] | undefined): string[] | undefined {
	if (request === undefined) return ceiling;
	// An undefined ceiling means the inherited pi defaults, which an explicit
	// project list may narrow. An explicit empty ceiling is already deny-all.
	if (ceiling === undefined) return request;
	const set = new Set(ceiling);
	return request.filter((t) => set.has(t));
}

function minAccess(a?: string, b?: string): string {
	const ra = ACCESS_RANK[(a ?? "read").toLowerCase()] ?? 0;
	const rb = ACCESS_RANK[(b ?? "read").toLowerCase()] ?? 0;
	const m = Math.min(ra, rb);
	return m <= 0 ? "read" : m === 1 ? "write" : "full";
}

function intersectAllowList(
	ceiling: string[] | undefined,
	request: string[] | undefined,
): string[] | undefined {
	// undefined = unrestricted/no project change; [] = explicit deny-all.
	if (request === undefined) return ceiling;
	if (ceiling === undefined) return request;
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
	if (typeof layer.allowProjectModelOverride === "boolean" && kind !== "project") {
		// Only user/base layers may hand this decision to project config.
		merged.allowProjectModelOverride = layer.allowProjectModelOverride;
	}
	if (layer.roles && typeof layer.roles === "object") {
		for (const role of ["orchestrator", "supervisor", "worker"] as const) {
			const r = (layer.roles as any)[role];
			if (!r || typeof r !== "object") continue;
			const cur = merged.roles[role];
			if (kind === "project") {
				// Which model supervises is a trust decision, not a project preference:
				// a repository could otherwise point the Supervisor at a weak model and
				// hollow out supervision, or at a provider that sees the conversation
				// digest. Opt in explicitly per user config to allow it.
				const projectModel =
					merged.allowProjectModelOverride && typeof r.model === "string" ? r.model : cur.model;
				merged.roles[role] = {
					model: projectModel,
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
		const requestedCeiling = Array.isArray(L.scopeCeiling) ? L.scopeCeiling.map(String) : undefined;
		const requested = {
			maxTasks: clampInt(L.maxTasks ?? merged.limits.maxTasks, 1, 64),
			perTaskOutputCap: clampInt(L.perTaskOutputCap ?? merged.limits.perTaskOutputCap, 1000, 5_000_000),
			maxSupervisions: clampInt(L.maxSupervisions ?? merged.limits.maxSupervisions, 1, 200),
		};
		merged.limits =
			kind === "project"
				? {
						maxTasks: Math.min(merged.limits.maxTasks, requested.maxTasks),
						perTaskOutputCap: Math.min(merged.limits.perTaskOutputCap, requested.perTaskOutputCap),
						maxSupervisions: Math.min(merged.limits.maxSupervisions, requested.maxSupervisions),
						// A project may tighten the write surface further, never widen it.
						scopeCeiling: intersectAllowList(merged.limits.scopeCeiling, requestedCeiling),
				  }
				: { ...requested, scopeCeiling: requestedCeiling ?? merged.limits.scopeCeiling };
	}
	if (layer.evidence && typeof layer.evidence === "object") {
		const E = layer.evidence as any;
		const requestedIgnores = Array.isArray(E.ignoreDirNames) ? E.ignoreDirNames.map(String) : undefined;
		const requested = {
			ignoreDirNames: requestedIgnores ?? merged.evidence.ignoreDirNames,
			parentMaxDepth: clampInt(E.parentMaxDepth ?? merged.evidence.parentMaxDepth, 0, 8),
			maxEntries: clampInt(E.maxEntries ?? merged.evidence.maxEntries, 1_000, 5_000_000),
			timeoutMs: clampInt(E.timeoutMs ?? merged.evidence.timeoutMs, 1_000, 600_000),
		};
		merged.evidence =
			kind === "project"
				? {
						// Inverted monotonicity: a project may only widen evidence coverage.
						ignoreDirNames: requestedIgnores
							? merged.evidence.ignoreDirNames.filter((d) => requestedIgnores.includes(d))
							: merged.evidence.ignoreDirNames,
						parentMaxDepth: Math.max(merged.evidence.parentMaxDepth, requested.parentMaxDepth),
						maxEntries: Math.max(merged.evidence.maxEntries, requested.maxEntries),
						timeoutMs: Math.max(merged.evidence.timeoutMs, requested.timeoutMs),
				  }
				: requested;
	}
	if (layer.supervisor && typeof layer.supervisor === "object") {
		const s = layer.supervisor as Record<string, unknown>;
		if (kind === "project") {
			merged.supervisor = {
				auto: s.auto === false ? false : merged.supervisor.auto,
				checkIntervalMinutes: narrowNonNegativeInt(
					merged.supervisor.checkIntervalMinutes,
					s.checkIntervalMinutes,
				),
				workerStartThreshold: narrowNonNegativeInt(
					merged.supervisor.workerStartThreshold,
					s.workerStartThreshold,
				),
				maxConsecutiveFailures: narrowNonNegativeInt(
					merged.supervisor.maxConsecutiveFailures,
					s.maxConsecutiveFailures,
				),
			};
		} else {
			merged.supervisor = {
				auto: typeof s.auto === "boolean" ? s.auto : merged.supervisor.auto,
				checkIntervalMinutes: configuredNonNegativeInt(
					s.checkIntervalMinutes,
					merged.supervisor.checkIntervalMinutes,
				),
				workerStartThreshold: configuredNonNegativeInt(
					s.workerStartThreshold,
					merged.supervisor.workerStartThreshold,
				),
				maxConsecutiveFailures: configuredNonNegativeInt(
					s.maxConsecutiveFailures,
					merged.supervisor.maxConsecutiveFailures,
				),
			};
		}
	}
	if (layer.escalation && typeof layer.escalation === "object") {
		// Validated like every other section: an unparsed spread let a bad value
		// through and turned every threshold comparison into NaN.
		const E = layer.escalation as any;
		merged.escalation = {
			enabled: typeof E.enabled === "boolean" ? E.enabled : merged.escalation.enabled,
			toolCallThreshold: clampInt(E.toolCallThreshold ?? merged.escalation.toolCallThreshold, 1, 100_000),
			distinctPathThreshold: clampInt(E.distinctPathThreshold ?? merged.escalation.distinctPathThreshold, 1, 100_000),
			writeThreshold: clampInt(E.writeThreshold ?? merged.escalation.writeThreshold, 1, 100_000),
			promptLengthThreshold: clampInt(E.promptLengthThreshold ?? merged.escalation.promptLengthThreshold, 1, 1_000_000),
		};
	}
	if (layer.executor && typeof layer.executor === "object") {
		const ex = layer.executor as any;
		const cur = merged.executor;
		if (kind === "project") {
			// project cannot change binary or expand access/tools/verify
			const projectVerify = Array.isArray(ex.verifyCommands)
				? normalizeVerifyCommands(ex.verifyCommands)
				: undefined;
			const requestedProfile = typeof ex.verifyProfile === "string" ? ex.verifyProfile.trim() : undefined;
			const profileCommands = requestedProfile
				? cur.verifyProfiles?.[requestedProfile]
				: undefined;
			merged.executor = {
				...cur,
				sfhEnabled: ex.sfhEnabled === false ? false : cur.sfhEnabled,
				timeoutSec: Math.min(
					cur.timeoutSec,
					clampInt(ex.timeoutSec ?? cur.timeoutSec, 30, 86_400),
				),
				maxParallel: Math.min(
					cur.maxParallel,
					clampInt(ex.maxParallel ?? cur.maxParallel, 1, 16),
				),
				sfhModel: typeof ex.sfhModel === "string" ? ex.sfhModel : cur.sfhModel,
				sfhIntegrateModel: typeof ex.sfhIntegrateModel === "string" ? ex.sfhIntegrateModel : cur.sfhIntegrateModel,
				sfhEffort: typeof ex.sfhEffort === "string" ? ex.sfhEffort : cur.sfhEffort,
				sfhIntegrateEffort: typeof ex.sfhIntegrateEffort === "string" ? ex.sfhIntegrateEffort : cur.sfhIntegrateEffort,
				sfhIntegrateTool: typeof ex.sfhIntegrateTool === "string" ? ex.sfhIntegrateTool : cur.sfhIntegrateTool,
				sfhAccess:
					ex.sfhAccess === undefined ? cur.sfhAccess : minAccess(cur.sfhAccess, ex.sfhAccess),
				sfhIntegrateAccess:
					ex.sfhIntegrateAccess === undefined
						? cur.sfhIntegrateAccess
						: minAccess(cur.sfhIntegrateAccess ?? "read", ex.sfhIntegrateAccess),
				sfhAllowedTools: intersectAllowList(cur.sfhAllowedTools, Array.isArray(ex.sfhAllowedTools) ? ex.sfhAllowedTools.map(String) : undefined),
				sfhToolModels: { ...(cur.sfhToolModels ?? {}), ...(ex.sfhToolModels && typeof ex.sfhToolModels === "object" ? ex.sfhToolModels : {}) },
				sfhToolEfforts: { ...(cur.sfhToolEfforts ?? {}), ...(ex.sfhToolEfforts && typeof ex.sfhToolEfforts === "object" ? ex.sfhToolEfforts : {}) },
				sfhToolAccess: mergeAccessMap(cur.sfhToolAccess, ex.sfhToolAccess, cur.sfhAccess),
				// sfhBinary intentionally not overridable by project
				sfhBinary: cur.sfhBinary,
				verifyProfiles: cur.verifyProfiles,
				verifyProfile: requestedProfile ?? cur.verifyProfile,
				verifyCommands: requestedProfile
					? profileCommands === undefined
						? []
						: narrowVerifyCommands(profileCommands, projectVerify)
					: narrowVerifyCommands(cur.verifyCommands, projectVerify),
				verifyTimeoutSec: Math.min(
					cur.verifyTimeoutSec ?? DEFAULT_VERIFY_TIMEOUT_SEC,
					clampInt(ex.verifyTimeoutSec ?? cur.verifyTimeoutSec ?? DEFAULT_VERIFY_TIMEOUT_SEC, 5, 86_400),
				),
				// Scheduling preference, not a capability: the gate strength is identical.
				verifyMode: normalizeVerifyMode(ex.verifyMode) ?? cur.verifyMode,
			};
		} else {
			const profiles = {
				...(cur.verifyProfiles ?? {}),
				...(normalizeVerifyProfiles(ex.verifyProfiles) ?? {}),
			};
			const requestedProfile = typeof ex.verifyProfile === "string" ? ex.verifyProfile.trim() : cur.verifyProfile;
			const baseVerify = Array.isArray(ex.verifyCommands)
				? normalizeVerifyCommands(ex.verifyCommands)
				: requestedProfile
					? profiles[requestedProfile]
					: cur.verifyCommands;
			merged.executor = {
				...cur,
				...ex,
				sfhToolModels: { ...(cur.sfhToolModels ?? {}), ...(ex.sfhToolModels && typeof ex.sfhToolModels === "object" ? ex.sfhToolModels : {}) },
				sfhToolEfforts: { ...(cur.sfhToolEfforts ?? {}), ...(ex.sfhToolEfforts && typeof ex.sfhToolEfforts === "object" ? ex.sfhToolEfforts : {}) },
				sfhToolAccess: { ...(cur.sfhToolAccess ?? {}), ...(ex.sfhToolAccess && typeof ex.sfhToolAccess === "object" ? ex.sfhToolAccess : {}) },
				sfhAllowedTools: Array.isArray(ex.sfhAllowedTools) ? ex.sfhAllowedTools.map(String) : cur.sfhAllowedTools,
				verifyCommands: baseVerify === undefined ? cur.verifyCommands : baseVerify,
				verifyProfiles: profiles,
				verifyProfile: requestedProfile,
				verifyTimeoutSec:
					ex.verifyTimeoutSec === undefined
						? cur.verifyTimeoutSec
						: clampInt(ex.verifyTimeoutSec, 5, 86_400),
				verifyMode: normalizeVerifyMode(ex.verifyMode) ?? cur.verifyMode,
			};
		}
	}
}

function mergeAccessMap(
	ceiling?: Record<string, string>,
	request?: Record<string, string>,
	fallbackCeiling: string = "full",
): Record<string, string> {
	const out = { ...(ceiling ?? {}) };
	if (!request || typeof request !== "object") return out;
	for (const [k, v] of Object.entries(request)) {
		out[k] = minAccess(out[k] ?? fallbackCeiling, v);
	}
	return out;
}

function clampInt(n: unknown, min: number, max: number): number {
	const v = typeof n === "number" ? n : Number(n);
	if (!Number.isFinite(v)) return min;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

function configuredNonNegativeInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function narrowNonNegativeInt(ceiling: number, request: unknown): number {
	if (request === undefined) return ceiling;
	return Math.min(ceiling, configuredNonNegativeInt(request, ceiling));
}

/** Tool max_tasks may narrow the configured ceiling, never raise it. */
export function resolveMaxTasksCeiling(configured: number, requested?: number): number {
	const ceiling = clampInt(configured, 1, 64);
	if (requested === undefined) return ceiling;
	return Math.min(ceiling, clampInt(requested, 1, 64));
}

function cloneDefault(): MetaLoopConfig {
	return {
		enabled: defaultConfig.enabled,
		allowProjectModelOverride: defaultConfig.allowProjectModelOverride,
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
			sfhAllowedTools:
				defaultConfig.executor.sfhAllowedTools === undefined
					? undefined
					: [...defaultConfig.executor.sfhAllowedTools],
			verifyCommands:
				defaultConfig.executor.verifyCommands === undefined
					? undefined
					: defaultConfig.executor.verifyCommands.map((c) => [...c]),
			verifyTimeoutSec: defaultConfig.executor.verifyTimeoutSec,
			verifyProfiles: Object.fromEntries(
				Object.entries(defaultConfig.executor.verifyProfiles ?? {}).map(([name, commands]) => [
					name,
					commands.map((command) => [...command]),
				]),
			),
			verifyProfile: defaultConfig.executor.verifyProfile,
			verifyMode: defaultConfig.executor.verifyMode,
		},
		escalation: { ...defaultConfig.escalation },
		evidence: {
			...defaultConfig.evidence,
			ignoreDirNames: [...defaultConfig.evidence.ignoreDirNames],
		},
		limits: {
			...defaultConfig.limits,
			scopeCeiling: defaultConfig.limits.scopeCeiling
				? [...defaultConfig.limits.scopeCeiling]
				: undefined,
		},
	};
}

/** Snapshot executor access fields as the base-layer ceiling (call after base layers, before project). */
export function captureSfhAccessCeiling(config: MetaLoopConfig): SfhAccessCeiling {
	const toolAccess: Record<string, string> = {};
	for (const [k, v] of Object.entries(config.executor.sfhToolAccess ?? {})) {
		if (typeof v === "string" && v.trim()) toolAccess[k] = normalizeAccess(v);
	}
	const ceiling: SfhAccessCeiling = {
		sfhAccess: normalizeAccess(config.executor.sfhAccess ?? "read"),
		sfhToolAccess: toolAccess,
		sfhIntegrateAccess: normalizeAccess(config.executor.sfhIntegrateAccess ?? "read"),
	};
	config.sfhAccessCeiling = ceiling;
	return ceiling;
}

/**
 * Build config from explicit base/project layer objects (tests + programmatic use).
 * Mirrors loadConfig layering: base → capture ceiling → project (min-only).
 */
/** Refuse bash (etc.) on worker tools even when a base/user layer lists them. */
function enforceNativeWorkerToolPolicy(config: MetaLoopConfig): void {
	config.roles.worker.tools = effectiveNativeWorkerTools(config.roles.worker.tools);
}

export function buildConfigFromLayers(
	baseLayers: Array<Record<string, unknown> | null | undefined> = [],
	projectLayers: Array<Record<string, unknown> | null | undefined> = [],
): MetaLoopConfig {
	const merged = cloneDefault();
	for (const layer of baseLayers) applyLayer(merged, layer ?? null, "base");
	captureSfhAccessCeiling(merged);
	for (const layer of projectLayers) applyLayer(merged, layer ?? null, "project");
	enforceNativeWorkerToolPolicy(merged);
	return merged;
}

interface ConfigCacheEntry {
	config: MetaLoopConfig;
	problems: ConfigProblem[];
	at: number;
}
const configCache = new Map<string, ConfigCacheEntry>();
/**
 * Config is re-read on every tool call by the escalation hook. Layers change at
 * human speed, so a short TTL removes that per-call disk work while still
 * picking up edits within a couple of seconds.
 */
const CONFIG_CACHE_TTL_MS = 2_000;

/** Drop cached layers (tests, and any path that rewrites config on disk). */
export function invalidateConfigCache(): void {
	configCache.clear();
}

export function loadConfig(cwd: string, opts?: { cache?: boolean }): MetaLoopConfig {
	const key = path.resolve(cwd);
	if (opts?.cache) {
		const hit = configCache.get(key);
		if (hit && Date.now() - hit.at < CONFIG_CACHE_TTL_MS) {
			configProblems.set(key, hit.problems);
			return hit.config;
		}
	}
	const config = loadConfigUncached(cwd);
	if (opts?.cache) {
		configCache.set(key, { config, problems: getConfigProblems(cwd), at: Date.now() });
	}
	return config;
}

function loadConfigUncached(cwd: string): MetaLoopConfig {
	const userDir = path.join(getAgentDir(), "meta-loop");
	const projectDir = path.join(cwd, CONFIG_DIR_NAME, "meta-loop");
	const merged = cloneDefault();
	const problems: ConfigProblem[] = [];

	// base layers (may expand from defaults)
	applyLayer(merged, readJsonIfExists(path.join(repoRoot(), "config", "meta-loop.json"), problems), "base");
	applyLayer(merged, readJsonIfExists(path.join(userDir, "config.json"), problems), "base");
	// Freeze user/global access ceilings before project layers (project may only narrow).
	captureSfhAccessCeiling(merged);
	// legacy project first, then folder form (folder wins)
	const legacy = readJsonIfExists(path.join(cwd, CONFIG_DIR_NAME, "meta-loop.json"), problems);
	const folder = readJsonIfExists(path.join(projectDir, "config.json"), problems);
	if (legacy && folder) {
		console.error("[pi-meta-loop] both .pi/meta-loop.json and .pi/meta-loop/config.json exist; folder form wins");
	}
	applyLayer(merged, legacy, "project");
	applyLayer(merged, folder, "project");

	// Scoped native workers never receive bash, regardless of alias/args/config requests.
	enforceNativeWorkerToolPolicy(merged);
	configProblems.set(path.resolve(cwd), problems);
	return merged;
}

export interface VerifyDiagnostics {
	donePossible: boolean;
	commands: string[][];
	timeoutSec: number;
	allowedBy: string;
	narrowedBy: string[];
	profile?: string;
	problem?: string;
}

/** Explain the effective trusted-verify gate without exposing unrelated config. */
export function getVerifyDiagnostics(cwd: string, config = loadConfig(cwd)): VerifyDiagnostics {
	const userDir = path.join(getAgentDir(), "meta-loop");
	const candidates = [
		{ label: "repository defaults", file: path.join(repoRoot(), "config", "meta-loop.json"), project: false },
		{ label: "user config", file: path.join(userDir, "config.json"), project: false },
		{ label: "legacy project config", file: path.join(cwd, CONFIG_DIR_NAME, "meta-loop.json"), project: true },
		{ label: "project config", file: path.join(cwd, CONFIG_DIR_NAME, "meta-loop", "config.json"), project: true },
	];
	let allowedBy = "not configured";
	const narrowedBy: string[] = [];
	for (const candidate of candidates) {
		const raw = readJsonIfExists(candidate.file);
		const executor = raw?.executor;
		if (
			!executor ||
			typeof executor !== "object" ||
			!("verifyCommands" in executor || "verifyProfiles" in executor || "verifyProfile" in executor)
		) continue;
		if (candidate.project) narrowedBy.push(candidate.label);
		else allowedBy = candidate.label;
	}
	const commands = config.executor.verifyCommands ?? [];
	const profile = config.executor.verifyProfile;
	const problem = profile && !(profile in (config.executor.verifyProfiles ?? {}))
		? `unknown verifyProfile ${JSON.stringify(profile)}; define it in user config`
		: commands.length === 0
			? "no trusted verify argv; native done is forbidden"
			: undefined;
	return {
		donePossible: commands.length > 0,
		commands,
		timeoutSec: config.executor.verifyTimeoutSec ?? DEFAULT_VERIFY_TIMEOUT_SEC,
		allowedBy,
		narrowedBy,
		profile,
		problem,
	};
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

/**
 * Effective base ceiling for a branch/tool: tool-specific ceiling if present, else sfhAccess ceiling.
 * Without a captured ceiling, returns undefined (no extra clamp — preserves legacy callers).
 */
function branchAccessCeiling(config: MetaLoopConfig, tool: string): string | undefined {
	const ceil = config.sfhAccessCeiling;
	if (!ceil) return undefined;
	const toolCeil = ceil.sfhToolAccess?.[tool];
	if (typeof toolCeil === "string" && toolCeil.trim()) return normalizeAccess(toolCeil);
	return normalizeAccess(ceil.sfhAccess ?? "read");
}

function integrateAccessCeiling(config: MetaLoopConfig): string | undefined {
	const ceil = config.sfhAccessCeiling;
	if (!ceil) return undefined;
	return normalizeAccess(ceil.sfhIntegrateAccess ?? "read");
}

/** Branch access: branch > tool map > sfhAccess > read, then min with base ceiling (no escalation). */
export function resolveSfhBranchAccess(branch: { tool?: string; access?: string }, config: MetaLoopConfig): string {
	const tool = branch.tool ?? "pi";
	let resolved: string;
	if (branch.access?.trim()) {
		resolved = normalizeAccess(branch.access);
	} else {
		const v = config.executor.sfhToolAccess?.[tool];
		if (v?.trim()) resolved = normalizeAccess(v);
		else if (config.executor.sfhAccess?.trim()) resolved = normalizeAccess(config.executor.sfhAccess);
		else resolved = "read";
	}
	const ceiling = branchAccessCeiling(config, tool);
	if (ceiling === undefined) return resolved;
	return minAccess(resolved, ceiling);
}

/** Integrate access: sfhIntegrateAccess > sfhAccess > read, then min with base integrate ceiling. */
export function resolveSfhIntegrateAccess(config: MetaLoopConfig): string {
	let resolved: string;
	if (config.executor.sfhIntegrateAccess?.trim()) resolved = normalizeAccess(config.executor.sfhIntegrateAccess);
	else if (config.executor.sfhAccess?.trim()) resolved = normalizeAccess(config.executor.sfhAccess);
	else resolved = "read";
	const ceiling = integrateAccessCeiling(config);
	if (ceiling === undefined) return resolved;
	return minAccess(resolved, ceiling);
}

function normalizeAccess(a: string): string {
	const v = a.trim().toLowerCase();
	if (v === "write" || v === "full" || v === "read") return v;
	return "read";
}

export function assertSfhToolAllowed(tool: string | undefined, config: MetaLoopConfig): string | null {
	const list = config.executor.sfhAllowedTools;
	if (list === undefined) return null;
	const t = tool ?? "pi";
	if (!list.includes(t)) {
		return `sfh tool "${t}" is not allowed (allowed: ${list.length > 0 ? list.join(", ") : "none"})`;
	}
	return null;
}

export { defaultConfig, READ_TOOLS, WORKER_TOOLS };
