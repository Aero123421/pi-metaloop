# config-schema（meta-loop）

## ファイル

| Layer | Path |
|-------|------|
| Default | extension `config/meta-loop.json` |
| User | `~/.pi/agent/meta-loop/config.json` |
| Project | `<cwd>/.pi/meta-loop/config.json` |

Later layers win. `sfhToolModels` / `sfhToolEfforts` / `sfhToolAccess` are deep-merged.

## roles

```json
"roles": {
  "orchestrator": { "model": "provider/model-id", "tools": ["read","ls","find","grep"] },
  "supervisor":   { "model": "provider/model-id", "tools": ["read","ls","find","grep"] },
  "worker":       { "model": "provider/model-id", "tools": ["read","write","edit","ls","find","grep"] }
}
```

Empty `model` = inherit pi default. Used for **pi subprocesses** (Orchestrator / Supervisor / Worker).

**bash is never granted** to scoped native workers. Listing `bash` in config/alias/args is stripped at load and blocked by the production tool_call guard. Workers use interceptable built-ins only; build/test is controller-side trusted verify.

## executor（sfh）

```json
"executor": {
  "sfhEnabled": true,
  "sfhBinary": "sfh",
  "timeoutSec": 1800,
  "maxParallel": 4,

  "sfhAllowedTools": ["pi", "opencode"],

  "sfhModel": "",
  "sfhEffort": "",
  "sfhAccess": "read",

  "sfhToolModels":  { "pi": "provider/id", "opencode": "" },
  "sfhToolEfforts": { "pi": "medium", "codex": "high" },
  "sfhToolAccess":  { "pi": "read", "opencode": "read" },

  "sfhIntegrateModel": "",
  "sfhIntegrateEffort": "",
  "sfhIntegrateAccess": "read"
}
```

### Branch field resolution

For each sfh parallel branch:

| Field | Order |
|-------|--------|
| model | `branches[].model` → `sfhToolModels[tool]` → `sfhModel` → (if tool=pi) `roles.worker.model` |
| effort | `branches[].effort` → `sfhToolEfforts[tool]` → `sfhEffort` |
| access | `branches[].access` → `sfhToolAccess[tool]` → `sfhAccess` → `"read"` |

Integrate step: `sfhIntegrate*` → `sfhModel`/`sfhEffort` → worker.model for model; access default `read`.

### sfhAllowedTools

- Non-empty list: Orchestrator/group tickets may only use these tool names; others → ticket **blocked**
- Empty / omitted: no restriction

### effort / access notes

- **effort** strings are tool-defined (codex/claude often `low|medium|high`; pi may ignore unknown values)
- **access**: `read` (no writes), `write`, `full` — **without an OS sandbox only `read` is supported** (write/full is refused at plan/execute and never marked done via post-hoc evidence alone)

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
  "concurrency": 1,
  "perTaskOutputCap": 51200
}
```

## standards.md

Markdown checklist. Injected into Supervisor (judgment basis) and Orchestrator (ticket design).  
Items not listed must not drive yellow/red.
