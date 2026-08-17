# Local MLX Delegation Decision Log

This log records choices that were not fully specified by the implementation
plan, plus decisions that remain open for later chunks. Future implementation
work should update this file when it fixes an unspecified value, changes a
choice below, or discovers a new release decision.

Status values are `accepted`, `provisional`, `superseded`, and `open`.

## Accepted decisions

### D001 — Additive configuration remains schema version 1

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: Issue 13 adds a strict `coordination` section while retaining
  configuration schema version 1. Existing version-1 partial configuration
  files remain valid because all new values have built-in defaults.
- Revisit when: a change cannot preserve the meaning or validity of an
  existing version-1 file.

### D002 — Per-user availability state and override boundary

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: Shared state lives in the platform's per-user application-state
  directory: `~/Library/Application Support/local-mlx-delegate` on macOS,
  `$XDG_STATE_HOME/local-mlx-delegate` (or `~/.local/state/...`) on Linux, and
  `%LOCALAPPDATA%/local-mlx-delegate` on Windows. Tests use isolated temporary
  directories. `LOCAL_MLX_DELEGATE_STATE_DIRECTORY` may override the location.
- Security boundary: the JSON config-file overlay cannot select the state
  directory. This prevents repository-controlled configuration from directing
  coordinator writes to an arbitrary local path.

### D003 — Registry storage and mutex recovery

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: Registry state is strict version-1 JSON in
  `availability-v1.json`. Transactions use an atomically created
  `availability-v1.lock` directory with a unique mutex ID, PID, process-instance
  ID, and creation time. Writes use a mode-0600 exclusive temporary file,
  flush, atomic rename, and directory flush. A mutex older than the configured
  stale threshold may be atomically renamed and removed. Lock ownership is
  revalidated before committing and releasing. Recovering the short-lived
  mutex never clears a generation lease.

### D004 — FIFO means FIFO for overlapping physical resources

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: A ticket cannot pass an earlier ticket whose resource groups
  overlap its own. Requests for disjoint physical resources may proceed in
  parallel. Cluster allocation reserves `controller` and `worker` in one state
  transaction.
- Rationale: this preserves fairness for contending work without introducing
  global head-of-line blocking between independent Macs.

### D005 — Rate limits count generation starts globally

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: The cross-process sliding window counts successful generation
  lease allocations, not status probes, failed busy attempts, or queue polls.
  The limit is shared across all configured backends and processes using the
  registry. A waiting ticket retains FIFO position while awaiting both capacity
  and a rate allowance.

### D006 — Complete automatic routing order

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: Explicit backend selection always wins. Automatic `deep` routing
  checks `cluster`, `controller`, then `worker`; automatic `auto`/`fast`
  routing checks `controller`, `worker`, then `cluster`. Busy resources remain
  routable so the coordinator can return precise busy/cooldown metadata or
  queue the request. If the cluster is the only healthy backend and has one
  unambiguous model, an automatic quality mismatch is allowed with an explicit
  warning and the actual quality in the result. Explicit mismatch remains a
  `QUALITY_MISMATCH` failure.

### D007 — Conservative ambiguous-completion handling

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: An upstream response timeout, connection loss, or caller
  cancellation after lease allocation converts the active lease to cooldown.
  Known success and known protocol/HTTP failure release immediately. An active lease that loses
  heartbeats expires into cooldown; owner-process death alone never releases
  it. Cooldown expiration is automatic.

### D008 — Administrative clearing is narrow and explicit

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: MCP tools cannot clear state. The CLI requires the dedicated
  `leases clear --lease-id UUID --confirm` form, only clears a current cooldown
  lease, and first requires its backend health and model-list probe to pass.
  Active leases and absent/changing leases are never force-cleared.

### D009 — Zero-length waits are immediate checks

- Status: accepted
- Decided: 2026-08-16, Issue 13
- Decision: `busy_behavior=fail` requires `max_wait_seconds=0` so ignored wait
  values cannot hide a caller mistake. `busy_behavior=wait` with zero may
  acquire immediately when capacity is free, but it creates no ticket and
  fails immediately when capacity or the rate window is unavailable. Positive
  waits are always bounded by the requested deadline and cancellation signal.

