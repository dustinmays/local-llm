# Local MLX delegation operations

This is the operator guide for building, running, configuring, inspecting, and
troubleshooting `local-mlx-delegate` on macOS. The server is read-only with
respect to model lifecycle: it never starts, stops, loads, unloads, or swaps a
model. Start LM Studio, a worker tunnel, or a cluster profile separately before
running live checks.

## Runtime topology

`local-mlx-delegate` is a local stdio MCP server, not a network daemon:

```text
Codex / Claude Code / Copilot CLI / VS Code
                         |
              client-owned MCP stdio
                         |
             one local-mlx-delegate child
                         |
              read-only loopback HTTP
                         |
       controller :1234 / worker :1235 / cluster :8080
```

Each MCP host starts and stops its own child process and owns that process's
stdin and stdout. Multiple child processes are normal; their generation
capacity is coordinated through the shared local state registry. Do not run the
stdio server under `launchd`, a terminal multiplexer, or another supervisor.
Those processes would own different protocol pipes, so an MCP client could not
attach to the daemon. A shared service would require a future authenticated
Streamable HTTP design and is outside version 1.

The MCP process opens no inbound TCP listener. It makes outbound HTTP requests
to configured loopback endpoints. Consequently, the process must run in the
same native macOS network context as the model endpoint:

- A native Codex, Claude Code, Copilot CLI, or VS Code process can reach LM
  Studio at `127.0.0.1:1234`.
- A sandboxed test shell failing to reach the Mac's loopback does not prove that
  a native MCP host will fail. Run live acceptance checks from the native host.
- In a container, remote SSH workspace, cloud executor, or explicitly remote
  MCP environment, `127.0.0.1` identifies that environment rather than the Mac.
  Run this server natively instead. The version-1 configuration intentionally
  rejects non-loopback backend URLs, including container host aliases.
- A network-restricted MCP sandbox must permit the configured loopback host and
  port. Inspect the host's MCP output when a direct native CLI check passes but
  an MCP call fails.

For VS Code, a workspace MCP entry runs in the workspace's execution context.
Do not use a Remote SSH, dev-container, or cloud workspace entry to reach LM
Studio on the physical Mac. For Codex, leave any experimental remote execution
setting disabled for this server.

## Install and build

Run from the repository root:

```bash
mise install
mise run delegate:install
mise run delegate:build
```

The supported runtime is the Node and pnpm pair pinned in `mise.toml`. Rebuild
after changing TypeScript because every host configuration points at the
compiled `dist/cli.js`.

## Direct checks before MCP configuration

With LM Studio already serving the controller endpoint:

```bash
./dist/cli.js status --backend controller
./dist/cli.js status --backend controller --json
./dist/cli.js doctor --backend controller --workspace-root "$PWD"
```

For a worker tunnel or cluster, replace `controller` with `worker` or `cluster`.
These commands use the same domain service as the MCP tools and are the fastest
way to separate backend reachability from host configuration problems.

Status preserves the sanitized OpenAI-visible model catalog in `models` and
reports only loaded generative candidates in `loaded_models`. For LM Studio,
the probe reads `/health`, `/v1/models`, and `/api/v1/models`; delegation adds
only `/v1/chat/completions`. An unloaded model visible through JIT discovery or
an embedding model does not make the backend ready.

## Manual stdio launch

The production server command is:

```bash
./dist/cli.js serve --workspace-root "$PWD"
```

A manual launch normally prints nothing and waits for protocol input. That is
not a hang. Stdout belongs exclusively to MCP protocol frames, while
newline-delimited diagnostic JSON goes to stderr. Stop a manual launch with
Ctrl-C. In ordinary use, do not pre-launch it; let the MCP host own the process.

## Configure a host

Configuration is project-local, review-first, and idempotent. Preview the exact
change:

```bash
./dist/cli.js configure codex --workspace-root "$PWD"
./dist/cli.js configure claude --workspace-root "$PWD"
./dist/cli.js configure copilot-cli --workspace-root "$PWD"
./dist/cli.js configure vscode --workspace-root "$PWD"
```

Apply only the integrations used in the project:

```bash
./dist/cli.js configure codex --workspace-root "$PWD" --apply
./dist/cli.js configure claude --workspace-root "$PWD" --apply
./dist/cli.js configure copilot-cli --workspace-root "$PWD" --apply
./dist/cli.js configure vscode --workspace-root "$PWD" --apply
```

The commands update `.codex/config.toml`, the root `.mcp.json` shared by Claude
Code and Copilot CLI, or `.vscode/mcp.json`. Existing unrelated configuration
is preserved. Changed files receive timestamped backups and are replaced
atomically. Trust or approve the project entry in the host after applying it.

The generated entry currently executes the canonical absolute `dist/cli.js`
and passes the canonical workspace root. Because the executable uses
`#!/usr/bin/env node`, the host application's inherited `PATH` must resolve the
pinned Node 24 runtime. This commonly works for native terminal-launched hosts,
but GUI and intentionally stripped environments can differ. The planned
portability hardening is to generate an absolute Node command, test a minimum
explicit environment, and add safe doctor checks. Until that lands:

