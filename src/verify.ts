/**
 * Controller-side trusted deterministic verify.
 *
 * Runs configured argv lists with shell:false after a native Worker finishes.
 * Independent of model claims — required before ticket status may become "done".
 */
import type { VerifyEvidence } from "./types.ts";
import { spawnManagedProcess } from "./spawn.ts";
import { DEFAULT_VERIFY_TIMEOUT_SEC } from "./config.ts";

const OUTPUT_CAP = 8_000;

export function unsetVerifyEvidence(reason = "controller trusted verify not configured"): VerifyEvidence {
	return { status: "unset", reason, commands: [] };
}

/**
 * Run verify commands sequentially (fail-fast). Empty/undefined → unset.
 * Wall-clock budget covers the whole sequence.
 */
export async function runControllerVerify(opts: {
	commands?: string[][];
	cwd: string;
	timeoutSec?: number;
	signal?: AbortSignal;
}): Promise<VerifyEvidence> {
	const commands = (opts.commands ?? []).filter((c) => Array.isArray(c) && c.length > 0);
	if (!commands.length) {
		return unsetVerifyEvidence();
	}

	if (opts.signal?.aborted) {
		return {
			status: "aborted",
			commands,
			reason: "aborted before controller verify",
		};
	}

	const budgetSec = Math.max(5, opts.timeoutSec ?? DEFAULT_VERIFY_TIMEOUT_SEC);
	const deadline = Date.now() + budgetSec * 1000;
	const outputs: string[] = [];

	for (const argv of commands) {
		if (opts.signal?.aborted) {
			return {
				status: "aborted",
				commands,
				output: outputs.join("\n").slice(-OUTPUT_CAP),
				reason: "aborted during controller verify",
			};
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			return {
				status: "timeout",
				commands,
				timedOut: true,
				output: outputs.join("\n").slice(-OUTPUT_CAP),
				reason: `controller verify timed out after ${budgetSec}s`,
			};
		}
		const [command, ...args] = argv;
		if (!command) {
			return {
				status: "error",
				commands,
				reason: "empty verify command",
			};
		}
		const stepTimeoutSec = Math.max(1, Math.ceil(remainingMs / 1000));
		let result: Awaited<ReturnType<typeof spawnManagedProcess>>;
		try {
			result = await spawnManagedProcess({
				command,
				args,
				cwd: opts.cwd,
				signal: opts.signal,
				timeoutSec: stepTimeoutSec,
			});
		} catch (err) {
			return {
				status: "error",
				commands,
				output: outputs.join("\n").slice(-OUTPUT_CAP),
				reason: `controller verify spawn failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		const chunk = [
			`$ ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
			result.stdout.trim(),
			result.stderr.trim(),
			`[exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}${result.aborted ? ", aborted" : ""}]`,
		]
			.filter(Boolean)
			.join("\n");
		outputs.push(chunk);

		if (result.aborted) {
			return {
				status: "aborted",
				commands,
				exitCode: result.exitCode,
				output: outputs.join("\n").slice(-OUTPUT_CAP),
				reason: "aborted during controller verify",
			};
		}
		if (result.timedOut) {
			return {
				status: "timeout",
				commands,
				exitCode: result.exitCode,
				timedOut: true,
				output: outputs.join("\n").slice(-OUTPUT_CAP),
				reason: `controller verify timed out: ${argv.join(" ")}`,
			};
		}
		if (result.exitCode !== 0) {
			return {
				status: "failed",
				commands,
				exitCode: result.exitCode,
				output: outputs.join("\n").slice(-OUTPUT_CAP),
				reason: `controller verify failed (exit ${result.exitCode}): ${argv.join(" ")}`,
			};
		}
	}

	return {
		status: "passed",
		commands,
		exitCode: 0,
		output: outputs.join("\n").slice(-OUTPUT_CAP),
	};
}

/** Whether verify evidence authorizes a claimed "done". */
export function verifyAllowsDone(verify: VerifyEvidence | undefined): boolean {
	return verify?.status === "passed";
}
