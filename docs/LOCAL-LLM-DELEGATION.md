# Local MLX Delegation Implementation Plan

Status: implementation-ready plan. The first release is a portable, read-only
MCP consultation tool for local agent clients backed by cloud models.

Implementation choices and still-open release questions are tracked in
[`LOCAL-LLM-DELEGATION-DECISIONS.md`](LOCAL-LLM-DELEGATION-DECISIONS.md).
Build, host configuration, native-loopback requirements, process management,
and troubleshooting are maintained in
[`LOCAL-LLM-DELEGATION-OPERATIONS.md`](LOCAL-LLM-DELEGATION-OPERATIONS.md).

## Goal

Allow a coordinator such as Codex, Claude Code, GitHub Copilot CLI, or another
standards-compliant MCP host to delegate bounded analysis to the local MLX
setup. The local model acts as an advisory sub-agent. The coordinator remains
responsible for orchestration, source verification, editing, and consequential
actions.

The available inference configuration may be:

- one Mac running a model through LM Studio;
- two Macs running independent model servers; or
- two Macs joined as an MLX distributed-inference cluster.

Success means the same compiled MCP server and the same two tool contracts work
from multiple agent hosts without relying on a host-specific skill for correct
or safe behavior.

## Scope

Version 1 will:

- implement a local stdio MCP server with the official TypeScript SDK v2;
- expose status and read-only delegation tools;
- support Codex, Claude Code, GitHub Copilot CLI, and VS Code/Copilot
  configuration;
- call the existing OpenAI-compatible local inference endpoints;
- select only models that are already running;
- collect explicit repository context inside a fixed workspace boundary;
- return structured backend, model, context, truncation, timing, and warning
  metadata;
- track backend availability across independently spawned MCP server processes;
- provide a direct CLI for diagnostics and non-MCP testing;
- enforce timeouts, concurrency limits, rate limits, safe logging, and stable
  error responses; and
- finish with cross-client behavioral integration tests.

Version 1 will not:

- edit files or execute local-model-proposed commands;
- start, stop, unload, or swap models;
- expose LM Studio broadly to the LAN;
- let a remotely hosted coding agent reach a Mac's loopback interface;
- depend on Codex Skills, `CLAUDE.md`, or Copilot instructions for safety;
- implement automatic proactive delegation; or
- treat local-model output as verified fact.

A remote Streamable HTTP deployment is a later phase. It requires an
authenticated, encrypted path into the local network and a separate threat
model; merely enabling an HTTP transport is insufficient.

## Existing system

This repository already supports two primary inference paths:

1. **Single Mac:** LM Studio exposes an OpenAI-compatible endpoint at
   `http://127.0.0.1:1234/v1`.
   - Fast: Qwen3-Coder-30B-A3B-Instruct 4-bit.
   - Higher precision: Qwen3-Coder-30B-A3B-Instruct 8-bit.
2. **Distributed cluster:** `mlx_lm.server` exposes an OpenAI-compatible
   endpoint at `http://127.0.0.1:8080/v1` on the M5 controller.
   - Fast: Qwen3.5-35B-A3B 4-bit.
   - Deep/overnight: Qwen3.5-122B-A10B 4-bit.
   - Diagnostic: Llama 3.2 3B Instruct 4-bit.

The cluster uses an M5 Pro with 48 GB as rank 0 and an M4 Pro with 48 GB as
rank 1. It currently uses TCP ring over the direct Thunderbolt connection
because JACCL produced reproducible kernel panics on this pair.

Operational constraints:

- Distributed MLX shards supported models; it does not expose a general 96 GB
  shared-memory device.
- Both Macs need a complete model snapshot on disk.
- Both Macs must remain connected and awake during distributed inference.
- Cluster startup unloads LM Studio on both machines.
- Single-host and distributed modes are mutually exclusive resource modes
  unless benchmarks prove otherwise.
- A cluster is one inference worker even though it has two ranks.

Primary repository references:

- [`../README.md`](../README.md)
- [`CLUSTER.md`](CLUSTER.md)
- [`../mise.toml`](../mise.toml)
- [`../cluster/models.env`](../cluster/models.env)
- [`../shell/llm.zsh`](../shell/llm.zsh)

## Technology and language boundary

Use a root Node/TypeScript package for the delegation product:

- Node.js 24.19.0, pinned in `mise.toml`;
- TypeScript, compiled before clients launch the server;
- `@modelcontextprotocol/server` v2 for the MCP server;
- `@modelcontextprotocol/client` v2 as a test dependency;
- Zod v4 for input, output, and configuration schemas;
- the built-in `fetch`, `AbortSignal`, filesystem, hashing, and child-process
  APIs where practical; and
- pnpm 11.22.0 with a committed `pnpm-lock.yaml` for reproducible installation.

Keep Python for MLX-specific utilities and distributed-inference scripts. Keep
Bash and mise for machine setup, model lifecycle, and cluster orchestration.
Do not rewrite working Python or shell components merely for language
uniformity.

The TypeScript service must not import MLX libraries. It communicates with
inference engines only through their OpenAI-compatible HTTP APIs. This keeps
the MCP process lightweight and independently installable.

