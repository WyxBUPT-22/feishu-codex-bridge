# Repository Agent Instructions

These instructions apply to the entire repository.

## Installation and deployment requests

When the user asks to install, configure, deploy, update, repair, or enable autostart for Feishu Codex Bridge:

1. Read `INSTALL_WITH_AGENT.md` completely before taking task actions.
2. Use `INSTALL_WINDOWS.md` as the source of truth for supported parameters and user-facing setup.
3. Follow the staged workflow in `INSTALL_WITH_AGENT.md`; begin with its read-only checks.
4. Preserve its approval, credential, repository, canonical-config, version, smoke-test, and deployment boundaries.
5. Do not report completion until every applicable completion condition in that document is satisfied.

If a required browser login, Feishu administrator action, application publication, or user choice cannot be completed by the Agent, stop at the relevant stage and report the exact remaining human action. Do not bypass or silently assume it.

## Development requests

For code or documentation changes, read `CONTRIBUTING.md` and preserve existing user changes. Installation requests do not authorize commits, pushes, releases, credential changes, or broader repository modifications.