### D010 — Host configuration is project-local and path-fixed

- Status: accepted
- Decided: 2026-08-16, Issue 14
- Decision: Codex uses `.codex/config.toml`; Claude Code and Copilot CLI share
  the root `.mcp.json`; VS Code uses `.vscode/mcp.json`. All use the server name
  `local-mlx-delegate`. The JSON entry uses the cross-host `stdio` type. Each
  entry runs the canonical absolute `dist/cli.js` and passes `serve` plus the
  canonical absolute workspace root as literal arguments rather than relying
  on host-specific environment expansion or a globally linked package.
- Rationale: the host processes run on the same Mac, while literal canonical
  paths avoid differences in host PATH and environment interpolation.

### D011 — Apply is byte-aware, atomic, and symlink-averse

- Status: accepted
- Decided: 2026-08-16, Issue 14
- Decision: Preview is the default. `--apply` writes only when proposed bytes
  differ. Before changing an existing file it creates an exclusive mode-0600
  `FILE.backup-<compact UTC ISO timestamp>` backup, adding a numeric suffix on
  a same-millisecond collision. The replacement is written and flushed in the
  target directory, atomically renamed, and directory-flushed. Existing target
  mode is retained; new files use 0644. Target paths containing symlinks and
  configuration files over 1 MiB are rejected. JSONC input is accepted and a
  changed file is normalized while retaining unrelated fields; the targeted
  Codex TOML table is replaced without rewriting unrelated text.

### D012 — Agent guidance is tracked, local, and optional

- Status: accepted
- Decided: 2026-08-16, Issue 14
- Decision: Track the standard `.agents/skills/local-mlx-delegate` skill plus
  concise `CLAUDE.md` and `.github/copilot-instructions.md` equivalents. Do not
  install a user-global symlink automatically. Correctness, safety, discovery,
  and tool schemas remain entirely functional when these guidance files are
  absent.

### D013 — Context safety precedes backend probing

- Status: accepted
- Decided: 2026-08-17, Issue 15
- Decision: Delegation validates its prompt envelope and canonically validates
  the selected paths before probing or selecting a backend. Direct traversal,
  symlink escape, sensitive-path, and prompt-envelope failures therefore remain
  deterministic even while every backend is offline, and invalid context does
  not trigger any upstream request. Approved file contents and Git diffs are
  collected only after a viable backend/model is selected.
- Rationale: the offline release scenario exposed that probing first could
  mask a containment error as `BACKEND_UNAVAILABLE`.

### D014 — Release evidence is content-minimized and owner-only

- Status: accepted
- Decided: 2026-08-17, Issue 15
- Decision: Retain strict version-1 JSON with commit/runtime identity, safe
  metrics and invariant results. Raw host stdout/stderr is replaced by byte
  counts and SHA-256 digests. Prompts, source, answers, response bodies,
  credentials, raw environment values, and absolute workspace paths are not
  persisted. Evidence is written mode 0600 by flush and atomic rename under a
  gitignored directory.

### D015 — The automated capacity pair is Codex then Claude

- Status: accepted
- Decided: 2026-08-17, Issue 15
- Decision: The ready behavioral gate first requires sequential success from
  Codex CLI, Claude Code, Copilot CLI, and the VS Code-equivalent MCP client.
  Capacity arbitration then uses Codex as the capacity-one owner and Claude as
  the different competing client, once fail-fast and once with a bounded FIFO
  wait. Copilot remains a mandatory sequential host rather than a fallback for
  a missing capacity participant.
- Rationale: a fixed client pair makes retained runs comparable and ensures
  that a missing required host fails the release gate instead of silently
  changing the scenario.

### D016 — Model catalogs and loaded generation candidates are distinct

- Status: accepted
- Decided: 2026-08-17, LM Studio compatibility follow-up
- Decision: Backend definitions explicitly select `openai` or `lmstudio`
  model discovery. Controller and worker default to `lmstudio`; cluster
  defaults to `openai`. Every result preserves sanitized `/v1/models` entries
  in `models`, while `loaded_models` contains only active generative
  candidates. Readiness, doctor checks, administrative health gates, and
  delegation use `loaded_models`.
