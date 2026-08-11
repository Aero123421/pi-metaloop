# Inspection criteria (defaults)

These are the criteria the Supervisor judges against. Anything not listed here can only
become `optional_advice` — never a yellow or red verdict.

## Code quality

- Do not swallow exceptions. Errors reach the caller or the user.
- Changes to public APIs and function signatures come with the affected call sites listed.
- No leftover debug output or commented-out dead code.

## Tests

- New behavior ships with a way to check it: a test, or an equally observable acceptance criterion.
- Weakening or deleting an existing test to make a change pass is forbidden.

## Security

- No secrets embedded in code.
- Destructive operations (deletion, migration, overwrite) are declared in the ticket's
  `forbidden` or `acceptance`.

## Scope

- One ticket: one deliverable, one way to verify it, a bounded change surface.
- No refactors or specification changes unrelated to the goal.
