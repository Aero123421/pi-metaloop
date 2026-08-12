# Contributing

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run typecheck    # tsc --noEmit (strict), covers src/ and test/
npm test
npm run docs:check   # README.md / README.ja.md parity
npm run release:check
npm run package:smoke
```

Run one file while iterating:

```bash
node --experimental-strip-types --test test/runtime.test.ts
```

## Where things live

| Area | Start here |
|---|---|
| Extension entry, commands, TUI wiring | `src/index.ts` |
| Plan → audit → execute → evidence loop | `src/runtime.ts` |
| Config layering and capability ceilings | `src/config.ts` |
| Scope matching, git evidence | `src/evidence.ts` |
| Bounded filesystem evidence | `src/fs-snapshot.ts` |
| Controller-side verify gate | `src/verify.ts` |
| Worker tool-call guard (runs in the child) | `src/scope-guard.ts` |
| Role prompts | `agents/*.md` |
| Architecture and known limits | `DESIGN.md` (`DESIGN.ja.md` for the Japanese version) |

## House rules

**Keep capability changes fail-closed.** An unparseable input, a missing verdict, or an
unreadable config layer must never widen what a role can do.

**Attribute failures to whoever caused them.** A ticket should be marked `failed` only when the
ticket's own execution is at fault. Environment failures, external interference, and pre-existing
red belong in `partial` — inconclusive is not the same as broken, and mislabeling it makes the
harness a noise source instead of a signal.

**Add one focused regression test per behavior change.** Prefer real filesystems, real
subprocesses, and real git repositories over mocks; the existing suite does, and that is why it
catches things.

**Role prompts and runtime strings are English**, and each role is instructed to answer in the
user's language. Japanese documentation lives in `README.ja.md` and the setup skill. If you touch
a security claim in one README, `npm run docs:check` will require the other to match.

Pull requests should state the user-visible contract and any compatibility impact.
