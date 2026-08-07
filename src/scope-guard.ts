/**
 * Worker scope guard — loaded into implementation-worker subprocesses via `pi -e`.
 *
 * write/edit are path checked. Bash receives a conservative command inspection
 * that understands common shell indirection and direct shell write forms. The
 * runtime additionally takes bounded pre/post filesystem snapshots because no
 * command parser can prove that an arbitrary executable will not write.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkPath } from "./evidence.ts";

function parseList(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
}

const MUTATING = new Set(["write", "edit"]);

const BLOCKED_GIT_SUBCOMMANDS = new Set([
	"add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit",
	"merge", "mv", "push", "rebase", "reset", "restore", "revert", "rm", "stash",
	"switch", "tag", "update-index", "worktree",
]);

/** Unknown git aliases/subcommands fail closed. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame", "cat-file", "check-attr", "check-ignore", "describe", "diff", "for-each-ref",
	"grep", "log", "ls-files", "ls-tree", "merge-base", "name-rev", "rev-list", "rev-parse",
	"show", "show-ref", "status",
]);

const GIT_OPTS_WITH_ARG = new Set([
	"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
]);

interface ShellToken {
	kind: "word" | "op";
	value: string;
}

/** Small quote-aware lexer. It intentionally rejects malformed quoting. */
function lexShell(command: string): { ok: true; tokens: ShellToken[] } | { ok: false; error: string } {
	const tokens: ShellToken[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	const flush = () => {
		if (word !== "") tokens.push({ kind: "word", value: word });
		word = "";
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) {
				quote = null;
			} else if (c === "\\" && quote === '"' && i + 1 < command.length) {
				word += command[++i];
			} else {
				word += c;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			word += command[++i];
			continue;
		}
		if (/\s/u.test(c)) {
			flush();
			if (c === "\n") tokens.push({ kind: "op", value: ";" });
			continue;
		}

		const rest = command.slice(i);
		// Keep fd duplication (2>&1) as one safe redirection token while exposing a
		// standalone `&` as the shell background operator.
		const op = /^(?:\d*(?:>>|>|>\||<<|<)&(?:\d+|-)|&>>|&>|&&|\|\||\d*(?:>>|>|>\||<<|<)|[&;|()])/u.exec(rest)?.[0];
		if (op) {
			flush();
			tokens.push({ kind: "op", value: op });
			i += op.length - 1;
			continue;
		}
		word += c;
	}
	if (quote) return { ok: false, error: "unterminated shell quote" };
	flush();
	return { ok: true, tokens };
}

function executableName(token: string): string {
	let base = path.basename(token.replace(/\\/g, "/")).toLowerCase();
	if (base.endsWith(".exe")) base = base.slice(0, -4);
	return base;
}

function shellSegments(tokens: ShellToken[]): ShellToken[][] {
	const out: ShellToken[][] = [];
	let current: ShellToken[] = [];
	for (const token of tokens) {
		if (token.kind === "op" && (token.value === ";" || token.value === "|" || token.value === "&&" || token.value === "||")) {
			if (current.length) out.push(current);
			current = [];
		} else {
			current.push(token);
		}
	}
	if (current.length) out.push(current);
	return out;
}

function commandWords(segment: ShellToken[]): string[] {
	const words: string[] = [];
	for (let i = 0; i < segment.length; i++) {
		const token = segment[i];
		if (token.kind === "op" && /^\d*(?:>|>>|<|<<|>\|)&(?:\d+|-)$/u.test(token.value)) {
			continue; // fd duplication/closure has no following target token
		}
		if (token.kind === "op" && /^(?:\d*>|\d*>>|\d*>\||&>|&>>)$/u.test(token.value)) {
			i += 1; // redirection target
			continue;
		}
		if (token.kind === "word") words.push(token.value);
	}
	return words;
}

function stripCommandPrefixes(input: string[]): string[] {
	let words = [...input];
	while (words.length) {
		while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) words.shift();
		const exe = executableName(words[0] ?? "");
		if (exe === "env") {
			words.shift();
			while (words.length) {
				if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0])) words.shift();
				else if (words[0] === "-u" || words[0] === "--unset") words.splice(0, 2);
				else if (words[0].startsWith("-")) words.shift();
				else break;
			}
			continue;
		}
		if (exe === "sudo") {
			words.shift();
			while (words[0]?.startsWith("-")) {
				const option = words.shift();
				if (option === "-u" || option === "-g" || option === "-h" || option === "-p") words.shift();
			}
			continue;
		}
		if (exe === "command" || exe === "exec") {
			words.shift();
			while (words[0]?.startsWith("-")) words.shift();
			continue;
		}
		break;
	}
	return words;
}

