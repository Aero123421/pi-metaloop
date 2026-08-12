# Changelog

## [Unreleased]

## [0.3.0-rc.2] - 2026-08-12

### Fixed

- Filesystem evidence no longer recurses below cwd's parent by default. Scanning three levels
  down made every sibling repository part of every ticket's evidence, and past 250,000 entries
  the ticket failed outright. Direct parent entries still catch `../file` writes.
- Dependency, build, and cache trees (`node_modules`, `target`, `.next`, …) are recorded but not
  traversed. A language server or dev server writing there was reported as a scope violation.
- git evidence no longer accuses a scoped native Worker of moving HEAD or the index. Those
  Workers have no shell and cannot run git; such a change is external interference and leaves
  the ticket `partial`, not `failed`.
- Snapshot coverage failures are likewise attributed as environment failures rather than Worker
  faults.
- Worktree file hashing is size-capped. `git status --untracked-files=all` can list large
  un-ignored artifacts, and each was read whole, twice per ticket.
- A verify failure that was already failing when the run started is recorded `partial` with
  `verify.preExisting` instead of `failed`, so a repository that began red no longer cascades
  into consecutive-failure stops. This never authorizes `done`.
- An aborted verify is inconclusive rather than a ticket failure, including in final verify mode.
- A final-review `yellow` is recorded as findings. There is no execution loop left after the
  final audit, so revising there produced tickets that could never run.
- `loadRole` fails closed. A missing `agents/*.md` previously ran a plain coding agent with
  write/edit tools and none of the role's constraints.
- Losing the owner lock no longer has its `stopped` record overwritten with `running`.
- Idle sessions stop re-reading and re-parsing the last board roughly 75 times a minute, while
  still painting once on the transition so the last panel does not stay on screen.
- Exhausting the mid-run audit budget no longer leaves the auto-trigger latched, which turned the
  execute loop into a busy loop that starved the event loop and blocked the abort signal.
- `/ml-doctor` distinguishes "sfh not on PATH" from "sfh installed but misbehaving"; both used to
  report as not installed.
- Owner-lock heartbeats are throttled to 15s within their 60s lease; two 800ms timers were each
  performing a guarded atomic rewrite.
- `escalation` settings are validated and clamped like every other config section.
- Long-task detection recognizes English phrasing; the keyword heuristic was Japanese-only.

### Added

- `executor.verifyMode: "final"` runs the trusted verify once after the execute loop and promotes
  the tickets that claimed `done`, for plans whose intermediate tickets cannot leave the tree
  green on their own.
- A verify baseline is captured before the first ticket. The Supervisor's board now carries the
  verify verdict (`status`, `preExisting`, `baselineStatus`, `inconclusive`), which it was being
  asked to judge from without ever receiving it.
- The write-scope ceiling is included in the planning and revision prompts, so the Orchestrator
  can comply with it instead of discovering it as a blocked ticket.
- `limits.scopeCeiling` bounds every ticket's `allowed_scope`, so the write surface is no longer
  chosen entirely by model output.
- `limits.maxSupervisions` bounds mid-run audits; tickets blocked by one root cause now share a
  single audit. Initial and final audits always run.
- `evidence.*` settings for the sweep's ignore list, parent depth, and caps (user/base layers only).
- `executor.sfhIntegrateTool` sets the integrate step's tool explicitly; inference from a model
  id is now reported on the ticket when it happens.
- `orchestrate` warns at startup when no trusted verify is configured or when unsupported sfh
  `write`/`full` access is set.
- Role subprocess token and cost usage is aggregated and persisted.
- Run directories are pruned to the newest 20.
- `/tasks <ticket-id>` for drill-down; the plain command no longer opens a picker.
- `npm run docs:check` keeps README.md and README.ja.md from drifting apart.
- Supervisor `optional_advice`, `risk`, and `harness_suggestions` reach the final summary; they
  were collected and persisted but shown to nobody.

### Changed

- Project config can no longer choose role models. Opt in with `allowProjectModelOverride` in
  user config.
- Role definitions, inspection criteria, and runtime strings are in English; each role is told to
  answer in the user's language. Japanese documentation remains in `README.ja.md` and the skill.
- SFH is documented as an optional dependency needed only for group tickets, and `/ml-doctor`
  reports its absence as information rather than a warning.
- `orchestrate` is not registered when meta-loop is disabled; commands including `/ml-doctor`
  remain available so a user can find out why.
- `limits.concurrency` is removed. It was accepted, clamped, and never read.
- Tests are covered by `tsc --noEmit`.
- `DESIGN.md` is English, with the Japanese version kept as `DESIGN.ja.md`; CONTRIBUTING routes
  contributors to it.
- `examples/` ships in the package, and both examples were corrected: the project example
  demonstrated a role model that project layers can no longer set, and the user example defined
  verify profiles without selecting one — leaving a config where no ticket can reach `done`.
