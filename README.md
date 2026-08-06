# pi-metaLoop

Adaptive supervised orchestration for [pi](https://github.com/earendil-works/pi) — short tasks stay lightweight, long tasks get a supervised multi-agent layer that catches misalignment early.

[日本語 README](./README.ja.md)

## The idea

> Normally, pi behaves exactly as usual. Only for long tasks does it quietly stand up a supervised division-of-labor layer and stop misalignment before it grows expensive.

- **Asymmetric activation** — questions, git checks, discussion, small fixes: zero overhead, no extra agents.
- **Early alignment check** — before workers really start, the Supervisor audits the plan once. Work-design review, not code review.
- **Separated authority** — exactly one owner of user intent (the Primary agent), one owner of the execution plan, one detector of anomalies.
- **Externalized metacognition** — monitoring and control are harness-level, not delegated to the model's self-reflection.

## How it works

```text
User
  │
  ▼
Primary (your normal conversation with pi)
  │
  └─ long task only: calls the `orchestrate` tool
     (recent conversation context is passed along)
        ▼
   Orchestrator (owner of the execution plan, step-driven)
   Decomposes the goal into bounded task tickets. Never grows scope.
        │
        ├─ Initial supervision: Supervisor (green / yellow / red)
        │     red    → stop, return to Primary
        │     yellow → guidance injected into Orchestrator, plan revised
        │     green  → execute
        │
        ├─ Worker x N (1 ticket = 1 deliverable + 1 verification + bounded scope)
        │
        └─ Supervisor re-checks automatically (hook-style)
              · 30 min elapsed (checkIntervalMinutes)
              · 6 workers started (workerStartThreshold)
              · consecutive failures / blocked tickets
              → intervention = prompt injection into the Orchestrator only
```

Every role runs in an isolated `pi` subprocess (`--mode json -p --no-session`).
**Each role can use a different model** (`roles.*.model` in config).

## Roles and authority

| Role | Responsibility | Must not |
|---|---|---|
| Primary | Own user intent, final answers | — |
| Orchestrator | Plan, decompose, assign | Grow scope, reinterpret requirements |
| Supervisor | Overall supervision, metacognition, G/Y/R verdicts, automatic hooks | Implement, add features, reinterpret, intervene in Workers directly |
| Worker | Deliver one bounded ticket | Change files outside scope, change direction |

All Supervisor interventions flow **through the Orchestrator only** (as prompt injections). Workers never receive instructions from the Supervisor directly. Stopping execution on red is runtime control, not intervention.

## Supervision hooks (config-driven)

| Trigger | Default |
|---|---|
| Periodic check since last review | every 30 min |
| Workers started since last review | 6 |
| Consecutive worker failures | 2 (immediate) |
| Worker blocked (missing prerequisites) | immediate |

The Supervisor sees: the user's original request, the Primary conversation digest (what was discussed/agreed), the task board, execution stats, injected-guidance history, and the project standards.

## Standards: separating role from criteria

- `agents/supervisor.md` — **how** to supervise (stable, role definition)
- `config/standards.md` — **what** to check (defaults: code quality, tests, security, scope)
- `<project>/.pi/meta-loop-standards.md` — project-specific criteria (appended to defaults)

The Supervisor uses standards as the basis for verdicts; criteria not in the standards can only produce `optional_advice`, never yellow/red (prevents over-intervention). The Orchestrator receives them too, so tickets reflect standards from the first plan.

## Install

As a pi package:

```bash
pi install git:github.com/Aero123421/pi-metaloop
# or a local path
pi install /path/to/pi-metaLoop
```

Or add to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/path/to/pi-metaLoop"] }
```

Quick test without installing:

```bash
pi -e /path/to/pi-metaLoop/src/index.ts
```

## Configuration

`config/meta-loop.json` (defaults) — override per project with `.pi/meta-loop.json`:

- `enabled` — kill switch
- `roles.<role>.model` — per-role model (empty = inherit pi default)
- `roles.<role>.tools` — tools available to the role
- `supervisor.auto` — enable automatic supervision hooks
- `supervisor.checkIntervalMinutes` — periodic check interval (default 30)
- `supervisor.workerStartThreshold` — check after this many worker starts (default 6)
- `supervisor.maxConsecutiveFailures` — immediate check after this many consecutive failures (default 2)
- `limits.maxTasks` — ticket cap (default 8)
- `limits.perTaskOutputCap` — output cap per subprocess

## Commands & UX

- The Primary calls `orchestrate` itself for long tasks; ask explicitly if you want it ("this is a long task, use orchestrate").
- `/tasks` — show the current task board
- `/verdicts` — Supervisor verdict history
- `/sfh` — list recent sfh runs and inspect one; `/sfh stop` stops the newest run
- Footer shows a thin status line while supervised: `supervised executing 3 tasks ●1 ✓2 review:green`
- If an sfh flow is running in the project, the footer shows live progress (`sfh:<flow> ●running step:<id> fanout 2/3 $0.31 12m`) and a widget appears above the editor. Runs started outside pi are visible too; `stuck` runs always notify.

Users see one conversation. Internal chatter is not surfaced — only the plan, detected misalignments, decisions that truly need you, and final results.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit (strict)
```

## Security

This extension spawns `pi` subprocesses with your full permissions. Agent prompts come from this repository only (no project-local agent loading). Review the code before installing, as with any pi package.

**Nesting guard:** spawned subprocesses set `PI_META_LOOP_DEPTH >= 1`, which makes this extension register nothing — workers, role subprocesses, and pi instances launched by sfh can never re-orchestrate or re-delegate. Recursion is structurally impossible.

## Roadmap

- [x] Phase 1 — orchestrate tool, initial supervision, G/Y/R, task tickets, per-role models
- [x] Phase 2 — automatic Supervisor hooks, step-driven Orchestrator, guidance injection, conversation context, standards
- [x] sfh TUI monitor — live `status.json` polling, footer/widget, `/sfh` command, nesting guard
- [ ] Phase 2.5 — sfh execution backend (parallel/heterogeneous branch groups + integration contract), guard extension for scope enforcement
- [ ] Phase 3 — harness diagnosis (repeated failures → rules/skills/prompts weaknesses)
- [ ] Phase 4 — evolution loop (logs + scores, external improver) — research-grade, optional

## License

MIT
