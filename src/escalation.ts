/**
 * Primary-session escalation heuristics.
 * Suggests (does not force) orchestrate when a task looks long-running.
 */
export interface EscalationSettings {
	/** master switch */
	enabled: boolean;
	/** tool_call count on Primary before suggesting */
	toolCallThreshold: number;
	/** distinct file paths touched */
	distinctPathThreshold: number;
	/** write/edit count */
	writeThreshold: number;
	/** user prompt length (chars) that looks like a long brief */
	promptLengthThreshold: number;
}

export const defaultEscalation: EscalationSettings = {
	enabled: true,
	toolCallThreshold: 20,
	distinctPathThreshold: 8,
	writeThreshold: 5,
	promptLengthThreshold: 400,
};

export interface EscalationStats {
	toolCalls: number;
	writes: number;
	paths: Set<string>;
	suggested: boolean;
}

export function createEscalationStats(): EscalationStats {
	return { toolCalls: 0, writes: 0, paths: new Set(), suggested: false };
}

export function noteToolCall(stats: EscalationStats, toolName: string, input: Record<string, unknown>): void {
	stats.toolCalls++;
	if (toolName === "write" || toolName === "edit") stats.writes++;
	const p = input.path ?? input.file_path ?? input.filePath;
	if (typeof p === "string" && p.trim()) stats.paths.add(p.replace(/\\/g, "/"));
	// bash sometimes embeds paths — skip deep parsing
}

const LONG_HINT =
	/一式|まとめて|全部|全体|移行|リファクタ|リファクタリング|対応して|実装して|作り直|置き換|マルチ|複数|エンドツーエンド|e2e|マイグレーション/i;

export function promptLooksLong(text: string, threshold: number): boolean {
	const t = text.trim();
	if (t.length >= threshold) return true;
	// Short but clearly multi-deliverable / migration style briefs
	if (t.length >= 12 && LONG_HINT.test(t)) return true;
	return false;
}

export function shouldSuggestEscalation(stats: EscalationStats, settings: EscalationSettings): boolean {
	if (!settings.enabled || stats.suggested) return false;
	if (stats.toolCalls >= settings.toolCallThreshold) return true;
	if (stats.paths.size >= settings.distinctPathThreshold) return true;
	if (stats.writes >= settings.writeThreshold) return true;
	return false;
}

export function escalationMessage(stats: EscalationStats): string {
	return [
		"[pi-metaLoop] この作業は長期化の兆候があります。",
		`観測: tool_calls=${stats.toolCalls}, distinct_paths=${stats.paths.size}, writes=${stats.writes}`,
		"認識ズレのコストが大きくなる前に、`orchestrate` ツールで監督付き分業（Orchestrator + Supervisor + Workers/sfh）へ切り替えることを検討してください。",
		"短い確認・議論・1ファイル修正だけならそのままで構いません。",
	].join("\n");
}
