# Local MLX Delegation Notes

Status: preliminary architecture notes for a future implementation-planning pass.
This document is not yet an implementation plan.

## Goal

Allow a cloud coordinator such as Codex or Claude to offload bounded work to
the local MLX setup, whether the available inference configuration is:

- one Mac running a model through LM Studio;
- two Macs running independent models; or
- two Macs joined as an MLX distributed-inference cluster.

The first implementation should treat the local model as a read-only
consultant. The cloud model remains responsible for orchestration, validation,
editing, and consequential actions.

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

Important operational constraints:

- Distributed MLX shards supported models; it does not expose a general 96 GB
  shared-memory device.
- Both Macs need a complete model snapshot on disk.
- Both Macs must remain connected and awake during distributed inference.
- Cluster startup unloads LM Studio on both machines.
- Single-host and distributed modes should therefore be considered mutually
  exclusive resource modes unless explicitly proven otherwise.
- Neither the skill nor its delegation tool should start, stop, unload, or
  swap models implicitly.

Primary repository references:

- [`../README.md`](../README.md)
- [`CLUSTER.md`](CLUSTER.md)
- [`../mise.toml`](../mise.toml)
- [`../cluster/models.env`](../cluster/models.env)
- [`../shell/llm.zsh`](../shell/llm.zsh)

## Topology recommendation

Use a switchable hybrid design rather than committing to only sharded or only
independent operation.

| Mode | Hardware | Preferred use |
|---|---|---|
| Single fast | One Mac, 30B 4-bit | Summaries, extraction, bounded diff review, test ideas |
| Single HQ | One Mac, 30B 8-bit | Careful review when the 30B model is sufficient |
| Cluster deep | Both Macs, 122B 4-bit | Ambiguous reasoning, architecture, broad review |
| Independent workers | One small model per Mac | Two genuinely independent tasks in parallel |
| Cluster fast | Both Macs, 35B 4-bit | Diagnostics, compatibility, or evidence-backed cases |

The governing rule is:

> Link the Macs for model capacity and answer quality; keep them separate for
> request throughput.

The distributed 35B model should not automatically be the default simply
because both Macs are available. It occupies both machines and adds
communication overhead while remaining in roughly the same active-parameter
class as the single-Mac 30B model. The 122B profile is the stronger reason to
join the machines because it enables a materially larger model that cannot fit
comfortably on either Mac alone.

This routing decision must ultimately be based on comparable local benchmarks,
not model size alone.

## Proposed architecture

```text
Cloud Codex / Claude
        |
        v
local-mlx-delegate skill
  routing and validation policy
        |
        v
Local stdio MCP server
  health checks, context packing,
  timeouts, response metadata
        |
        +-- controller :1234 -- single-Mac LM Studio
        +-- worker     :1235 -- SSH tunnel to worker LM Studio
        `-- cluster    :8080 -- two-Mac mlx_lm.server
```

Separate policy from mechanics:

- The **skill** explains when to delegate, which quality tier to request, what
  context is appropriate, and how the cloud agent must validate the result.
- A deterministic **adapter** probes endpoints, packages context, invokes the
  OpenAI-compatible API, handles errors, and reports metadata.
- A thin local **MCP server** exposes that adapter as typed, read-only tools.

MCP is a useful boundary because Codex and Claude can both invoke local stdio
servers. A direct CLI should still exist for testing and fallback. Support for
ChatGPT web would be a later concern because it requires a remote connector or
secure tunnel rather than a local stdio server.

## Initial tool surface

Begin with only two read-only tools:

### `local_llm_status`

Report:

- configured endpoints;
- endpoint health;
- loaded model IDs returned by `/v1/models`;
- current topology: controller, worker, or cluster;
- actionable startup hints when nothing is running.

This tool must not start or stop anything.

### `local_llm_delegate`

Tentative input contract:

```text
task: string
cwd: absolute workspace path
paths: list[string] = []
include_diff: boolean = false
quality: "auto" | "fast" | "deep" = "auto"
backend: "auto" | "controller" | "worker" | "cluster" = "auto"
max_input_chars: integer = 120000
max_output_tokens: integer = 4096
```

Tentative structured output:

```text
backend
endpoint
model
answer
elapsed_seconds
input_characters
truncated
warnings
```

The adapter should use the model ID reported by the active server instead of
assuming the configured model is loaded.

## Routing policy

For `backend=auto`:

1. An explicit backend selection always wins.
2. For `quality=deep`, prefer a healthy cluster only when the loaded model is
   the 122B profile or another explicitly approved deep profile.
3. Otherwise prefer the controller's single-Mac endpoint.
4. Use an independent worker endpoint for a second concurrent task when it is
   already healthy.
5. If only the cluster is running, use it but report the active model and any
   quality mismatch.
6. If nothing is running, fail clearly and return the exact relevant startup
   commands. Do not start a server automatically.

A cluster is one logical inference worker even though it contains two ranks.
Do not issue competing requests to both ranks. Two-host parallelism is only
available when the Macs are running independent model servers.

For an independent worker, prefer an SSH tunnel such as controller port 1235
to worker loopback port 1234. Do not broadly expose LM Studio to the LAN.

## Appropriate delegation tasks

Good initial tasks are bounded and independently verifiable:

- summarize selected files;
- review a bounded diff and return candidate findings;
- classify test failures or logs;
- extract symbols, interfaces, assumptions, or TODOs;
- suggest test cases;
- generate several implementation options;
- provide a second-opinion review.

Keep these with the cloud coordinator:

- final correctness decisions;
- security-sensitive conclusions;
- ambiguous architecture decisions without independent validation;
- file editing or repository mutation;
- consequential tool execution;
- tasks requiring most of a large repository just to understand the prompt.

Every local-model result should be treated as advisory. The cloud agent must
verify findings against source files or tests before acting on them.

## Safety and context handling

The first version should be deliberately read-only:

- Do not expose file-write, shell-execution, or lifecycle-management tools to
  the local model.
- Resolve every requested path and reject paths outside `cwd`.
- Exclude `.git`, `.env` files, keys, credentials, caches, generated binaries,
  and oversized files by default.
- Require explicit opt-in for normally excluded paths.
- Include a context manifest so the answer identifies what it actually saw.
- Report truncation rather than silently omitting context.
- Do not retain prompts or source code in logs by default.
- Keep all inference endpoints bound to loopback.
- Apply explicit health and generation timeouts.
- Limit one generation at a time per physical host unless benchmarks prove
  safe concurrent behavior.

## Suggested tracked layout

```text
.agents/skills/local-mlx-delegate/
|-- SKILL.md
|-- agents/
|   `-- openai.yaml
|-- scripts/
|   |-- server.py
|   `-- delegate.py
`-- references/
    `-- routing.md