function hasEnvSplitPrefix(input: string[]): boolean {
	let words = [...input];
	while (words.length) {
		while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) words.shift();
		const exe = executableName(words[0] ?? "");
		if (exe === "sudo") {
			words.shift();
			while (words[0]?.startsWith("-")) {
				const option = words.shift();
				if (option === "-u" || option === "-g" || option === "-h" || option === "-p") words.shift();
			}
			continue;
		}
		if (exe === "command" || exe === "exec") {
			words.shift();
			while (words[0]?.startsWith("-")) words.shift();
			continue;
		}
		if (exe !== "env") return false;
		words.shift();
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (/^(?:-S|--split-string(?:=|$))/u.test(word)) return true;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue;
			if (word === "-u" || word === "--unset") { i += 1; continue; }
			if (word.startsWith("-")) continue;
			words = words.slice(i);
			break;
		}
	}
	return false;
}

function gitWordsAreBlocked(input: string[]): boolean {
	const words = stripCommandPrefixes(input);
	if (executableName(words[0] ?? "") !== "git") return false;
	let i = 1;
	while (i < words.length) {
		const token = words[i];
		if (token === "--") { i += 1; break; }
		if (GIT_OPTS_WITH_ARG.has(token)) { i += 2; continue; }
		if (/^-[Cc].+/u.test(token) || token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
			i += 1;
			continue;
		}
		if (token.startsWith("-")) { i += 1; continue; }
		break;
	}
	if (i >= words.length) return true; // ambiguous `git` may invoke configured help/alias behaviour
	const subcommand = words[i].toLowerCase();
	return BLOCKED_GIT_SUBCOMMANDS.has(subcommand) || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

function nestedCommand(wordsInput: string[]): string | null {
	const words = stripCommandPrefixes(wordsInput);
	const exe = executableName(words[0] ?? "");
	if (["sh", "bash", "dash", "zsh", "ksh"].includes(exe)) {
		const at = words.findIndex((w, i) => i > 0 && (w === "-c" || w === "-lc" || w === "-ic"));
		return at >= 0 ? words[at + 1] ?? "" : null;
	}
	if (exe === "cmd") {
		const at = words.findIndex((w, i) => i > 0 && (w.toLowerCase() === "/c" || w.toLowerCase() === "/k"));
		return at >= 0 ? words.slice(at + 1).join(" ") : null;
	}
	if (exe === "powershell" || exe === "pwsh") {
		const at = words.findIndex((w, i) => i > 0 && ["-c", "-command"].includes(w.toLowerCase()));
		return at >= 0 ? words.slice(at + 1).join(" ") : null;
	}
	return null;
}

function hasBlockedGit(command: string, depth = 0): boolean {
	if (depth > 8) return true;
	// Command substitution can synthesize an executable or hide a second command;
	// the small guard parser cannot prove it read-only, so fail closed.
	if (command.includes("$(") || command.includes("`")) return true;
	const lexed = lexShell(command);
	if (!lexed.ok) return true;
	for (const segment of shellSegments(lexed.tokens)) {
		const words = commandWords(segment);
		if (gitWordsAreBlocked(words)) return true;
		const nested = nestedCommand(words);
		if (nested !== null && hasBlockedGit(nested, depth + 1)) return true;
	}
	return false;
}

/** Detect git state mutation, including git.exe/env/shell/cmd indirection. */
export function isBlockedGitBashCommand(command: string): boolean {
	return command.trim() !== "" && hasBlockedGit(command);
}

export interface BashInspection {
	ok: boolean;
	reason?: string;
}

const DETACH_COMMANDS = new Set([
	// POSIX shell/job/session detachment and service/scheduler submission.
	"nohup", "setsid", "disown", "bg", "coproc", "daemon", "daemonize", "systemd-run", "at", "batch",
	// Windows process/job launch equivalents (including PowerShell cmdlets).
	"start", "start-process", "start-job", "start-threadjob", "schtasks", "wmic", "wscript", "cscript", "mshta",
]);

const SCRIPT_EXTENSIONS = /\.(?:sh|bash|dash|zsh|ksh|fish|cmd|bat|ps1|py|pyw|js|mjs|cjs|ts|mts|cts)$/iu;

function isDirectScriptExecutable(token: string): boolean {
	return SCRIPT_EXTENSIONS.test(token);
}

function safeSink(target: string): boolean {
	const t = target.toLowerCase();
	return t === "/dev/null" || t === "nul" || t === "nul:" || /^&\d+$/u.test(t);
}

function inspectWriteTarget(target: string, cwd: string, allowed: string[], forbidden: string[]): string | null {
	if (!target) return "missing redirection/write target";
	if (safeSink(target)) return null;
	if (/[`$%]/u.test(target)) return `dynamic shell write target cannot be scope-checked: ${target}`;
	const result = checkPath(target, cwd, allowed, forbidden);
	return result.ok ? null : result.reason;
}

/**
 * Conservative implementation-worker bash inspection. Obvious shell writes are
 * path checked; dynamic evaluation, detached launchers, and arbitrary interpreter
 * scripts are blocked. Explicit validation/test modes remain usable and the
 * runtime filesystem monitor independently checks synchronous writes.
 */
export function inspectBashCommand(
	command: string,
	cwd: string,
	allowed: string[],
	forbidden: string[],
	depth = 0,
): BashInspection {
	if (depth > 8) return { ok: false, reason: "shell indirection depth limit exceeded" };
	if (!command.trim()) return { ok: true };
	if (allowed.length === 0) return { ok: false, reason: "native implementation worker has empty allowed_scope" };
	if (command.includes("$(") || command.includes("`")) {
		return { ok: false, reason: "dynamic command substitution is not allowed from worker bash" };
	}
	const lexed = lexShell(command);
	if (!lexed.ok) return { ok: false, reason: lexed.error };
	if (lexed.tokens.some((token) => token.kind === "op" && token.value === "&")) {
		return { ok: false, reason: "background/detached shell execution with '&' is not allowed" };
	}

	for (const segment of shellSegments(lexed.tokens)) {
		const words = commandWords(segment);
		if (hasEnvSplitPrefix(words)) {
			return { ok: false, reason: "env split-string command indirection cannot be scope-checked" };
		}
		if (gitWordsAreBlocked(words)) return { ok: false, reason: "blocked git state-changing command" };
		const stripped = stripCommandPrefixes(words);
		const exe = executableName(stripped[0] ?? "");
		if (DETACH_COMMANDS.has(exe)) {
			return { ok: false, reason: `delayed/detached process launcher is not allowed: ${exe}` };
		}
		if (isDirectScriptExecutable(stripped[0] ?? "")) {
			return { ok: false, reason: `direct script execution cannot be monitored fail-closed: ${stripped[0]}` };
		}
		if (/[\s\$%`]/u.test(stripped[0] ?? "")) {
			return { ok: false, reason: "dynamic shell executable cannot be scope-checked" };
		}
		if (exe === "eval" || exe === "source" || exe === ".") {
			return { ok: false, reason: `dynamic shell evaluator is not allowed: ${exe}` };
		}
		const isPython = exe === "py" || /^python(?:\d+(?:\.\d+)*)?$/u.test(exe);
		const isNode = exe === "node" || exe === "nodejs";
		if (isNode || isPython) {
			const args = stripped.slice(1);
			const hasInlineEval = args.some((w) =>
				isPython
					? w === "-c" || w.startsWith("-c=") || (w.startsWith("-c") && w.length > 2)
					: w === "-e" || w.startsWith("-e=") || (w.startsWith("-e") && w.length > 2) ||
						w === "--eval" || w.startsWith("--eval=") || w === "-p" || w === "--print",
			);
			const usesStdinProgram = args.length === 0 || args.includes("-") || segment.some((t) => t.kind === "op" && t.value === "<<");
			if (hasInlineEval || usesStdinProgram) {
				return { ok: false, reason: `inline ${exe} code is not allowed from worker bash; use a scoped file` };
			}
			const loadsHook = args.some((w) =>
				["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(w) ||
				/^(?:--require|--import|--loader|--experimental-loader)=/u.test(w),
			);
			if (loadsHook) {
				return { ok: false, reason: `${exe} preload hooks cannot be monitored fail-closed` };
			}
			const informational = args.some((w) => ["-v", "-V", "--version", "-h", "--help"].includes(w));
			if (isPython && !informational) {
				return { ok: false, reason: `python script/module execution cannot be monitored fail-closed` };
			}
			const hasProgramTarget = args.some((w) => !w.startsWith("-"));
			const safeNodeMode = informational || args.includes("--test") ||
				((args.includes("--check") || args.includes("-c")) && hasProgramTarget);
			if (isNode && !safeNodeMode) {
				return { ok: false, reason: `node script/stdin execution cannot be monitored fail-closed` };
			}
		}

		const shellInterpreter = ["sh", "bash", "dash", "zsh", "ksh"].includes(exe);
		if (shellInterpreter && nestedCommand(words) === null) {
			const args = stripped.slice(1);
			const informational = args.some((w) => ["--version", "--help"].includes(w));
			const syntaxOnly = args.includes("-n") && args.some((w) => !w.startsWith("-"));
			if (!informational && !syntaxOnly) {
				return { ok: false, reason: `shell script/stdin execution cannot be monitored fail-closed: ${exe}` };
			}
		}
		const nested = nestedCommand(words);
		if (exe === "powershell" || exe === "pwsh") {
			const lowerArgs = stripped.slice(1).map((w) => w.toLowerCase());
			if (lowerArgs.some((w) => ["-encodedcommand", "-enc", "-file", "-f"].includes(w))) {
				return { ok: false, reason: "PowerShell encoded/script execution cannot be monitored fail-closed" };
			}
			if (nested === null && !lowerArgs.some((w) => ["-help", "--help", "-version", "--version"].includes(w))) {
				return { ok: false, reason: "PowerShell script/stdin execution cannot be monitored fail-closed" };
			}
		}
		if (exe === "cmd" && nested === null) {
			return { ok: false, reason: "cmd script/interactive execution cannot be monitored fail-closed" };
		}
		if (nested !== null) {
			if (!nested.trim()) return { ok: false, reason: "shell indirection has an empty/dynamic command" };
			const inner = inspectBashCommand(nested, cwd, allowed, forbidden, depth + 1);
			if (!inner.ok) return inner;
		}

		for (let i = 0; i < segment.length; i++) {
			const token = segment[i];
			if (token.kind === "op" && /^\d*(?:>|>>|<|<<|>\|)&(?:\d+|-)$/u.test(token.value)) continue;
			if (token.kind !== "op" || !/^(?:\d*>|\d*>>|\d*>\||&>|&>>)$/u.test(token.value)) continue;
			const target = segment[i + 1];
			if (!target || target.kind !== "word") {
				return { ok: false, reason: "dynamic or malformed shell redirection target" };
			}
			const targetError = inspectWriteTarget(target.value, cwd, allowed, forbidden);
			if (targetError) return { ok: false, reason: targetError };
		}

		if (exe === "tee") {
			let optionMode = true;
			for (const target of stripped.slice(1)) {
				if (optionMode && target === "--") { optionMode = false; continue; }
				if (optionMode && target.startsWith("-")) continue;
				optionMode = false;
				const targetError = inspectWriteTarget(target, cwd, allowed, forbidden);
				if (targetError) return { ok: false, reason: targetError };
			}
		}
	}
	return { ok: true };
}

export default function (pi: ExtensionAPI) {
	const cwd = process.env.PI_META_LOOP_CWD || process.cwd();
	const allowed = parseList(process.env.PI_META_LOOP_ALLOWED_SCOPE);
	const forbidden = parseList(process.env.PI_META_LOOP_FORBIDDEN);

	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			const input = event.input as Record<string, unknown>;
			const command = String(input.command ?? input.cmd ?? "");
			const result = inspectBashCommand(command, cwd, allowed, forbidden);
			if (!result.ok) {
				return { block: true, reason: `pi-meta-loop scope guard: ${result.reason}` };
			}
			return;
		}

		if (!MUTATING.has(event.toolName)) return;
		if (allowed.length === 0) {
			return { block: true, reason: "pi-meta-loop scope guard: native implementation worker has empty allowed_scope" };
		}
		const input = event.input as Record<string, unknown>;
		const filePath = String(input.path ?? input.file_path ?? "");
		if (!filePath) {
			return { block: true, reason: "pi-meta-loop scope guard: mutating tool path missing" };
		}
		const result = checkPath(filePath, cwd, allowed, forbidden);
		if (!result.ok) return { block: true, reason: `pi-meta-loop scope guard: ${result.reason}` };
	});
}
