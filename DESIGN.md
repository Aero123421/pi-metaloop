# DESIGN — pi-meta-loop

日本語版は [DESIGN.ja.md](./DESIGN.ja.md)。

## What this is

A **fail-closed supervision harness** for long tasks. Instead of taking the model's word for it,
the harness looks at evidence: process exit, git state, filesystem state, and a controller-side
verify it runs itself.

The judgment is still a model call — the Supervisor. What is deterministic is everything around
it: trigger conditions, fail-closed JSON parsing, evidence collection, the verify gate, and the
capability boundaries.

## Capability boundaries

| Role | Default tools |
|----|------------------|
| Orchestrator | read, ls, find, grep (**no bash**) |
| Supervisor | read, ls, find, grep (**no bash**) |
| Worker | read, write, edit, ls, find, grep (**no bash**; interceptable built-ins only) |

- A project layer may only **narrow** what user/default config grants. It cannot expand tool
  allowlists, introduce verify argv, or **choose role models** (unless user config sets `allowProjectModelOverride`). Evidence bounds are user-only in
  both directions.
- A native Worker's effective tools are the strict intersection with `WORKER_TOOLS`. It launches
  with `--no-extensions` plus the scope guard only, and the `tool_call` guard refuses bash
  unconditionally.
- With `limits.scopeCeiling` set, a ticket's `allowed_scope` must be **provably** inside it (`**`
  and a bare `*.ts` are rejected). Unset, the write surface is chosen by the plan — model output.
- Scope enforcement happens at tool-call time in the guard. `checkPath` resolves symlinks
  explicitly, including dangling ones, so a link inside the scope cannot redirect a write outside
  it.

## Completion

`WorkerClaim` (self-report) and `ExecutionEvidence` (exit + git + filesystem + controller verify)
are kept separate; the harness decides the final status.

Completion is two facts, reported separately. A ticket is `completed` when the evidence says it did
its work. A **run** is `verified` only when the controller's verify actually ran and passed
(`board.verification`). Verify can take a ticket down only when it ran and found a regression
belonging to that ticket; unset, aborted, or already-red-at-baseline make the run `unverified` with
the reason, and nothing unchecked is ever reported as verified.

### Attribution

`failed` means **the ticket's own execution is at fault**. Everything below is `partial` with
`evidence.inconclusive` — never `done`, but not charged to the ticket either:

- a pre- or post-run snapshot could not complete (coverage limit, timeout)
- HEAD or the index moved during a shell-less native Worker's run (external interference)
- verify was aborted
- verify failed on a command that was **already failing in the run-start baseline**
  (`verify.preExisting`)

Without this distinction the consecutive-failure trigger misfires and stops a run that never went
wrong. Inconclusive is also not progress: it does not reset the failure counter, and a dependent
ticket does not treat it as a satisfied prerequisite.

A scope violation or a non-zero exit is always the ticket's own problem, whatever else went wrong
at the same time.

### When verify runs

- `executor.verifyMode: "per-ticket"` (default) — full sequence after each native ticket.
- `executor.verifyMode: "final"` — once after the execute loop, promoting the tickets that
  claimed `done`. For plans whose intermediate tickets cannot leave the tree green alone.
- A baseline runs once before the first ticket and is included in the Supervisor's evidence view
  as `verify.baselineStatus`.

## Auditing

- Initial and final audits get the **full ticket JSON** (acceptance / scope / claim / evidence,
  including the verify verdict). Mid-run audits get a **compact board** and no
  standards section, deliberately, to keep a triggered check cheap.
- The initial audit is **fail-closed**: invalid JSON or a non-zero exit means execution does not
  start.
- blocked / out-of-scope triggers an immediate re-audit, but tickets blocked by one root cause
  share a single audit.
- Mid-run audits are bounded by `limits.maxSupervisions`, counting real Supervisor calls. Initial
  and final audits are never budgeted. When the budget runs out the trigger state is still
  cleared — otherwise the auto-trigger latches and the execute loop spins.
- **A final yellow does not revise.** The execute loop is over, so any pending ticket a revision
  produced could never run; it is recorded as findings instead. `red` still stops.
- The tool `content` returned to the Primary is `buildPrimarySummary` (changed files, tests,
  unresolved, Supervisor advice).

## Evidence sweep

`.git` has its own control-plane snapshot. The filesystem snapshot covers:

- cwd, recursively, skipping `evidence.ignoreDirNames` (those directories are **recorded** so
  their creation and deletion stay visible, but not descended into)
- cwd's parent, **direct entries only** by default (`evidence.parentMaxDepth`)

Dependency, build, and cache trees and sibling projects are left out because writes there are not
the ticket's doing — attributing them produced violations no Worker caused. Real enforcement is
the scope guard at tool-call time; this sweep is a detection backstop.

## Configuration

`default → repo → user → legacy project → project folder`. The folder form wins over the legacy
one. Standards prefer higher-priority layers within the size cap. A layer that fails to load
disables meta-loop and the reason is reported by `/ml-doctor`.

## UX / execution model

- **In the TUI, `orchestrate` runs in the background by default** — the tool returns immediately
  and the chat stays usable.
- On completion a `meta-loop-result` message is injected via `sendMessage({ followUp, triggerTurn })`.
- Startup warns when verify is unconfigured; the run still proceeds.
- Stopping: `/ml-stop` (AbortController), a `STOP` file, or `force`.
- State: footer + `belowEditor` widget + `/tasks` and `/ml-runs`. `/tasks <ticket-id>` for detail.
- Board persistence: `.pi/meta-loop/runs/<runId>/board.json` + `latest.json`, newest 20 retained.
- Role subprocess tasks go on **stdin**, never argv (avoids Windows `ENAMETOOLONG`).
- Terminal semantics: `plan_failed` / all-blocked → `incomplete` or `error`, never a false `done`.
- Planning retries at most twice with `outputCap >= 200k`; raw attempts land in `plan-attempt-*.txt`.
- Idle sessions stop re-reading the board. Owner-lock heartbeat is 15s against a 60s lease.

## Known limitations

- Per-command bash denylists do not converge, so a scoped native Worker gets no bash at all
  (built-ins + scope + evidence instead).
- Only the native pi worker exists as an executor. Scope is enforced by intercepting tool calls,
  which is specific to pi; an executor without that interception could only be checked by the
  post-hoc sweep, which is a detection backstop rather than enforcement. Multi-CLI workers are
  tracked in issue #4 and must answer that question before they ship.
- Approving a verify profile authorizes running the target repository's own code (see SECURITY.md).
- Without `limits.scopeCeiling`, the write surface is decided by model output.
- If the Primary edits the same files during a background run, Worker and Primary can still
  conflict. Narrowing the evidence sweep removed the false positives, not this real overlap.
- There is no wall-clock Supervisor inside a running ticket; supervision happens at ticket boundaries.
- The nesting guard is for cooperative paths, not hostile ones.
- Role subprocesses inherit the host environment because model CLIs need provider
  credentials. Values are never printed by the doctor or logs.
- After a crash, `session_start` marks the run `stopped`. Resuming is manual: `/ml-resume`
  re-runs the failed and unfinished tickets of a persisted board without re-planning or
  re-approving, and each retried ticket carries its previous attempts so the Worker is told
  what has already been tried.