Pin exact dependency versions during implementation and update them
intentionally. Do not use unbounded `latest` references in generated client
configuration.

### Issue 11 configuration and diagnostic contract

The foundation package uses schema version 1 and resolves configuration in
this order: built-in defaults, an optional JSON file selected by `--config` or
`LOCAL_MLX_DELEGATE_CONFIG` (the flag wins), explicit
`LOCAL_MLX_DELEGATE_*` environment overrides, then invocation flags. The
connection and per-request health deadlines default to 1,000 ms and 2,000 ms.
Backend URLs are restricted to HTTP(S) loopback URLs without credentials,
query strings, or fragments.

Issue 11 registers only `local_llm_status`; `local_llm_delegate` begins in
issue 12. Each configured backend result includes its enabled and health
state, availability, complete sanitized visible-model catalog, loaded
generative-model list, safe endpoint, latency, resource groups, warnings,
startup hint, and nullable stable error. Generic OpenAI-compatible discovery
treats `/v1/models` as loaded. LM Studio discovery additionally reads
`/api/v1/models` and intersects its loaded LLM instances with the visible
catalog, excluding unloaded and embedding entries exposed by JIT loading. The
top-level model remains null when more than one loaded generative model is
present, and quality remains `unknown` until issue 12 adds explicit
classification.

The direct `status` and `doctor` commands are human-readable by default and
emit one schema-validated document with `--json`. Their exit codes are 0 for a
passed requested check, 1 for a valid unavailable/unloaded diagnostic, 2 for
usage or configuration errors, and 70 for unexpected software errors.

Issue 11 introduces no inbound HTTP API, so endpoint rate limiting does not
apply to that chunk. Cross-process request limits and lifecycle-independent
capacity controls were subsequently added in issue 13.

### Issue 12 safe delegation contract

Issue 12 adds `local_llm_delegate` and the matching direct `delegate` command.
The process canonicalizes one immutable workspace root before accepting
delegation, then reads only explicitly selected paths and an explicitly
requested tracked-file diff from `HEAD`. Context traversal rejects lexical and
symlink escapes plus directly requested sensitive paths; directory exclusions,
binary data, per-file limits, and aggregate limits are reported through the
deterministic manifest.

Prompt rendering labels repository text as untrusted and carries the task,
requested backend/quality, manifest, and delimited contents. Generation uses
the exact unambiguous loaded generative model ID, propagates the caller's
output-token limit, has a 120-second default deadline, and never retries an
ambiguous generation. Exact configured model-ID lists classify `fast` and
`deep`; unknown or ambiguous selections fail safely when a requested quality
cannot be satisfied.

Issue 12 did not implement shared leases, queues, cooldowns, or rate limits;
those controls are now provided by issue 13. `busy_behavior=wait` may use a
positive bounded `max_wait_seconds`; zero behaves as an immediate capacity
check. Fail-fast requests require zero.

### Issue 13 capacity-arbitration contract

Issue 13 adds a strict version-1 per-user availability registry with atomic
multi-resource leases, bounded heartbeats and expiry, conservative cooldowns,
overlapping-resource FIFO wait tickets, and a cross-process generation-start
rate window. Status and doctor project safe resource state, queue depth, lease
age, cooldown remaining time, and degraded-state diagnostics. The direct
`leases` command inspects the registry; only the explicit
`leases clear --lease-id UUID --confirm` administrative path may clear a
cooldown lease, and only after its backend health/model checks pass. MCP tools
have no clearing operation.

Automatic deep routing considers cluster, controller, then worker; other
automatic routing considers controller, worker, then cluster, preferring a
free compatible backend before a busy one. Explicit backend selection always
wins. The exact defaults and decisions made where this plan was intentionally
non-numeric are maintained in
[`LOCAL-LLM-DELEGATION-DECISIONS.md`](LOCAL-LLM-DELEGATION-DECISIONS.md).

## Architecture

```text
Codex / Claude Code / Copilot / another local MCP host
                         |
             client-owned MCP over stdio
                         |
       one local-mlx-delegate child per host session
       schemas, workspace guard, routing, limits
                         |
          +--------------+--------------+
          |                             |
 shared availability leases    OpenAI-compatible HTTP adapter
          |                             |
          `-----------------------------+
                         |
        +----------------+----------------+
        |                |                |
 controller :1234  worker :1235     cluster :8080
 LM Studio         SSH tunnel        mlx_lm.server
