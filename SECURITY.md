# Security

## Supported versions

Security fixes are provided for the latest release candidate or stable release.

## Reporting

Please use GitHub private vulnerability reporting for this repository. Do not include API keys, prompts containing secrets, or private run artifacts in a public issue.

## Trust boundary

pi-meta-loop runs `pi`, configured controller verify commands, and SFH with the current user's OS permissions. Native Workers receive only interceptable built-in tools and cannot use bash. SFH groups are read-only unless a future OS sandbox can enforce scoped writes.

Role subprocesses inherit the host environment because model CLIs need provider credentials. Run artifacts may contain prompts, paths, model output, and command output; `.pi/meta-loop/` is ignored by Git, but remains local sensitive data. Run directories are pruned to the newest 20. `/ml-doctor` does not print environment values.

Project config and standards are untrusted inputs. Project config may narrow capabilities and select a user-approved verify profile, but cannot add verify argv, raise SFH access, replace the SFH binary, expand tool allowlists, or choose role models (`allowProjectModelOverride` is an explicit user opt-in).

## Approving a verify profile runs the target repository's code

This is the sharpest edge in the design, so it is stated plainly.

`executor.verifyProfiles` constrains the **command**, not what that command executes. A profile
of `["npm", "test"]` runs whatever the repository under `cwd` defines in its `package.json` and
its test files. The rule that a project config cannot *introduce* verify argv prevents privilege
escalation between config layers; it does not make the executed code trustworthy, because the
payload was always the repository's to define.

Practical consequences:

- Treat a configured verify profile the way you treat running that repository's test suite by
  hand. Do not enable one for a repository you would not run tests in.
- Prefer per-project selection (`executor.verifyProfile` in `<project>/.pi/meta-loop/config.json`)
  over a global `executor.verifyCommands` that applies everywhere you open a shell.
- Verify runs only during a supervised run, only after a Worker finishes, and once as a baseline
  before the first ticket. It does not run in ordinary conversation.
- `/ml-doctor` shows the effective argv and which config layer allowed it, before you start.

## Write scope

`allowed_scope` originates from the Orchestrator's plan, which is model output. Set
`limits.scopeCeiling` in user config to bound it; a ticket whose scope is not provably inside the
ceiling is blocked before it runs.

Post-hoc git and filesystem evidence is a detection backstop, not the enforcement mechanism. The
scope guard refuses out-of-scope `write`/`edit` at tool-call time, which is what actually stops a
Worker. The evidence sweep therefore skips dependency and build trees and does not recurse into
sibling projects: doing so produced violations no Worker caused, which is worse than the small
amount of detection it added.

## Nesting

Child processes carry `PI_META_LOOP_DEPTH >= 1` and this extension registers nothing on that
path. This prevents accidental re-orchestration. It is **not** a hostile boundary against a
process that can clear its environment and spawn arbitrary binaries — scoped native Workers have
no bash by default, which is the control that matters there.

Known limitations are maintained in [DESIGN.md](./DESIGN.md).
