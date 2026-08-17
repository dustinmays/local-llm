# Local MLX Delegation v1 release runbook

This runbook is the opt-in release gate for Issue 15. The harness is read-only
with respect to inference lifecycle: it never starts, stops, loads, unloads, or
swaps a model. Establish each requested topology manually, run its checks, and
then change topology manually before continuing.

Ordinary CI does not use a live model:

```bash
mise install
mise run delegate:install
mise run delegate:check
mise run delegate:test-protocol
```

Do not run a live step until those checks pass. Live results are written as
strict version-1 JSON under the gitignored `artifacts/delegate/` directory by
default. Set `LOCAL_MLX_DELEGATE_EVIDENCE_DIR` to select another local
directory.

## Evidence contract

Evidence records the commit, package/runtime versions, selected profile,
backend and model IDs, deterministic correctness scores, safe timings,
invariant outcomes, and allowlisted request log fields. Host stdout and stderr
are represented only by byte counts and SHA-256 digests. The files do not
retain prompts, source text, answers, response bodies, credentials, raw
environment values, or absolute workspace paths. Evidence files use mode
0600 and are written by flush plus atomic rename.

Startup time and upstream peak memory remain null unless an operator supplies
corroborating measurements from the model host. The read-only OpenAI-compatible
API does not expose those lifecycle values, and this harness will not control a
model merely to measure them.

## Profile matrix

Run the smoke and five identical evaluation workloads for every primary
profile. `LOCAL_MLX_DELEGATE_LIVE_PROFILE` is strict and accepts these values:

| Profile        | Backend       | Expected configured quality | Smoke task              |
| -------------- | ------------- | --------------------------- | ----------------------- |
| `single-fast`  | controller    | fast                        | `delegate:test-single`  |
| `single-deep`  | controller    | deep                        | `delegate:test-single`  |
| `cluster-fast` | cluster       | fast                        | `delegate:test-cluster` |
| `cluster-deep` | cluster       | deep                        | `delegate:test-cluster` |
| `worker-fast`  | worker tunnel | fast                        | `delegate:test-worker`  |
| `worker-deep`  | worker tunnel | deep                        | `delegate:test-worker`  |

Example for one manually loaded profile:

```bash
LOCAL_MLX_DELEGATE_LIVE_PROFILE=single-fast mise run delegate:test-single
LOCAL_MLX_DELEGATE_LIVE_PROFILE=single-fast mise run delegate:eval
```

Repeat for single deep, cluster fast, and cluster deep. Test the worker tunnel
only after all four primary profiles pass. The worker path uses the same
evaluation command with `worker-fast` or `worker-deep`.

The five workloads are stable fixtures approximating a 2K-token summary, a
10K-token tracked diff review, a 25K-token multi-file analysis, strict JSON
extraction, and a known cache-key defect. Validation uses fixed markers or an
exact JSON schema, not subjective model-name or parameter-count assumptions.
The streaming measurement captures time to first text, total time, and token
rates when usage is available.

After all four primary evaluation profiles have passing, complete evidence,
derive the provisional routing decision:

```bash
mise run delegate:recommend
```

This prints one strict JSON recommendation. It exits 1 while comparable
evidence is incomplete. A correctness difference greater than 0.05 selects the
higher-scoring profile; otherwise lower median delegation latency wins.
Cluster fast remains diagnostic-only when it improves correctness by no more
than 0.05 and is not faster. These thresholds remain provisional until the
full live matrix is recorded.

## Cross-host behavior gate

Build and explicitly configure/trust the project MCP server in Codex CLI,
Claude Code, GitHub Copilot CLI, and VS Code before this gate. Configuration is
never applied by the behavior task:

```bash
./dist/cli.js configure codex --workspace-root "$PWD" --apply
./dist/cli.js configure claude --workspace-root "$PWD" --apply
./dist/cli.js configure copilot-cli --workspace-root "$PWD" --apply
./dist/cli.js configure vscode --workspace-root "$PWD" --apply
mise run delegate:host-smoke
```

If a native executable is outside the task's `PATH`, set one of
`LOCAL_MLX_DELEGATE_CODEX_COMMAND`, `LOCAL_MLX_DELEGATE_CLAUDE_COMMAND`, or
`LOCAL_MLX_DELEGATE_COPILOT_COMMAND` to its exact executable path for the
behavior run. Executable paths are not retained in evidence.

With one qualifying profile already running, execute the ready/capacity
scenario:

```bash
LOCAL_MLX_DELEGATE_BEHAVIOR_SCENARIO=ready \
LOCAL_MLX_DELEGATE_LIVE_PROFILE=single-fast \
mise run delegate:test-behavior
```

The scenario sends the same known-defect consultation sequentially through
Codex, Claude, Copilot CLI, and an official MCP-client path equivalent to the
VS Code stdio integration. It then uses Codex as the capacity owner and Claude
as the competing client. One run verifies structured fail-fast `BACKEND_BUSY`;
another verifies a bounded FIFO wait and observed queue depth. Source bytes are
checked before and after.

For the failure/containment scenario, manually stop every inference backend
first, verify `./dist/cli.js status --json` reports no healthy backend, and run:

```bash
LOCAL_MLX_DELEGATE_BEHAVIOR_SCENARIO=offline \
mise run delegate:test-behavior
```

This checks unavailable status and delegation plus direct traversal and
symlink escapes in every CLI host and the VS Code-equivalent client. The
outside sentinel and tracked fixture must remain byte-identical. The harness
does not establish the offline state itself.

Version 1 is not released until every primary live profile, all three native
CLI hosts, the VS Code-equivalent smoke, both behavior scenarios, and the
offline/protocol gates pass with retained evidence. A missing client, untrusted
project configuration, unavailable model, or incomplete metric is a failed or
incomplete gate—not a skipped release requirement.