```

Separate the layers:

1. **Domain services** implement context collection, routing, availability,
   limits, backend calls, and result construction without importing the MCP
   SDK.
2. **MCP transport** registers typed tools, converts domain results into MCP
   results, and serves stdio.
3. **CLI** calls the same domain services for `status`, `delegate`, `doctor`,
   configuration generation, and tests.
4. **Client integrations** generate thin host-specific configuration pointing
   at the same compiled executable.
5. **Optional agent guidance** explains when and how to delegate, but does not
   contain implementation or mandatory safety controls.

The stdio host owns the child process, stdin, stdout, and shutdown. Independent
hosts therefore create independent children, which is expected; shared
coordination state arbitrates their backend capacity. Do not daemonize the
stdio server with `launchd` or another supervisor because a separately owned
process cannot supply the protocol pipes for a client session. A persistent
shared server would require a later authenticated Streamable HTTP transport.

The child opens no inbound network listener. Its backend HTTP requests must run
in the same native macOS network context as the configured loopback endpoint.
A container, remote workspace, remote executor, or restricted sandbox has a
different `127.0.0.1` unless specifically bridged; version 1 deliberately does
not broaden its loopback-only URL contract to support those environments.

The server's MCP `instructions`, tool descriptions, schemas, and deterministic
checks must contain everything required for safe operation. Put the most
important cross-tool guidance first so clients with instruction limits still
receive it.

## Topology recommendation

Use a switchable hybrid design rather than committing to only sharded or only
independent operation.

| Mode                | Hardware              | Preferred use                                          |
| ------------------- | --------------------- | ------------------------------------------------------ |
| Single fast         | One Mac, 30B 4-bit    | Summaries, extraction, bounded diff review, test ideas |
| Single HQ           | One Mac, 30B 8-bit    | Careful review when the 30B model is sufficient        |
| Cluster deep        | Both Macs, 122B 4-bit | Ambiguous reasoning, architecture, broad review        |
| Independent workers | One model per Mac     | Two genuinely independent tasks in parallel            |
| Cluster fast        | Both Macs, 35B 4-bit  | Diagnostics and measured compatibility cases           |

The governing rule is:

> Link the Macs for model capacity and answer quality; keep them separate for
> request throughput.

Do not make distributed 35B the default merely because both Macs are
available. It occupies both machines and adds communication overhead while
remaining in roughly the same active-parameter class as single-Mac 30B. The
122B profile is the stronger reason to join the machines. Final thresholds
must come from comparable benchmarks rather than model size alone.

## MCP tool contracts

Begin with exactly two tools. Register explicit Zod input and output schemas
and return both human-readable `content` and matching `structuredContent`.

### `local_llm_status`

Input:

```text
backend: "auto" | "controller" | "worker" | "cluster" = "auto"
```

Output:

```text
ok
request_id
configured_backends[]
healthy_backends[]
selected_backend
endpoint
model
quality_class
availability
resource_groups[]
startup_hint
warnings[]
error
```

The tool reports configured endpoints, endpoint health, the sanitized visible
catalog from `/v1/models`, loaded generative candidates established by the
configured discovery mode, current topology, and actionable startup hints. It
must not change lifecycle state. LM Studio discovery uses read-only
`/api/v1/models` metadata to exclude JIT-visible unloaded and embedding models.

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

### `local_llm_delegate`

Input:

```text
task: string
cwd: absolute workspace path
paths: list[string] = []
include_diff: boolean = false
quality: "auto" | "fast" | "deep" = "auto"
backend: "auto" | "controller" | "worker" | "cluster" = "auto"
busy_behavior: "fail" | "wait" = "fail"
max_wait_seconds: integer = 0
max_input_chars: integer = 120000
max_output_tokens: integer = 4096
```

`max_input_chars` remains a caller-facing cap, but context packing also uses
the selected backend's configured `context_window_tokens`. The delegate
reserves the requested output plus a 10% (minimum 1,024-token) safety margin
before collecting source. Since the MCP does not own every backend tokenizer,
preflight uses a conservative two UTF-8 bytes-per-token estimate and reports
the estimate separately from upstream usage when available.

Output:

```text
ok
request_id
backend
endpoint
model
requested_quality
actual_quality
availability
answer
context_manifest[]
elapsed_seconds
queue_seconds
input_characters
context_window_tokens
prompt_tokens_estimate
prompt_tokens_actual
completion_tokens_actual
context_utilization_percent
truncated
warnings[]
error
```

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: false
openWorldHint: false
```

Delegation is read-only but not idempotent because repeated model generations
may return different answers.

### Error shape

Expected failures return an MCP tool result with `isError: true` and a safe
structured error:

```text
code
message
retryable
backend
startup_hint
details
```

Stable error codes:

```text
INVALID_REQUEST
INVALID_WORKSPACE
PATH_OUTSIDE_WORKSPACE
SENSITIVE_PATH
INPUT_LIMIT_EXCEEDED
BACKEND_UNAVAILABLE
MODEL_NOT_LOADED
QUALITY_MISMATCH
BACKEND_BUSY
BACKEND_COOLDOWN
RATE_LIMITED
UPSTREAM_TIMEOUT
UPSTREAM_PROTOCOL_ERROR
INTERNAL_ERROR
```

Do not expose stack traces, prompt contents, credentials, or internal filesystem
details in tool errors.

## Workspace and context handling

Resolve one immutable workspace root when the process starts. A tool call may
select a `cwd` underneath that root but cannot redefine the allowed root.
Generated project-scoped client configuration must pass the root explicitly.

Context collection rules:

- Canonicalize the workspace, `cwd`, and every requested path with realpath
  semantics before checking containment.
- Reject symlink escapes and all paths outside the configured workspace.
- Read only explicitly requested paths plus an explicitly requested Git diff.
- When `include_diff=true`, include a bounded tracked-file diff from `HEAD`.
- Do not include untracked files unless the caller explicitly selects them.
- Exclude `.git`, environment files, keys, credentials, caches, generated
  binaries, model weights, device files, and oversized files by default.