```

Keep the skill source-controlled in this repository. Install it for use in any
repository by symlinking it to:

```text
~/.agents/skills/local-mlx-delegate
```

Codex supports symlinked skill folders. The future implementation should use
the standard skill initializer and validator rather than hand-building the
skill metadata.

Potential `mise` tasks:

```text
delegate:install       Install dependencies and the global skill symlink
delegate:status        Report endpoints and loaded models
delegate:test-single   Run a deterministic single-host consultation
delegate:test-cluster  Run a deterministic cluster consultation
delegate:test-tools    Exercise the MCP contracts
delegate:eval          Run comparable evaluation workloads
```

## Evaluation plan

Run identical workloads against single 4-bit, single 8-bit, distributed 35B,
and distributed 122B modes:

1. A short, approximately 2K-token summary.
2. A roughly 10K-token diff review.
3. A roughly 25K-token multi-file analysis.
4. Structured extraction with a fixed expected schema.
5. A small set of deliberately tricky bug-finding cases with known answers.

Record:

- model load/startup time;
- time to first token;
- prompt-processing rate;
- generation rate;
- total wall-clock time;
- peak memory;
- response validity;
- correctness against expected results.

Use those results to establish routing thresholds:

- Keep distributed 35B diagnostic-only if it does not materially outperform
  single 30B on quality or latency.
- Prefer independent hosts when two separate requests finish faster than the
  cluster can process them.
- Use 122B when its quality improvement justifies cluster startup time and
  operational fragility.

The existing `mise run cluster:benchmark` task is the starting point, but the
future suite must use identical prompts and metrics for every backend.

## Proposed implementation sequence

1. Define the evaluation tasks and expected answers.
2. Implement the backend-neutral adapter with fake HTTP-server unit tests.
3. Add `status` and single-Mac integration tests.
4. Implement the two read-only MCP tools.
5. Initialize and write the Codex skill.
6. Add the global symlink installer and `mise` tasks.
7. Add cluster integration against the existing port 8080 server.
8. Run the evaluation suite and tune routing from measured results.
9. Add the optional worker SSH tunnel and two-task scheduler.
10. Only after the advisory workflow is dependable, evaluate a native local
    Codex subagent with read-only tools.

## Open questions for the implementation-planning agent

1. Should the adapter and MCP server live entirely inside the skill, or should
   reusable code live under a top-level package with the skill as a thin
   policy layer?
2. Which MCP Python SDK version should be pinned alongside the current
   `mlx==0.32.0` and `mlx-lm==0.31.3` environment?
3. Should the worker tunnel be managed by a `mise` task, `launchd`, or remain a
   manually started SSH process?
4. What exact model-quality signals should distinguish `fast` from `deep`?
5. Should `auto` fall back from a requested deep model to single-host inference
   or fail and ask the user to start the cluster?
6. How should context be selected: explicit paths only, Git diff, tracked-file
   globbing, or a combination?
7. What input budget is safe for the 122B cluster under the current 4 GB prompt
   cache and memory headroom?
8. Does LM Studio serialize requests on one model, and does the worker need a
   queue even when only one cloud agent is using it?
9. Should Claude Code integration be included in the first implementation or
   validated after Codex works?
10. What measurable improvement is required before enabling proactive local
    delegation rather than explicit `$local-mlx-delegate` invocation?

## External references

- [MLX-LM repository and distributed inference support](https://github.com/ml-explore/mlx-lm)
- [MLX multi-machine discussion and communication-overhead caveat](https://github.com/ml-explore/mlx/issues/1046)
- [MLX-LM server documentation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)
- [Official MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server)
- [Official MCP Python SDK](https://py.sdk.modelcontextprotocol.io/)
- [Codex skill authoring documentation](https://learn.chatgpt.com/docs/build-skills)
