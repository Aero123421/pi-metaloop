# pi-metaLoop

Adaptive supervised orchestration for [pi](https://github.com/earendil-works/pi) — short tasks stay lightweight, long tasks get a supervised multi-agent layer that catches misalignment early.

[日本語 README](./README.ja.md)

## The idea

> Normally, pi behaves exactly as usual. Only for long tasks does it quietly stand up a supervised division-of-labor layer and stop misalignment before it grows expensive.

- **Asymmetric activation** — questions, git checks, discussion, small fixes: zero overhead, no extra agents.
- **Early alignment check** — before workers really start, the Supervisor audits the plan once. Work-design review, not code review.
- **Separated authority** — exactly one owner of user intent (the Primary agent), one owner of the execution plan, one detector of anomalies.
- **Externalized metacognition** — monitoring and control are harness-level, not delegated to the model's self-reflection.

## Requirements

- [pi](https://github.com/earendil-works/pi) (this is a pi extension)
- **[sfh (SimpleFlowHarness)](https://github.com/Aero123421/SimpleFlowHarness) — required dependency** for group tickets (`execution: "sfh"`), which run parallel branch groups with an integration contract

```bash
# Windows PowerShell
irm https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.ps1 | iex
# macOS / Linux
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Aero123421/SimpleFlowHarness/releases/latest/download/sfh-installer.sh | sh
```

Without sfh, group tickets are blocked with install instructions; normal (native) tickets still work.

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

Layers (later wins):

```text
1. extension repo config/meta-loop.json          (shipped defaults)
2. ~/.pi/agent/meta-loop/config.json             (user global — put role models here)
3. <project>/.pi/meta-loop/config.json           (project override)
```

Standards live next to config:

```text
~/.pi/agent/meta-loop/standards.md
<project>/.pi/meta-loop/standards.md
```

### Role models (pi subprocesses)

```json
{
  "roles": {
    "orchestrator": { "model": "provider/model-id" },
    "supervisor":   { "model": "provider/model-id" },
    "worker":       { "model": "provider/model-id" }
  }
}
```

Empty string = inherit pi's default model. Format is the same as pi `--model`.

### sfh models (parallel group branches)

sfh steps accept a `model` field (tool-dependent). Resolution order for each branch:

1. `branches[].model` on the ticket (Orchestrator override)
2. `executor.sfhToolModels[tool]` (e.g. different model for `pi` vs `opencode`)
3. `executor.sfhModel` (global sfh default)
4. for `tool: pi` only — fall back to `roles.worker.model`

Integrate step uses `executor.sfhIntegrateModel` → `sfhModel` → `roles.worker.model`.

```json
{
  "executor": {
    "sfhEnabled": true,
    "sfhBinary": "sfh",
    "timeoutSec": 1800,
    "maxParallel": 4,
    "sfhModel": "",
    "sfhIntegrateModel": "",
    "sfhToolModels": {
      "pi": "provider/model-id",
      "opencode": "",
      "codex": "",
      "claude": ""
    }
  }
}
```

See `examples/user-meta-loop.config.example.json` and `examples/project-meta-loop.config.example.json`.

Other knobs:

- `enabled` — kill switch
- `roles.<role>.tools` — tools available to the role
- `supervisor.*` — automatic supervision hooks
- `executor.*` — sfh delegation and models
- `escalation.enabled` — soft long-task nudge (default true)
- `escalation.toolCallThreshold` — default 20
- `escalation.distinctPathThreshold` — default 8
- `escalation.writeThreshold` — default 5
- `escalation.promptLengthThreshold` — default 400
- `limits.maxTasks` — ticket cap (default 8)
- `limits.perTaskOutputCap` — output cap per subprocess

## Group tickets (parallel branches + integration contract)

The Orchestrator may cut research/exploration/comparison work into a single **group ticket** instead of several tickets:

```json
{
  "id": "research-01",
  "execution": "sfh",
  "goal": "OAuth approaches: research and codebase exploration",
  "branches": [
    { "id": "web", "tool": "opencode", "prompt": "library comparison..." },
    { "id": "code", "tool": "pi", "prompt": "existing auth flow survey..." }
  ],
  "integration": { "acceptance": ["all branches covered", "contradictions listed", "sources noted"] }
}
```

The runtime generates a `flow.yaml` (saved under `.pi/meta-loop/flows/`) and runs `sfh run` in the foreground with `PI_META_LOOP_DEPTH=1` in the flow env. The integrated report (sfh stdout) plus cost/elapsed metadata is collected into the board. The TUI monitor shows live progress while the flow runs.

Implementation tickets stay native (Worker pi subprocesses). Groups are for parallelizable investigation work only.

## Commands & UX

- The Primary calls `orchestrate` itself for long tasks; ask explicitly if you want it ("this is a long task, use orchestrate").
- `/tasks` — show the current task board
- `/verdicts` — Supervisor verdict history
- `/sfh` — list recent sfh runs and inspect one; `/sfh stop` stops the newest run
- Footer shows a thin status line while supervised: `supervised executing 3 tasks ●1 ✓2 verdict:green`
- Soft escalation: if the Primary session accumulates many tool calls / file touches / writes, or the user prompt looks like a long brief, pi-metaLoop nudges once to consider `orchestrate` (never forces it)
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
- [x] Phase 2.5 — sfh execution backend: group tickets, integration contract, flow.yaml generation, result collection
- [x] Hardening — docs cleanup, sfh ticket validation, allowed_scope guard, soft long-task escalation
- [ ] Phase 3 — harness diagnosis (repeated failures → rules/skills/prompts weaknesses)
- [ ] Phase 4 — evolution loop (logs + scores, external improver) — research-grade, optional

## License

MIT
