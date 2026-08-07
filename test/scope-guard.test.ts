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
			assert.match(result.reason ?? "", /background|detach|allowlist/i, command);
		}
		assert.equal(inspect("printf ok 2>&1").ok, true);
		assert.equal(inspect("printf ok >&2").ok, true);
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
			assert.match(result.reason ?? "", /launcher|detach|background|indirection|allowlist/i, command);
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
			assert.match(result.reason ?? "", /launcher|detach|script|allowlist/i, command);
		}
	});

	it("fails closed for arbitrary interpreter/script/runner indirection", () => {
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
			"node --test test/unit.test.js",
			"node --check src/check.js",
			"bash -n scripts/check.sh",
			"npm test",
			"pnpm test",
			"yarn test",
			"npx eslint .",
			"make test",
			"cargo test",
			"pytest",
			"jest",
			"vitest",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /script|module|hook|fail-closed|allowlist|--test/i, command);
		}
		// Read-only allowlist remains usable.
		assert.equal(inspect("ls src").ok, true);
		assert.equal(inspect("git status").ok, true);
		assert.equal(inspect("rg TODO src").ok, true);
	});

	it("denies non-allowlisted writers that would bypass redirection scope checks", () => {
		for (const command of [
			"touch ../../escaped",
			"cp src/a.ts ../../escaped",
			"mv src/a.ts ../../escaped",
			"rm -rf src/a.ts",
			"mkdir ../../escaped-dir",
			"dd if=/dev/zero of=../../escaped bs=1 count=1",
			"install -m 644 src/a.ts ../../escaped",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /allowlist/i, command);
		}
	});

	it("fails closed on awk system(), find -delete, and other code-exec/delete tools", () => {
		for (const command of [
			`awk 'BEGIN { system("git commit --allow-empty -m bypass") }'`,
			`awk 'BEGIN { system("setsid sleep 600 >/tmp/ml-child 2>&1 &") }'`,
			"find .pi/meta-loop/runs -name owner.lock.json -delete",
			"find . -name '*.ts' -exec rm {} ;",
			"sed -i s/a/b/ src/x.ts",
			"sed 's/a/b/' src/x.ts",
		]) {
			const result = inspect(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /allowlist/i, command);
		}
	});

	it("blocks writes into reserved .pi/meta-loop even when allowed_scope is broad", () => {
		const broad = (command: string) => inspectBashCommand(command, cwd, ["**"], []);
		const result = broad("printf x > .pi/meta-loop/runs/owner.lock.json");
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /reserved|forbidden|meta-loop/i);
	});

	it("blocks writes into reserved .git even when allowed_scope is broad", () => {
		const broad = (command: string) => inspectBashCommand(command, cwd, ["**"], []);
		for (const command of [
			"printf x > .git/config",
			"printf deadbeef > .git/refs/heads/other-branch",
			"printf '#!/bin/sh' > .git/hooks/pre-commit",
		]) {
			const result = broad(command);
			assert.equal(result.ok, false, command);
			assert.match(result.reason ?? "", /reserved|forbidden|\.git/i, command);
		}
	});
});
