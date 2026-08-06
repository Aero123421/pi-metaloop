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
  "orchestrator": { "model": "provider/model-id", "tools": ["read","bash", "..."] },
  "supervisor":   { "model": "provider/model-id", "tools": ["read","bash", "..."] },
  "worker":       { "model": "provider/model-id", "tools": ["read","write","edit","bash", "..."] }
}
```

Empty `model` = inherit pi default. Used for **pi subprocesses** (Orchestrator / Supervisor / Worker).

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
- **access**: `read` (no writes), `write`, `full` — prefer `read` for research branches

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
