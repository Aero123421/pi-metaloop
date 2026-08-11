# Security

## Supported versions

Security fixes are provided for the latest release candidate or stable release.

## Reporting

Please use GitHub private vulnerability reporting for this repository. Do not include API keys, prompts containing secrets, or private run artifacts in a public issue.

## Trust boundary

pi-meta-loop runs `pi`, configured controller verify commands, and SFH with the current user's OS permissions. Native Workers receive only interceptable built-in tools and cannot use bash. SFH groups are read-only unless a future OS sandbox can enforce scoped writes.

Role subprocesses inherit the host environment because model CLIs need provider credentials. Run artifacts may contain prompts, paths, model output, and command output; `.pi/meta-loop/` is ignored by Git, but remains local sensitive data. `/ml-doctor` does not print environment values.

Project config and standards are untrusted inputs. Project config may narrow capabilities and select a user-approved verify profile, but cannot add verify argv, raise SFH access, replace the SFH binary, or expand tool allowlists.

Known limitations are maintained in [DESIGN.md](./DESIGN.md).
