export interface ProcessTreeTerminationStep {
	/** Whether this step is a forced tree termination rather than a soft TERM. */
	force: boolean;
	/** Delay from the start of termination. Zero means run synchronously now. */
	delayMs: number;
}

/**
 * Describe the platform-safe tree termination schedule.
 *
 * A Windows direct-child PID must never be retained for later taskkill use: it
 * can be reused as soon as the child closes. Therefore Windows gets one
 * immediate forced tree kill. POSIX children own a detached process group, so
 * they retain TERM followed by delayed KILL of that owned group.
 */
export function getProcessTreeTerminationSchedule(
	platform: NodeJS.Platform,
	graceMs: number,
): readonly ProcessTreeTerminationStep[] {
	if (platform === "win32") return [{ force: true, delayMs: 0 }];
	return [
		{ force: false, delayMs: 0 },
		{ force: true, delayMs: graceMs },
	];
}
