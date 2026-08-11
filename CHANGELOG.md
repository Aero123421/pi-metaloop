# Changelog

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
