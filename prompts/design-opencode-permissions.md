# Design a repository-specific OpenCode permission policy

You are performing a security and workflow audit for the repository in your current working directory. Your job is to propose a practical OpenCode permission policy for everyday feature work, bug fixes, investigations, and spikes.

Use `config/opencode.permissions.template.jsonc` from the `local-llm` repository as the conservative baseline. If that file is unavailable, begin with `"*": "ask"`, allow repository-local reads and edits, deny external-directory access, and deny clearly destructive operations.

## Goal

Produce the best first-pass policy that lets an agent perform normal development feedback loops without interruption while retaining human approval for consequential operations and blocking operations that should never be delegated.

This is a proposal. Do not install, overwrite, or modify an OpenCode configuration until I explicitly approve the proposed policy.

## Audit the repository

Inspect the repository without changing it. At minimum, examine:

- Contributor and agent instructions, including `AGENTS.md`, `CLAUDE.md`, and README files.
- Package manifests, workspace definitions, lockfiles, and runtime-version files.
- `mise.toml`, `Makefile`, `Taskfile`, `Justfile`, and package scripts.
- Test, lint, formatting, typecheck, build, code-generation, and development-server commands.
- CI workflows and the commands they consider authoritative.
- Language and framework conventions.
- Docker, infrastructure, database, migration, release, deployment, and cloud tooling.
- GitHub CLI usage and repository automation.
- Commands documented for routine development versus commands that alter remote or production state.
- Sensitive paths, credentials, signing material, environment files, generated files, and directories outside the repository.
- The current Git worktree status so existing user changes are treated as data that must not be discarded.

Do not execute installs, scripts, tests, network calls, or state-changing commands merely to discover what they do. Read their definitions.

## Classify operations

Classify every relevant operation into one of these groups:

### Allow

Use `allow` only for operations that are routine, narrowly scoped, repeatable, and unlikely to cause meaningful loss or external side effects. Typical candidates include:

- Repository-local reads, searches, and language-server queries.
- Repository-local source edits, excluding sensitive or security-critical paths.
- Read-only Git and GitHub inspection.
- Well-understood test, lint, typecheck, format, and build commands defined by this repository.

Remember that a package script or task runner command executes repository-controlled code. Only allow exact scripts you inspected; do not broadly allow `pnpm run *`, `mise run *`, `make *`, arbitrary interpreters, or arbitrary package executors.

### Ask

Use `ask` for legitimate work that has material side effects or depends on intent, including:

- Dependency installation, addition, removal, or upgrade.
- Starting or stopping long-running processes.
- Database migrations and code generation with broad output.
- Git staging, commits, branch manipulation, fetches, pulls, pushes, and PR creation.
- Network requests, downloads, authentication, and commands that contact external services.
- Changes to CI, deployment, release, infrastructure, permissions, or security configuration.
- Commands whose behavior cannot be determined confidently from repository files.

### Deny

Use `deny` for operations that are destructive, privileged, credential-bearing, outside the repository, or capable of silently changing remote/production state. Include relevant spellings and keep these rules after broader patterns because OpenCode uses the last matching rule.

At minimum, consider:

- Recursive deletion and commands that discard uncommitted work.
- Destructive Git history/worktree operations and force pushes.
- Repository, release, deployment, package, or artifact deletion/publication.
- Reading or changing secrets, private keys, signing material, or authentication tokens.
- Privilege escalation, ownership changes, and system-wide tool configuration.
- Access outside the current repository.

Do not claim the policy is a sandbox. Shell commands can encode, compose, alias, or indirectly perform operations that pattern rules do not recognize. Call out important bypasses and recommend OS-level isolation where the threat model requires enforcement.

## T3 Code compatibility check

Determine whether the intended workflow launches OpenCode through T3 Code. As of August 2, 2026, T3 Code's OpenCode adapter applies a per-session catch-all permission ruleset after OpenCode configuration. Supervised, Auto-accept edits, and Auto all become `ask`; Full access becomes `allow`. This can override repository policy, including explicit denies. Reference pingdotgg/t3code issue #5164 and clearly state whether the proposed policy will actually be authoritative in the user's current runtime.

Do not recommend T3 Full access as a substitute for this policy. If T3 still has this behavior, present direct OpenCode usage, manual supervision, a patched T3 adapter, or an OS-level sandbox as the available enforcement choices.

## Required output

Return the following, in order:

1. **Repository profile** — languages, tools, trusted development commands, external systems, and sensitive assets discovered.
2. **Assumptions and uncertainties** — concise and explicit; make a useful first guess rather than stopping unnecessarily.
3. **Permission matrix** — each important operation or command family, its `allow`/`ask`/`deny` classification, and a one-sentence rationale.
4. **Proposed configuration** — a complete, syntactically valid JSONC `permission` object ready to merge into the repository's `opencode.jsonc`. Preserve rule ordering intentionally.
5. **What remains interactive** — expected approval prompts during feature work, bugs, and spikes.
6. **Limitations and bypasses** — especially shell indirection, scripts, task runners, network access, and T3 session overrides.
7. **Validation plan** — safe commands to inspect the resolved configuration and a table of representative requests with their expected decision. Never validate a deny rule by actually performing the destructive operation.
8. **Suggested patch** — show the exact target file and diff, but wait for my approval before applying it.

Prefer exact command patterns over broad wildcards. Do not include API keys, tokens, passwords, machine-specific secrets, or absolute personal paths in the proposed configuration.
