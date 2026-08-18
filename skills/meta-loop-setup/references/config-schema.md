# config-schema（meta-loop）

## ファイル

| Layer | Path |
|-------|------|
| Default | extension `config/meta-loop.json` |
| User | `~/.pi/agent/meta-loop/config.json` |
| Project | `<cwd>/.pi/meta-loop/config.json` |

Later layers win. Map-valued settings are deep-merged.

## roles

```json
{
  "config_version": 1,
  "roles": {
    "orchestrator": { "model": "provider/model-id", "tools": ["read","ls","find","grep"] },
    "supervisor":   { "model": "provider/model-id", "tools": ["read","ls","find","grep"] },
    "worker":       { "model": "provider/model-id", "tools": ["read","write","edit","ls","find","grep"] }
  }
}
```

Empty `model` = inherit pi default. Used for **pi subprocesses** (Orchestrator / Supervisor / Worker).

**Strict built-in allowlist** for scoped native workers (`read,write,edit,ls,find,grep`). bash/custom tool names are stripped; production tool_call guard blocks bash. Workers launch with `--no-extensions` and only the harness scope-guard extension. Build/test uses the selected verify profile or legacy `executor.verifyCommands` (controller-side).

## executor

```json
{
  "executor": {
    "timeoutSec": 1800,
    "maxParallel": 4,

    "verifyProfiles": {
      "node": [["npm", "test"], ["npm", "run", "typecheck"]],
      "rust": [["cargo", "test", "--locked"]]
    },
    "verifyProfile": "node",
    "verifyTimeoutSec": 600,
    "verifyMode": "per-ticket"
  }
}
```

### verifyProfiles / verifyProfile (native done gate)

- Argv lists only (`[command, ...args]`); **no shell**. Controller runs them after the Worker with `shell:false`.
- **Required for native ticket `done`**. Unset / empty / non-zero exit / timeout → done forbidden (`evidence.verify`).
- Define `verifyProfiles` in **user/base** config after explicit approval.
- Project config may select an existing `verifyProfile`, keep a subset through legacy `verifyCommands`, or lower `verifyTimeoutSec`; it cannot introduce profiles or argv.
- `/ml-doctor` shows the effective profile, argv, timeout, and config provenance.
- **Approving a profile authorizes running the target repository's own code.** The profile fixes
  the command; `npm test` executes whatever that repository defines. See SECURITY.md.

### verifyMode

- `per-ticket` (default): the full sequence runs after every native ticket.
- `final`: runs once after the execute loop and promotes the tickets that claimed `done`. Use it
  when intermediate tickets cannot leave the tree green on their own.
- A baseline verify always runs once before the first ticket. A ticket failing a command that was
  already failing then is recorded `partial` with `verify.preExisting`, never `failed`.

## supervisor

```json
"supervisor": {
  "auto": true,
  "checkIntervalMinutes": 30,
  "workerStartThreshold": 6,
  "maxConsecutiveFailures": 2
}
```

## escalation（soft nudge only）

```json
"escalation": {
  "enabled": true,
  "toolCallThreshold": 20,
  "distinctPathThreshold": 8,
  "writeThreshold": 5,
  "promptLengthThreshold": 400
}
```

## limits

```json
"limits": {
  "maxTasks": 8,
  "perTaskOutputCap": 51200,
  "maxSupervisions": 12,
  "scopeCeiling": ["src/**", "test/**"]
}
```

- `maxSupervisions` bounds mid-run Supervisor audits (counting real Supervisor calls). Initial and
  final audits always run. Project config cannot change this user-owned cost and supervision policy.
- `scopeCeiling` bounds every ticket's `allowed_scope`. A ticket whose scope is not provably
  inside it is blocked before running; `**` and a bare `*.ts` are rejected. Unset means no ceiling;
  an **empty** ceiling is deny-all, which is what layer narrowing produces when a project ceiling
  does not overlap the user's. Set it in user config.

## evidence

```json
"evidence": {
  "ignoreDirNames": ["node_modules", "target", ".next"],
  "parentMaxDepth": 0,
  "maxEntries": 250000,
  "timeoutMs": 30000
}
```

Bounds the post-run filesystem sweep. Ignored directories are recorded but not traversed, and the
parent scan defaults to direct entries only — concurrent tooling writing into dependency and build
trees is not something a ticket did. **User/base layers only**: narrowing weakens detection, and
widening lets an untrusted repository force a long synchronous sweep and pull unrelated paths into
the Supervisor's prompt.

## allowProjectModelOverride

```json
{ "allowProjectModelOverride": false }
```

User/base only. When false (default) a project config cannot choose `roles.*.model`.

## standards.md

Markdown checklist. Injected into Supervisor (judgment basis) and Orchestrator (ticket design).  
Items not listed must not drive yellow/red.