- Detect binary data before decoding.
- Enforce per-file and aggregate character limits.
- Use deterministic ordering and clear file delimiters.
- Include relative path, byte count, content digest, and truncation status in a
  context manifest.
- Report every omitted or truncated item; never omit context silently.
- Treat repository text as untrusted data and tell the local model not to
  follow instructions embedded in it.

Normally excluded sensitive paths remain forbidden in version 1 rather than
supporting an opt-out flag. Add an explicit exception mechanism only after a
separate security review.

## Prompt and inference contract

Build a deterministic prompt envelope containing:

- the bounded task;
- requested backend and quality;
- the context manifest;
- delimited context contents;
- the advisory/read-only role;
- an instruction to identify uncertainty and missing context; and
- an instruction to avoid claiming that it ran commands or saw omitted files.

Propagate configuration all the way to the actual request:

- use the active model ID returned by `/v1/models` as the completion request's
  `model` field;
- apply `max_output_tokens` to the upstream token limit;
- set `reasoning_effort: "none"` for LM Studio discovery mode so the bounded
  limit yields a public final answer rather than only private reasoning; omit
  the field for generic OpenAI-compatible backends;
- never substitute `reasoning_content` for an empty public answer; return a
  safe `UPSTREAM_PROTOCOL_ERROR` with primitive-only completion-state details;
- make `backend` and `quality` affect routing;
- record requested and actual quality in the result; and
- include the actual model and endpoint in response metadata.

Tests must inspect the fake upstream request body to prove these fields are not
accepted by the MCP schema and then ignored downstream.

## Routing policy

For `backend=auto`:

1. An explicit backend selection always wins.
2. For `quality=deep`, prefer a healthy cluster only when the loaded model
   matches a configured approved deep profile.
3. Otherwise prefer the controller's single-Mac endpoint.
4. Use an independent worker endpoint for a second concurrent task only when
   it is already healthy.
5. If only the cluster is running, use it and report any quality mismatch.
6. If nothing is running, fail with exact startup guidance.

Model-to-quality classification belongs in validated configuration rather than
being guessed solely from model-name size. The adapter uses the model ID
reported by the active server instead of assuming the configured profile is
loaded.

For an independent worker, prefer an SSH tunnel from controller port 1235 to
worker loopback port 1234. Do not broadly expose LM Studio to the LAN. Tunnel
creation and model lifecycle stay outside the MCP server.

## Timeouts, concurrency, and rate limiting

Configure separate timeouts for connection, health checks, and generation.
Use `AbortSignal` so cancellation reaches HTTP and file operations where
supported.

Protect physical resources with named resource groups:

- controller and cluster share the controller resource group;
- cluster also reserves the worker resource group;
- an independent worker uses the worker resource group; and
- default to one generation at a time per physical host.

The default queue capacity is eight requests. This bounds backlog without
mistaking a large queue for available model memory.

### Shared availability coordinator

Do not use only an in-memory semaphore. Codex, Claude Code, Copilot, and a
direct CLI invocation may each spawn an independent MCP server process. They
must coordinate through one local, cross-process availability registry.

Implement the registry as a versioned JSON state file under the user's local
application-state directory. Use an atomically created mutex directory for
short read-modify-write transactions, and commit state with a temporary file,
flush, and atomic rename. Record the mutex owner and creation time so a process
can recover a mutex abandoned during a crash; recovering that short-lived
state mutex does not itself clear any generation lease. Each active lease
records:

```text
lease_id
request_id
owner_pid
owner_instance_id
backend
resource_groups[]
model
started_at
heartbeat_at
expires_at
state
```

The allocation transaction must reserve every resource group needed by a
request atomically. A cluster request reserves both controller and worker so it
cannot race an independent request on either Mac. The global allocation mutex
is held only while reading and updating lease state, never during generation.

Expose these availability states through `local_llm_status`:

```text
offline     endpoint is not healthy
ready       endpoint is healthy and required resource groups are free
busy        an active lease owns at least one required resource group
queued      the current request has a bounded wait ticket
cooldown    an ambiguous timeout or cancellation may still be running upstream
degraded    lease state or endpoint health cannot be reconciled safely
```

Update active leases with a heartbeat. Release them immediately after a known
successful or known failed completion. After an ambiguous timeout, client
disconnect, or cancellation, move the affected resource groups to `cooldown`
for a configurable grace period rather than immediately allowing another
heavy request. A dead owner process alone is not proof that the upstream model
stopped generating.

Default `busy_behavior` to `fail`: return `BACKEND_BUSY` or
`BACKEND_COOLDOWN` immediately with the active model, busy duration, and a
bounded retry hint. `busy_behavior=wait` may create a FIFO wait ticket, but
must honor `max_wait_seconds`, the MCP tool timeout, queue capacity, and
cancellation. Never wait indefinitely.

Provide a diagnostic CLI command to inspect leases and a deliberately explicit
administrative command to clear a stale/cooldown lease after health checks and
confirmation. MCP tools must never force-clear another request's lease.

