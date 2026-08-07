import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectBashCommand } from "../src/scope-guard.ts";

describe("implementation-worker detached write guard", () => {
	const cwd = process.cwd();
	const inspect = (command: string) => inspectBashCommand(command, cwd, ["src/**", "test/**"], []);

	it("tokenizes and rejects the single-& background operator without breaking fd duplication", () => {
		for (const command of [
			"printf late > src/later.ts &",
			"printf late > src/later.ts&",
			"tool & disown",
			"sh -c 'printf late > src/later.ts &'",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /background|detach/i, command);
		}
		assert.equal(inspect("tool 2>&1").ok, true);
		assert.equal(inspect("tool >&2").ok, true);
		assert.equal(inspect("printf '&' > src/literal.txt").ok, true);
	});

	it("rejects POSIX session, job, daemon, and scheduler launchers through prefixes/nesting", () => {
		for (const command of [
			"nohup tool > src/later.ts",
			"env FLAG=1 nohup tool",
			"env -S 'nohup tool'",
			"command setsid tool",
			"sudo disown -h %1",
			"bg %1",
			"coproc tool",
			"daemonize tool",
			"systemd-run --user tool",
			"sh -c 'setsid tool'",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /launcher|detach|background|indirection/i, command);
		}
	});

	it("rejects Windows start/process/job equivalents through cmd and PowerShell", () => {
		for (const command of [
			'cmd /c "start /b tool"',
			"cmd.exe /c start '' /min tool",
			"powershell -Command 'Start-Process tool'",
			"pwsh -c 'Start-Job { tool }'",
			"start-threadjob tool",
			"schtasks /create /tn delayed /tr tool",
			"wscript scripts/later.js",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /launcher|detach|script/i, command);
		}
	});

	it("fails closed for arbitrary interpreter/script indirection but keeps direct validation usable", () => {
		for (const command of [
			"node scripts/later.js",
			"node --require scripts/hook.js --test test/unit.test.js",
			"python scripts/later.py",
			"python -m scripts.later",
			"bash scripts/later.sh",
			"./scripts/later.sh",
			"cmd /c scripts/later.cmd",
			"powershell -File scripts/later.ps1",
			"powershell -EncodedCommand ZQBjAGgAbwAgAHgA",
			"bash -s",
			"node --input-type=module",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /script|module|hook|fail-closed/i, command);
		}
		assert.equal(inspect("node --test test/unit.test.js").ok, true);
		assert.equal(inspect("node --check src/check.js").ok, true);
		assert.equal(inspect("bash -n scripts/check.sh").ok, true);
		assert.equal(inspect("npm test").ok, true);
	});
});