- LM Studio behavior: after the existing health and OpenAI catalog reads, the
  probe sends the read-only `GET /api/v1/models` request and intersects loaded
  LLM instance IDs with the visible catalog. Unloaded JIT-visible models and
  embeddings are not candidates. Malformed, non-successful, or inconsistent
  native metadata fails closed as `UPSTREAM_PROTOCOL_ERROR`; the delegate does
  not trigger JIT lifecycle changes to discover a model.
- Rationale: LM Studio may expose all downloaded models through `/v1/models`
  when JIT loading is enabled. Treating that catalog as resident state made a
  single loaded LLM appear ambiguous and could select an unloaded model.

### D017 — Native MCP hosts own the stdio server lifecycle

- Status: accepted
- Decided: 2026-08-17, macOS deployment research follow-up
- Decision: Keep `local-mlx-delegate` as a per-client stdio subprocess. Codex,
  Claude, Copilot, or VS Code starts and stops its own process; do not install
  the current server as a `launchd` job or shared daemon. Use each host's MCP
  controls for routine lifecycle management and the MCP Inspector for protocol
  debugging.
- Network boundary: the subprocess must run in the same native macOS network
  context as LM Studio for `127.0.0.1` to identify the Mac host. A sandbox,
  container, remote workspace, or remote executor may have a different
  loopback interface and is not a valid live-test context for version 1.
- Rationale: stdio clients own the child process and its protocol pipes. A
  separately daemonized process cannot share those pipes, while a native child
  can make the required read-only loopback requests without introducing an
  inbound HTTP service. A shared `launchd` service would require a future
  Streamable HTTP design and its accompanying authentication and exposure
  decisions.
- Operator contract: the canonical commands and troubleshooting sequence are
  maintained in
  [`LOCAL-LLM-DELEGATION-OPERATIONS.md`](LOCAL-LLM-DELEGATION-OPERATIONS.md).

### D018 — LM Studio delegation disables hidden reasoning

- Status: accepted
- Decided: 2026-08-17, live MCP compatibility follow-up
- Decision: Completion requests to backends using `lmstudio` discovery include
  `reasoning_effort: "none"`. Generic `openai` discovery omits the field. The
  adapter requires a non-empty public `message.content` and never substitutes
  or exposes `reasoning_content` as the answer.
- Failure behavior: an empty public answer returns
  `UPSTREAM_PROTOCOL_ERROR` with only safe primitive details indicating the
  finish reason and whether private reasoning was present. The response body
  and reasoning text remain excluded from results and logs.
- Rationale: the loaded Qwen3.6 model used all 250 requested completion tokens
  as private reasoning, stopped with `finish_reason: "length"`, and returned
  empty public content. The identical live request completed successfully when
  LM Studio reasoning effort was `none`. This preserves the caller's bounded
  final-answer budget and the product's rule that private reasoning is not an
  output channel.

## Provisional defaults

These values are safe starting points selected because the plan did not assign
numbers. They are strict configuration fields and environment-overridable.
Live release testing may tune them without changing the behavior contract.

| ID   | Configuration field           |                 Default | Reasoning                                                                                                                                 |
| ---- | ----------------------------- | ----------------------: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P001 | `mutex_timeout_ms`            |                5,000 ms | Bounds local state contention without masking a stuck coordinator.                                                                        |
| P002 | `mutex_stale_ms`              |               10,000 ms | Longer than the mutex acquisition deadline; state transactions should be very short.                                                      |
| P003 | `heartbeat_interval_ms`       |                2,000 ms | Frequent enough to detect a lost owner while keeping filesystem traffic modest.                                                           |
| P004 | `lease_ttl_ms`                |               10,000 ms | Allows multiple missed heartbeats before conservative expiry.                                                                             |
| P005 | `cooldown_ms`                 |               30,000 ms | Prevents immediate overlap after an ambiguous local generation outcome.                                                                   |
| P006 | `queue_capacity`              |              32 tickets | Bounds state size and waiting clients.                                                                                                    |
| P007 | `queue_poll_interval_ms`      |                   50 ms | Responsive locally without a hot filesystem polling loop.                                                                                 |
| P008 | `rate_limit_requests`         |               60 starts | A permissive safety ceiling for local interactive use.                                                                                    |
| P009 | `rate_limit_window_ms`        |               60,000 ms | One-minute global sliding window paired with P008.                                                                                        |
| P010 | routing materiality threshold |   0.05 mean correctness | Prefer measured correctness only when the five-workload difference exceeds five percentage points; otherwise prefer lower median latency. |
| P011 | unavailable lifecycle metrics | `null` with safe reason | Startup time and upstream peak memory are not exposed by the read-only API; do not add lifecycle control solely to populate them.         |