Apply rate limits through the same cross-process state boundary so launching a
second client does not create a fresh allowance. Return `RATE_LIMITED` with a
retry hint when exceeded.

Retry idempotent health and model-list requests only. Do not automatically
retry a generation after an ambiguous timeout because the first request may
still be consuming resources.

## Logging and diagnostics

For stdio, stdout is reserved exclusively for MCP protocol frames. Send
structured JSON diagnostics to stderr.

Log:

- request ID and tool name;
- backend and model;
- input/output sizes;
- queue and generation durations;
- final status or stable error code; and
- process-level startup and shutdown events.

Do not log:

- prompts or source contents;
- model answers;
- credentials or environment-variable values; or
- absolute requested paths by default.

Provide `local-mlx-delegate doctor` to validate the compiled server,
configuration, workspace boundary, endpoint reachability, loaded models, and
client configuration without changing system state.

## Portable client integration

The server is the portable product. Host integrations are configuration
adapters only.

Provide an idempotent generator:

```text
local-mlx-delegate configure codex
local-mlx-delegate configure claude
local-mlx-delegate configure copilot-cli
local-mlx-delegate configure vscode
```

Every command requires `--workspace-root PATH` and accepts `--json`. The
command prints a reviewable configuration by default. `--apply` performs
an atomic update after creating a timestamped backup. Repeated application must
update the existing named entry rather than duplicate it.

Generate:

- project-scoped `.codex/config.toml` for Codex;
- one project-scoped `.mcp.json` entry compatible with Claude Code and Copilot
  CLI, preserving unrelated servers already present; and
- `.vscode/mcp.json` for VS Code/Copilot.

Each configuration invokes the same compiled command through its canonical
absolute executable path, fixing the canonical workspace root explicitly:

```text
/absolute/repository/dist/cli.js serve --workspace-root /absolute/repository
```

The current compiled entrypoint uses `#!/usr/bin/env node`; the absolute CLI
path therefore still depends on the host application's inherited `PATH`
resolving the pinned Node 24 runtime. Native inherited environments have passed
live MCP delegation, while an intentionally stripped environment produced an
upstream protocol failure whose exact cause remains unisolated. Track absolute
Node invocation, a tested minimum explicit environment, and safe doctor checks
as compatibility hardening. Do not document raw environment values or assume
that the shebang explains an upstream error without a focused reproduction.

Use the server name `local-mlx-delegate`. The shared Claude/Copilot entry uses
`type: "stdio"`, which both native schemas accept; VS Code uses the same entry
under its `servers` root. Accept JSONC input and preserve unrelated servers and
top-level fields; a changed file is emitted as normalized JSON. Reject files
over 1 MiB and any target path containing a symlink.
Existing files receive mode-0600 backups named
`FILE.backup-<compact UTC ISO timestamp>` only when bytes change; the atomic
replacement preserves the existing target mode. New project configuration
files use mode 0644.

Verify discovery with `codex mcp list --json`,
`claude mcp get local-mlx-delegate`,
`copilot mcp get local-mlx-delegate --json`, and VS Code's **MCP: List
Servers** command. Invoke `local_llm_status` explicitly in each host. Claude,
Copilot CLI, and Codex project configurations remain subject to their native
workspace trust/approval controls.
Do not claim support based only on generating syntactically valid config; the
behavioral tests must exercise real host calls.

Each host is also the process manager for its own stdio child. VS Code's **MCP:
List Servers** command provides start, stop, restart, enable/disable, and output
inspection. Codex and Claude expose equivalent discovery and status through
their native MCP commands and `/mcp` interfaces. For protocol debugging, use
the official MCP Inspector and let it launch the compiled server; do not
pre-launch or supervise a second child.

Locally running cloud-model clients can use stdio because the client process
runs on the Mac. Live checks must likewise run outside agent-shell sandboxes
whose network context cannot reach the host's loopback. A remotely hosted
coding agent, VS Code remote workspace, or container cannot reach the Mac's
loopback backend through this design merely by spawning the stdio server there.
Treat remote access as a separate future delivery mode using authenticated
Streamable HTTP, TLS, origin/host validation, explicit network policy, and
audit logging. The normative operator procedure is maintained in
[`LOCAL-LLM-DELEGATION-OPERATIONS.md`](LOCAL-LLM-DELEGATION-OPERATIONS.md).

## Optional agent guidance

Create a concise repository skill at:

```text
.agents/skills/local-mlx-delegate/
|-- SKILL.md
|-- agents/
|   `-- openai.yaml
`-- references/
    `-- routing.md
