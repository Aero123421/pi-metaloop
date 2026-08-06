/**
 * sfh (SimpleFlowHarness) status integration.
 *
 * Reads .sfh/runs/<run>/status.json snapshots directly (no process spawn),
 * so the pi TUI can show live sfh progress for runs started by this
 * extension or manually from a terminal.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SfhStatus {
	schema_version?: number;
	state: "running" | "done" | "failed" | "stuck" | "interrupted" | "stopped" | string;
	current_step: string;
	steps_done: number;
	cost_usd: number;
	elapsed_sec: number;
	fanout_total: number;
	fanout_completed: number;
	active_members: Record<string, string>;
	flow: string;
	run_dir: string;
	pid: number;
	exit_code?: number | null;
	error?: string | null;
	heartbeat_utc?: string;
	started_utc?: string;
}

export interface RunSummary {
	runDir: string;
	id: string;
	status: SfhStatus | null;
	mtimeMs: number;
}

function runsRoot(cwd: string): string {
	return path.join(cwd, ".sfh", "runs");
}

export function readStatus(runDir: string): SfhStatus | null {
	try {
		const raw = fs.readFileSync(path.join(runDir, "status.json"), "utf-8");
		return JSON.parse(raw) as SfhStatus;
	} catch {
		return null;
	}
}

/** Most recent runs first. Tolerant of missing/partial run dirs. */
export function listRuns(cwd: string, limit = 10): RunSummary[] {
	const root = runsRoot(cwd);
	try {
		if (!fs.existsSync(root)) return [];
		const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
		const runs: RunSummary[] = entries.map((e) => {
			const runDir = path.join(root, e.name);
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(path.join(runDir, "status.json")).mtimeMs;
			} catch {
				try {
					mtimeMs = fs.statSync(runDir).mtimeMs;
				} catch {
					// ignore
				}
			}
			return { runDir, id: e.name, status: readStatus(runDir), mtimeMs };
		});
		return runs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
	} catch {
		return [];
	}
}

export function activeRuns(cwd: string): RunSummary[] {
	return listRuns(cwd, 20).filter((r) => r.status && (r.status.state === "running" || r.status.state === "stuck"));
}

export function formatElapsed(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "?";
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return `${m}m${s > 0 ? `${s}s` : ""}`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}