- The mid-run audit budget counts real Supervisor calls rather than triggers; one trigger could
  previously spend a whole re-audit cycle against a single unit of budget.

### Security

- `checkPath` resolves symlinks explicitly, including **dangling** ones. `existsSync` follows the
  link, so a committed link whose target did not yet exist read as "missing", the walk continued
  past it to the real parent, and an in-scope-looking write landed wherever the link pointed.
  Pre-existing; found while verifying that the scope guard actually carries the enforcement
  weight this release moves onto it.
- An empty `limits.scopeCeiling` is deny-all rather than "no ceiling". Narrowing produces `[]`
  when layers disagree, so the previous reading let an untrusted project layer switch the control
  off by simply disagreeing with it.
- Scope-ceiling validation proves rule containment instead of matching the requested glob text as
  a path; `src/**` can no longer pass through a narrower `src/*` ceiling.
- Project config cannot change `limits.maxSupervisions` in either direction; both cost and
  supervision policy remain owned by user config. Required re-audits also consume the same hard
  upper bound and fail closed when it is exhausted.
- `evidence.*` is user/base only. Narrowing weakens detection; widening lets an untrusted
  repository force a ten-minute synchronous sweep twice per ticket and pull unrelated sibling
  paths into the Supervisor's prompt.
- Inconclusive outcomes no longer read as progress. Because `partial` counts as success, the new
  attribution downgrades were resetting the consecutive-failure counter and skipping trigger
  evaluation — so a permanently red baseline or a broken snapshot let the harness walk an entire
  plan without ever raising an audit.
- SECURITY.md and both READMEs state that approving a verify profile authorizes running the
  target repository's own code: the profile fixes the command, not the payload behind it.
- README.ja.md's security section reached parity with README.md. It had been three lines and
  claimed nesting recursion was "structurally impossible" where the English text correctly says
  the guard is not a hostile boundary.

## [0.3.0-rc.1] - 2026-08-11

### Added

- User-approved verify profiles, project profile selection, and `/ml-doctor` diagnostics.
- SFH schema-v1 preflight/run envelope validation with direct run ID and run directory capture.
- Versioned config and persisted-board contracts, release checks, package allowlist, and cross-platform CI.

### Fixed

- `sfhAllowedTools`: omitted is unrestricted; `[]` is explicit deny-all across code, templates, and docs.
- Package, lockfile, Node, peer dependency, and README release metadata now agree.
- macOS temporary-directory canonicalization in the flow containment test.
- Process-heavy test files run serially to avoid cross-suite owner-lock timing flakes.

### Security

- Project config cannot introduce verify profiles or argv; unknown profiles fail closed.
- Unknown SFH machine schemas and malformed envelopes fail closed.
- Malformed or unsupported-version config files disable meta-loop instead of being silently ignored.

## [0.2.6] - 2026

### Security

- Scoped native Workers receive no bash at all. Per-command shell denylists do not converge, so
  the tool is not granted and the `tool_call` gate refuses it unconditionally.
- Native Workers start with `--no-extensions` and only the harness scope guard, so project or
  user extensions cannot reintroduce tools.
- Build and test moved to controller-side trusted deterministic verify; unset, failed, or timed
  out verify forbids a native `done`.
- sfh `write`/`full` is refused without an OS sandbox; groups are read-only review.
- Closed symlink-ancestor scope escapes and protected the `.git` control plane.
- Removed bash write side channels via `awk`, `find`, `sort`, `yq`, `diff`, `rg`, `git`, and
  `less`.

### Fixed

- `allowed_scope` globstar matching (`crates/**/tests/**`) now admits the trailing directory
  itself, removing false scope violations on security test directories.

## [0.2.5] - 2026

### Added

- Compact mid-run review board, persisted `verdictHistory`, shorter Orchestrator plan slices,
  `/tasks` drill-down, and a user-level sfh `full` ceiling.

## [0.2.4] - 2026

### Fixed

- Scope evidence uses the ticket delta only, so a previous ticket's uncommitted work is no longer
  attributed to the current one.
- sfh panel shows live or recently finished runs only; `STOP` file unlock; `force` orchestrate;
  integrate access and tool selection.

## [0.2.3] - 2026

### Added

- Unified colored TUI panel for meta-loop and sfh, detail modes, auto-hide for finished runs, and
  a spinner footer.

## [0.2.2] - 2026

### Fixed

- `plan_failed` and `incomplete` terminal semantics so a run never reports a false `done`.
- Plan retry with raw attempt logs; frozen elapsed time after completion.

## [0.2.1] - 2026

### Added

- Background `orchestrate`, TUI widget, board persistence, and role tasks on stdin (fixes Windows
  `ENAMETOOLONG`).

## [0.2.0-alpha] - 2026

### Added

- Initial capability boundaries: per-role tool allowlists, config layering with project-only
  narrowing, sfh access levels, allowed_scope guard, and soft long-task escalation.