```

Use the standard skill initializer and validator. Keep `SKILL.md` focused on:

- appropriate bounded delegation tasks;
- when not to delegate;
- choosing fast versus deep quality;
- validating local findings; and
- responding to status and quality mismatch results.

Keep detailed routing guidance in the directly linked reference. Do not place
the server implementation inside the skill. Install the tracked skill for
cross-repository use with a symlink under `~/.agents/skills` when requested.

Claude and Copilot may receive equivalent concise instruction fragments, but
basic discovery, safety, and correct tool usage must work without them.
Explicit invocation comes first; consider proactive delegation only after
evaluation demonstrates measurable value.

## Proposed tracked layout

```text
package.json
pnpm-lock.yaml
tsconfig.json
src/
|-- cli.ts
|-- config.ts
|-- contracts.ts
|-- context.ts
|-- errors.ts
|-- limits.ts
|-- logging.ts
|-- routing.ts
|-- service.ts
|-- backends/
|   |-- openai-compatible.ts
|   `-- types.ts
`-- mcp/
    `-- server.ts
tests/
|-- unit/
|-- integration/
|-- behavior/
|   |-- fixture-repo/
|   `-- scenarios/
`-- fakes/
integrations/
|-- codex/
|-- claude/
|-- copilot-cli/
`-- vscode/
.agents/skills/local-mlx-delegate/
|-- SKILL.md
|-- agents/openai.yaml
`-- references/routing.md
```

Potential mise tasks:

```text
delegate:install          Install pinned pnpm dependencies
delegate:build            Compile TypeScript
delegate:check            Run formatting, linting, type checking, and tests
delegate:doctor           Inspect config, endpoints, models, and clients
delegate:status           Report endpoints and loaded models
delegate:consult          Run a bounded direct consultation
delegate:test-protocol    Exercise schemas and stdio through an MCP client
delegate:test-single      Run a live single-host consultation
delegate:test-cluster     Run a live cluster consultation
delegate:test-behavior    Run the final cross-client scenarios
delegate:eval             Run comparable model evaluation workloads
```

## Test strategy before the release gate

### Unit tests

Cover:

- configuration parsing and environment overrides;
- routing and quality classification;
- canonical workspace containment and symlink escapes;
- exclusions, binary detection, deterministic manifests, and truncation;
- prompt rendering;
- queueing, concurrency groups, rate limits, and cancellation;
- cross-process lease allocation, heartbeat, expiry, and cooldown recovery;
- stable error mapping; and
- redacted structured logging.

### Adapter integration tests

Run against a fake OpenAI-compatible HTTP server and cover:

- healthy and unhealthy `/v1/models` responses;
- active model discovery;
- completion success and malformed responses;
- connection, health, and generation timeouts;
- quality mismatch and unavailable backend behavior;
- no retry after an ambiguous generation timeout; and
- exact propagation of model, token limit, task, and context.

### MCP protocol integration tests

Use `@modelcontextprotocol/client` to:

- list tools and inspect their schemas and annotations;
- call both tools in process;
- assert `structuredContent` matches the declared output schema;
- assert expected failures set `isError: true`;
- spawn the compiled stdio process through the real client transport;
- race calls through two independent stdio server processes and prove only one
  capacity-one lease reaches the upstream endpoint;
- prove stdout contains protocol traffic only; and
- prove shutdown cancels outstanding work cleanly.

### Configuration and live integration tests

- Snapshot and parse generated config for every supported host.
- Apply each config twice and prove the operation is idempotent.
- Verify backups and atomic failure recovery.
- Run opt-in live tests against single-Mac and cluster endpoints.
- Keep live-model tests out of ordinary offline CI.

## Evaluation plan

Run identical workloads against single 4-bit, single 8-bit, distributed 35B,
and distributed 122B modes:

1. A short, approximately 2K-token summary.
2. A roughly 10K-token diff review.
3. A roughly 25K-token multi-file analysis.
4. Structured extraction with a fixed expected schema.
5. Deliberately tricky bug-finding cases with known answers.

Record model load/startup time, time to first token, prompt-processing rate,
generation rate, total wall-clock time, peak memory, response validity, and
correctness against expected results.

Use measurements to establish routing thresholds:

- Keep distributed 35B diagnostic-only if it does not materially outperform
  single 30B on quality or latency.
- Prefer independent hosts when two separate requests finish faster than the
  cluster can process them.
- Use 122B when its quality improvement justifies cluster startup time and
  operational fragility.

The existing `mise run cluster:benchmark` task is the starting point, but the
delegation evaluation must use identical prompts and metrics for every
backend.

## Technical references