- install Node through the pinned mise environment before applying a host
  configuration;
- restart a GUI host after changing its runtime environment;
- preserve a normal per-user home and a `PATH` that resolves Node 24;
- prefer an explicit `--config` argument when using a non-default JSON file;
  and
- do not forward secrets, proxy variables, or the complete shell environment.

The built-in localhost configuration requires no API credentials. Optional
`LOCAL_MLX_DELEGATE_*` overrides are documented in the root README. The exact
minimum inherited environment remains under test; do not infer that a stripped
environment failure proves a backend or protocol defect without reproducing it
through the real host and reviewing safe server logs.

## Discover and manage configured servers

Use the MCP host that owns the child process as its lifecycle manager:

| Host                  | Discovery and management                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Codex CLI/Desktop/IDE | `codex mcp list --json`, `codex mcp --help`, or `/mcp`                                                    |
| Claude Code           | `claude mcp list`, `claude mcp get local-mlx-delegate`, or `/mcp`                                         |
| Copilot CLI           | `copilot mcp list --json`, `copilot mcp get local-mlx-delegate --json`, or `/mcp show local-mlx-delegate` |
| VS Code/Copilot       | Run **MCP: List Servers** to start, stop, restart, enable, disable, or show output                        |

Then ask the host: “Call `local_llm_status` and report only its structured
result.” A bounded live consultation can explicitly invoke
`local_llm_delegate` after status reports a loaded model.

Check every installed and configured native CLI host with:

```bash
mise run delegate:host-smoke
```

The task skips host executables that are not installed. Missing, untrusted, or
unconfigured hosts remain incomplete release evidence even when skipped by
this convenience smoke check.

## Inspect the MCP protocol

Use the official MCP Inspector for an interactive protocol session:

```bash
mise exec -- pnpm dlx @modelcontextprotocol/inspector -- \
  ./dist/cli.js serve --workspace-root "$PWD"
```

The first run may require network access to download Inspector. Inspector owns
the stdio child for that session; do not start a second copy manually. Keep the
Inspector proxy on its default local binding with authentication enabled.

For repeatable repository protocol tests, use the pinned SDK client instead:

```bash
mise run delegate:test-protocol
```

## Troubleshooting

### Direct status reports `BACKEND_UNAVAILABLE`

Run the command from a normal native macOS terminal, not an agent sandbox:

```bash
./dist/cli.js status --backend controller --json
lsof -nP -iTCP:1234 -sTCP:LISTEN
```

If neither sees LM Studio, verify that LM Studio's local server is running and
listening on port 1234. Start or load it separately; the delegate will not do
so. For worker or cluster checks, inspect ports 1235 or 8080 respectively.

### Direct status passes but the MCP host fails

1. Confirm the host is native, trusted, and not running the server remotely.
2. Run the host's MCP discovery command and inspect its server output.
3. Check that the host can resolve Node 24 through its inherited `PATH`.
4. In VS Code, ensure the workspace is local and any MCP sandbox permits the
   configured loopback address.
5. Run `mise run delegate:host-smoke` from the same native user session.

Do not copy raw environment values, upstream response bodies, prompts, model
answers, credentials, or absolute workspace paths into retained diagnostics.

### MCP launch exits immediately

Run `mise run delegate:build`, verify `dist/cli.js` exists, then run `doctor`.
A stdio server also exits normally when its owning client closes stdin. Check
the host's MCP output for the safe error event rather than redirecting protocol
stdout to a shared log.

### Inspect running processes

Multiple children can be expected while multiple hosts or sessions are open:

```bash
pgrep -fl 'dist/cli.js serve'
```

Close or restart them through the owning MCP host. Do not kill unrelated Node
processes and do not add a `launchd` job to keep these children alive.

## Verification levels

Use the smallest level that answers the question:

```bash
# Offline fake endpoints; safe without a running model
mise run delegate:check

# Compiled stdio protocol integration
mise run delegate:test-protocol

# Native configured-host discovery and status
mise run delegate:host-smoke

# Direct live backend status and workspace diagnostics
./dist/cli.js status --backend controller --json
./dist/cli.js doctor --backend controller --workspace-root "$PWD" --json
```

The opt-in live profile, evaluation, cross-host behavior, and offline
containment matrix is defined in
[`LOCAL-LLM-DELEGATION-RELEASE.md`](LOCAL-LLM-DELEGATION-RELEASE.md). Those
tests must run in a native context that can reach the selected loopback model
endpoint and must never establish or change model lifecycle state.

## Authoritative references

- [MCP stdio transport lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Official MCP TypeScript SDK server guide and Inspector example](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)
- [Codex MCP configuration and management](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Claude Code MCP configuration and management](https://code.claude.com/docs/en/mcp)
- [Copilot CLI MCP configuration and management](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [VS Code MCP server management](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [VS Code MCP configuration and sandbox options](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