Validation additionally requires the heartbeat interval to be less than half
the lease TTL and the mutex stale threshold to exceed the mutex acquisition
deadline.

## Open decisions for later chunks

### O001 — Tune coordinator timings against live long generations

- Status: open
- Target: Issue 15 release tests
- Question: Do P001–P009 remain appropriate under real controller, worker, and
  distributed-cluster latency and host sleep/wake behavior?
- Evidence needed: retained timing/status logs from the live capacity and
  ambiguous-timeout scenarios. Safety should favor a longer cooldown if the
  upstream can continue substantially beyond the client deadline.

### O004 — Live model/profile release evidence

- Status: open
- Target: Issue 15
- Question: Which currently installed fast/deep model IDs and live topology
  will constitute the version-1 release matrix?
- Evidence needed: sequential and overlapping calls from Codex CLI, Claude
  Code, GitHub Copilot CLI, and the VS Code/Copilot smoke path, with safe server
  logs retained.
- Current state (2026-08-17): the strict live/evaluation harness exists. The
  controller is reachable and native LM Studio metadata reports one loaded LLM,
  `qwen3.6-35b`; `/v1/models` also exposes unloaded `qwen/qwen3.8-27b` and an
  embedding model because JIT loading is enabled. Neither installed LLM has a
  decided fast/deep role, and no qualifying performance evidence has been
  recorded. Worker and cluster remain unvalidated, so routing is provisional.

### O005 — Complete installed-host live evidence

- Status: open
- Target: Issue 15
- Question: Does every installed target host both discover the project entry
  and invoke `local_llm_status` under its current workspace-trust state?
- Current evidence: native Codex, Claude, and VS Code executables are present
  on the implementation machine; GitHub Copilot CLI is not installed. The
  opt-in `delegate:host-smoke` task covers native discovery and a real stdio
  status call without making host installation part of offline checks.
- Current blocker (2026-08-17): project host entries have not been applied or
  trusted, and GitHub Copilot CLI is still absent. The release behavior task
  deliberately fails rather than skipping a required installed/configured
  host. Applying project configuration remains an explicit operator action.

### O006 — Complete and retain the Issue 15 live release gate

- Status: open
- Target: Issue 15 operator run
- Question: Do all four primary profiles, the later worker-tunnel profiles,
  three native CLI hosts, VS Code-equivalent client, and both final behavior
  scenarios pass with comparable retained evidence?
- Current evidence: offline schemas, scoring, containment ordering, redaction,
  and harness compilation are covered by the ordinary check. Live endpoints
  were all unavailable on 2026-08-17, so no lifecycle action was taken and the
  release gate remains incomplete.

### O007 — Harden host launches against minimal GUI environments

- Status: open
- Target: compatibility follow-up
- Question: Should generated host entries invoke the absolute Node 24
  executable with the absolute CLI path as its first argument, instead of
  relying on `#!/usr/bin/env node` and each host application's inherited
  `PATH`?
- Current evidence: normal inherited host environments successfully launch and
  reach the server. A later native-environment reproduction proved that one
  `UPSTREAM_PROTOCOL_ERROR` came from a reasoning-only completion exhausting
  its token limit, not from a missing environment setting. The earlier stripped
  environment result therefore does not establish an environment dependency;
  the shebang/PATH concern remains a launch portability risk only.
- Evidence needed: spawned-protocol tests under the documented minimum safe
  environment, containing no secrets or raw environment logging; doctor checks
  for executable resolution and a writable state directory; and native-host
  status/delegation smoke tests outside agent-shell network sandboxes.