- [Official MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP TypeScript SDK v2 testing](https://ts.sdk.modelcontextprotocol.io/v2/testing.html)
- [MCP stdio transport lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [Official MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [MCP tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex skill authoring](https://learn.chatgpt.com/docs/build-skills)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [GitHub Copilot CLI MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [LM Studio reasoning controls](https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.8)

## Delivery chunks and GitHub issue plan

Implement version 1 as five substantial, ordered chunks. Each chunk is sized
for one focused implementation PR and must finish at a behavior-testable
surface, not merely at an internal module boundary. A later chunk may extend a
surface delivered earlier, but it must not invalidate its published contract.

Every chunk must include its production code, focused unit tests, integration
tests, documentation updates, and mise/pnpm commands needed to reproduce its
acceptance checks. Keep opt-in tests that require a running local model separate
from the default offline check.

GitHub tracking:

- Milestone: [v1 - Portable Local LLM Delegation](https://github.com/dustinmays/local-llm/milestone/1)
- Chunk 1: [issue #11](https://github.com/dustinmays/local-llm/issues/11)
- Chunk 2: [issue #12](https://github.com/dustinmays/local-llm/issues/12)
- Chunk 3: [issue #13](https://github.com/dustinmays/local-llm/issues/13)
- Chunk 4: [issue #14](https://github.com/dustinmays/local-llm/issues/14)
- Chunk 5: [issue #15](https://github.com/dustinmays/local-llm/issues/15)

### Chunk 1: TypeScript foundation, status, and diagnostics

Deliver:

1. Add the pinned Node/TypeScript toolchain, root pnpm package, compiled binary,
   formatting, linting, type checking, and offline test commands.
2. Define and test Zod configuration, status, manifest, and stable error
   schemas.
3. Implement the OpenAI-compatible health and `/v1/models` adapter with
   connection and health timeouts.
4. Implement redacted structured logging and request IDs, reserving stdout for
   MCP frames.
5. Register `local_llm_status` with the official MCP TypeScript SDK v2 and add
   `serve`, `status`, and the non-mutating portion of `doctor` to the direct
   CLI.

Behavior-testable surfaces:

- MCP `local_llm_status`;
- `local-mlx-delegate status`; and
- `local-mlx-delegate doctor`.

Acceptance behavior:

- A real MCP client can spawn the compiled stdio server, list the status tool,
  and receive schema-valid structured content.
- Fake healthy, unloaded, malformed, slow, and unreachable endpoints produce
  the documented model metadata, startup hints, timeouts, and stable errors.
- Stdout contains MCP protocol traffic only; stderr diagnostics contain request
  metadata without endpoint credentials or absolute workspace paths.

This chunk establishes the package and public status contract used by every
later chunk.

### Chunk 2: Safe delegation pipeline

Deliver:

1. Implement immutable workspace-root resolution, explicit context packing,
   exclusions, deterministic manifests, binary detection, and truncation.
2. Implement deterministic prompt construction and the OpenAI-compatible
   completion adapter with cancellation and generation timeouts.
3. Implement explicit backend selection and configured model-to-quality
   classification sufficient for a single delegation.
4. Register `local_llm_delegate` and add the direct `delegate` command.
5. Normalize all documented workspace, upstream, model, and quality failures
   into safe MCP and CLI results.

Behavior-testable surfaces:

- MCP `local_llm_delegate`; and
- `local-mlx-delegate delegate`.

Acceptance behavior:

- A spawned stdio MCP server completes a consultation against a fake inference
  server and returns schema-valid answer and manifest metadata.
- The fake server proves that the actual loaded model ID, requested token
  limit, task, selected paths, diff, and quality reach the upstream request.
- Direct traversal and symlink escapes, sensitive files, oversized input,
  malformed responses, and ambiguous timeouts fail safely without repository
  writes or generation retries.

This chunk depends on chunk 1 and produces a useful single-request tool before
adding multi-client scheduling.

### Chunk 3: Routing and cross-process capacity arbitration

Deliver:

1. Implement the complete explicit/automatic routing policy and quality
   mismatch behavior for controller, worker, and cluster backends.
2. Add the shared, versioned lease registry with atomic multi-resource
   allocation, heartbeats, abandoned-mutex recovery, and conservative
   cooldowns.
3. Add fail-fast busy handling, bounded FIFO wait tickets, cancellation, queue
   limits, and cross-process rate limits.
4. Extend status and doctor output with availability, resource-group, queue,
   lease-age, cooldown, and degraded-state diagnostics.
5. Add the explicit, confirmation-gated administrative lease inspection and
   clear commands; MCP tools must remain unable to clear leases.

Behavior-testable surfaces:

- `local_llm_status` availability transitions;
- `local_llm_delegate` with `busy_behavior=fail|wait`; and
- lease inspection through `local-mlx-delegate doctor` or a dedicated
  diagnostic subcommand.

Acceptance behavior:

- Two independent compiled stdio server processes race against one slow fake
  capacity-one backend, and exactly one initial request reaches upstream.
- The loser receives structured `BACKEND_BUSY`, or waits FIFO and starts only
  after release; bounded waits and cancellation terminate cleanly.
- Cluster allocation atomically reserves both physical resource groups.
- Ambiguous timeout enters cooldown, status reports the transition, and a new
  request cannot overlap the possibly running generation.
- Shared rate limits cannot be bypassed by launching a second MCP process.

This chunk depends on chunk 2 and closes the heavy-model single-thread safety
risk before multiple hosts are configured.

### Chunk 4: Portable host integration and optional guidance

Deliver:

1. Implement review-first `configure codex`, `configure claude`,
   `configure copilot-cli`, and `configure vscode` commands.
2. Add atomic `--apply`, timestamped backups, preservation of unrelated MCP
   servers, and idempotent updates of the named server entry.
3. Add parse/snapshot tests, native host discovery checks, and the mise install,
   build, doctor, protocol-test, and host-smoke tasks.
4. Initialize and validate the optional concise Codex skill and equivalent
   Claude/Copilot guidance, keeping all correctness and safety in the server.
5. Document installation, discovery, invocation, removal, and recovery from a
   failed configuration update for every host.

Behavior-testable surfaces:

- `local-mlx-delegate configure <host>` preview and `--apply`; and
- native MCP discovery/status calls in Codex CLI, Claude Code, GitHub Copilot
  CLI, and VS Code/Copilot.

Acceptance behavior:

- Generated files parse in their native formats and invoke the same compiled
  command with the fixed workspace root.
- Applying every configuration twice produces no duplicate entry or second
  semantic change, preserves unrelated entries, and creates recoverable
  backups only when content changes.
- Each installed CLI host discovers and invokes `local_llm_status`; VS Code
  completes an equivalent discovery-and-call smoke check.
- The same calls still work when optional skill and instruction files are
  absent.

This chunk depends on chunk 3 so enabling several clients cannot bypass local
capacity controls.

### Chunk 5: Live backends, evaluation, and release behavior

Deliver:

1. Exercise and document single-Mac 4-bit and 8-bit modes plus cluster fast and
   deep modes; add the worker tunnel path only after the primary paths pass.
2. Run identical evaluation workloads, capture performance/correctness
   evidence, and turn measured results into routing thresholds.
3. Complete operational docs and opt-in live mise tasks without putting model
   requirements in ordinary offline CI.
4. Run and retain evidence for both final behavioral integration scenarios
   below across Codex CLI, Claude Code, GitHub Copilot CLI, and VS Code/Copilot.
5. Fix any contract, portability, containment, or scheduling defect exposed by
   the release scenarios.

Behavior-testable surfaces:

- live `local_llm_status` and `local_llm_delegate` through every supported
  host;
- `delegate:test-single`, `delegate:test-cluster`, `delegate:eval`, and
  `delegate:test-behavior`; and
- the two cross-client behavioral scenarios below.

Acceptance behavior:

- Live status, delegation, mismatch, timeout, and capacity behavior match the
  tool contracts for every supported topology.
- Routing defaults are supported by recorded comparable measurements rather
  than model names or parameter counts alone.
- Both final behavioral scenarios pass with host transcripts and redacted
  server logs retained as release evidence.

This chunk depends on chunk 4 and is the version 1 release gate.

Implementation note (2026-08-17): the opt-in Issue 15 harness and redacted
evidence schemas are implemented. The reproducible operator sequence is in
[the v1 release runbook](LOCAL-LLM-DELEGATION-RELEASE.md). Live release evidence
is still required; implementation of a gate is not itself a passing gate.

## Final behavioral integration tests

These scenarios are the last implementation phase and the release gate. Run
them only after all offline, protocol, configuration, and live-backend tests
pass. Use a live local model and retain host transcripts plus server logs as
test evidence. Assert behavioral invariants rather than exact model wording.

### Behavioral test 1: Cross-client delegation and capacity arbitration

Run the same bounded bug-review request from Codex CLI, Claude Code, and GitHub
Copilot CLI against a fixture repository containing a small, high-signal known
defect. Perform a VS Code/Copilot discovery-and-call smoke test with the same
fixture.

After the sequential calls pass, start overlapping long-running delegations
from two different clients against a backend configured with capacity one.
Run once with fail-fast behavior and once with a bounded wait ticket.

Pass criteria:

- Every client discovers and invokes `local_llm_delegate`.
- Every invocation uses the same compiled server and tool schemas.
- The request reaches the local inference endpoint rather than being answered
  as if delegation occurred.
- Workspace, selected paths, diff, requested quality, model ID, and output
  limit reach the upstream request correctly.
- The response identifies the actual backend and model.
- The context manifest includes only approved fixture files.
- The local model identifies the known defect or provides a candidate that the
  coordinator explicitly checks against source.
- The coordinator treats the local result as advisory.
- No repository file changes during the consultation.
- Logs contain correlation metadata but no prompt or source contents.
- Exactly one overlapping request acquires the capacity-one lease and reaches
  the upstream endpoint initially.
- The fail-fast competitor receives structured `BACKEND_BUSY` metadata rather
  than starting a second generation.
- The bounded-wait competitor begins only after the first lease is released,
  or exits cleanly when its wait deadline expires.
- `local_llm_status` reports `busy`, ownership timing, queue depth, and the
  eventual return to `ready` without exposing prompt content.

### Behavioral test 2: Safe failure and containment

Run the same scenario from Codex CLI, Claude Code, and GitHub Copilot CLI with
no inference backend running. Then attempt to include a direct path and a
symlink that escape the fixture workspace. Repeat the containment call from
VS Code/Copilot when its host automation permits it; otherwise record a manual
call transcript.

Pass criteria:

- `local_llm_status` reports unavailable backends and exact startup guidance.
- No model is started, stopped, loaded, unloaded, or swapped.
- Delegation returns a stable actionable error instead of fabricating a local
  result.
- Direct and symlink path escapes are rejected after canonicalization.
- Sensitive and outside-workspace files remain unread.
- No file is created or modified.
- Rate-limit and busy failures remain structured and do not crash the server.
- Logs contain request IDs and safe error metadata but no source contents or
  credentials.
- Each host explains the failure consistently and may continue with its own
  reasoning only if it clearly states that local delegation did not occur.

Version 1 is complete only when both behavioral scenarios pass in the three
CLI hosts and the VS Code/Copilot smoke checks pass, in addition to all unit,
adapter, MCP protocol, configuration, and live-backend tests.
