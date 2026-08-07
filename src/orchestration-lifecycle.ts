export type SettlementWaitOutcome = "settled" | "timed_out";

export interface AbortWaitDecision {
	settled: boolean;
	retainActive: boolean;
	retainOwnerLock: boolean;
	canStartReplacement: boolean;
}

/**
 * Pure lifecycle policy for a bounded abort wait.
 * A timeout is not settlement: the old run remains the active lock owner and
 * must prevent a replacement until its own finally block completes.
 */
export function decideAbortWait(outcome: SettlementWaitOutcome): AbortWaitDecision {
	const settled = outcome === "settled";
	return {
		settled,
		retainActive: !settled,
		retainOwnerLock: !settled,
		canStartReplacement: settled,
	};
}

/** Wait at most timeoutMs for fulfillment or rejection, without leaking a timer. */
export async function waitForSettlement(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<SettlementWaitOutcome> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => "settled" as const,
				() => "settled" as const,
			),
			new Promise<SettlementWaitOutcome>((resolve) => {
				timeout = setTimeout(() => resolve("timed_out"), Math.max(0, timeoutMs));
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
