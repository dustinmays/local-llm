# local-llm

Running LLMs **locally** on Apple Silicon — a fast single-Mac coding model and a
two-Mac distributed inference cluster, both available to OpenCode without cloud
API keys or data leaving the machines.

It's built on [MLX](https://github.com/ml-explore/mlx), Apple's ML framework that runs on
the unified-memory GPU of M-series chips. Qwen3-Coder-30B is the single-Mac
daily driver; a Thunderbolt-connected M5 Pro and M4 Pro combine their resources
for configurable, tensor-sharded models up to a 122B mixture-of-experts profile.

**Cluster:** Apple M5 Pro · 48 GB controller + Apple M4 Pro · 48 GB worker.

---

## Read-only status, diagnostics, and delegation

The root `local-mlx-delegate` TypeScript package provides a direct CLI and an
MCP stdio server that inspect the existing controller, worker tunnel, and
cluster, and can send bounded advisory tasks to an already-loaded model.
Status sends `GET /health` and `GET /v1/models`; LM Studio backends additionally
send the read-only `GET /api/v1/models` request to distinguish loaded LLMs from
JIT-visible downloaded and embedding models. Delegation additionally sends
`POST /v1/chat/completions`. LM Studio completion requests set
`reasoning_effort` to `none` so a bounded output allowance produces a public
final answer instead of being consumed entirely by private reasoning tokens;
`reasoning_content` is never returned as the answer. Generic OpenAI-compatible
cluster requests omit that compatibility field. Neither path starts, stops,
loads, unloads, swaps, or otherwise changes a model.

Install the exact Node 24 and pnpm toolchain, then build:

```bash
mise install
mise run delegate:install
mise run delegate:build
```

Use the human-readable CLI output, or request one stable JSON document:

```bash
mise run delegate:status
mise run delegate:doctor
./dist/cli.js status --backend controller
./dist/cli.js status --json
./dist/cli.js doctor --workspace-root "$PWD" --json
./dist/cli.js delegate --task "review the selected file" --cwd "$PWD" \
  --path src/example.ts --quality fast
./dist/cli.js delegate --task "review my tracked changes" --cwd "$PWD" \
  --include-diff --json
./dist/cli.js delegate --task "bounded second opinion" --cwd "$PWD" \
  --busy-behavior wait --max-wait-seconds 30
./dist/cli.js leases --json
```

Administrative cooldown clearing is deliberately separate from MCP and
requires all of an exact lease ID, an explicit confirmation flag, and a passed
backend health/model probe:

```bash
./dist/cli.js leases clear --lease-id UUID --confirm --json
```

MCP tools cannot clear leases.

Run the MCP server with stdout reserved for protocol traffic. All diagnostic
logs are newline-delimited JSON on stderr.

```bash
./dist/cli.js serve --workspace-root "$PWD"
```

The command is a client-owned stdio subprocess, not a persistent network
daemon. A manual launch waits silently for MCP input; normally Codex, Claude,
Copilot, or VS Code starts and stops one child per session. Do not install it
under `launchd`. The child opens no inbound port and makes read-only HTTP calls
to the configured model endpoint.

Live MCP hosts and direct live checks must run in the same native macOS network
context as LM Studio. A container, Remote SSH workspace, cloud executor, or
network-restricted sandbox has its own `127.0.0.1` and may report a false
`BACKEND_UNAVAILABLE`. Run the server natively on the Mac and leave remote MCP
execution disabled. See the
[operations guide](docs/LOCAL-LLM-DELEGATION-OPERATIONS.md) for the complete
runtime model, host management commands, MCP Inspector usage, and
troubleshooting flow.

### Configure Codex, Claude, Copilot CLI, or VS Code

Host configuration is project-local and review-first. Build once, preview the
exact proposed file, then add `--apply` only after reviewing it:

```bash
./dist/cli.js configure codex --workspace-root "$PWD"
./dist/cli.js configure claude --workspace-root "$PWD"
./dist/cli.js configure copilot-cli --workspace-root "$PWD"
./dist/cli.js configure vscode --workspace-root "$PWD"

./dist/cli.js configure codex --workspace-root "$PWD" --apply
```

The targets are `.codex/config.toml`, the root `.mcp.json` shared by Claude
Code and Copilot CLI, and `.vscode/mcp.json`. Every entry runs the canonical
absolute `dist/cli.js` with `serve --workspace-root` and the canonical absolute
repository path. The current executable uses `#!/usr/bin/env node`, so the host
application's inherited `PATH` must resolve the pinned Node 24 runtime. Absolute
Node invocation and minimum-environment diagnostics are tracked compatibility
hardening rather than a completed contract. Existing unrelated servers and
top-level fields are preserved.
Applying an already-current entry makes no write and no backup. A changed
existing file is copied first to `FILE.backup-<UTC timestamp>`, then replaced
atomically. Configuration paths containing symlinks are rejected.

Verify native discovery after trusting the project in each installed host:

| Host            | Discovery                                                                     | Explicit status invocation                                            |
| --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Codex CLI       | `codex mcp list --json` or `/mcp`                                             | Ask: “Call `local_llm_status` and report only its structured result.” |
| Claude Code     | `claude mcp get local-mlx-delegate` or `/mcp`                                 | Use the same explicit request after approving the project server.     |
| Copilot CLI     | `copilot mcp get local-mlx-delegate --json` or `/mcp show local-mlx-delegate` | Use the same explicit request in a trusted folder.                    |
| VS Code/Copilot | Run **MCP: List Servers**                                                     | In Agent mode, explicitly request `local_llm_status`.                 |

`mise run delegate:host-smoke` checks every installed CLI's native discovery
and invokes status through the configured stdio command. It skips host
executables that are not installed; configure every installed host first.
`doctor --workspace-root "$PWD"` reports installed/configured host pairs as
pass, warn, or skip without changing them.

For interactive protocol debugging, let the official MCP Inspector launch and
own the stdio child:

```bash
mise exec -- pnpm dlx @modelcontextprotocol/inspector -- \
  ./dist/cli.js serve --workspace-root "$PWD"
```

The first Inspector run may download its package and is not part of the offline
test gate.

To remove the integration, delete only the `local-mlx-delegate` table from
`.codex/config.toml` or the named object from `mcpServers`/`servers` in the
corresponding JSON file. Do not use a host's user-scope remove command for this
project entry. To recover from an unwanted update, close the host, compare the
timestamped backup, then replace the configuration with that backup. Atomic
replacement keeps the original target intact if the final write cannot
complete; a backup may remain and can be inspected or removed manually.

The tracked `.agents/skills/local-mlx-delegate` skill, `CLAUDE.md`, and
`.github/copilot-instructions.md` provide optional routing advice. MCP
discovery, schemas, path safety, coordination, and lifecycle restrictions do
not depend on those files. Remotely hosted agents cannot reach these loopback
backend endpoints; this integration is for MCP clients that spawn the stdio
server natively on the Mac.

The built-in endpoints and resource groups are:

| Backend    | API base URL               | Model discovery | Resource groups        | Startup hint                                                        |
| ---------- | -------------------------- | --------------- | ---------------------- | ------------------------------------------------------------------- |
| controller | `http://127.0.0.1:1234/v1` | `lmstudio`      | `controller`           | `llm-serve` or `llm-serve-hq`                                       |
| worker     | `http://127.0.0.1:1235/v1` | `lmstudio`      | `worker`               | Start worker LM Studio and the localhost port-1235 SSH tunnel       |
| cluster    | `http://127.0.0.1:8080/v1` | `openai`        | `controller`, `worker` | `mise run cluster:start-fast` or `mise run cluster:start-overnight` |

Configuration precedence is built-in defaults, an optional JSON file, explicit
environment variables, then invocation flags. Select the JSON file with
`--config PATH` or `LOCAL_MLX_DELEGATE_CONFIG`; the flag wins. A configuration
file is strict, uses `"schema_version": 1`, and may partially override fields:

Status JSON preserves the sanitized OpenAI-visible catalog in `models` and
reports active generative candidates in `loaded_models`. Readiness, top-level
selection, doctor checks, and delegation use only `loaded_models`. This matters
when LM Studio JIT loading makes `/v1/models` include downloaded-but-unloaded
LLMs and embedding models.

```json
{
  "schema_version": 1,
  "workspace_root": null,
  "log_level": "info",
  "connect_timeout_ms": 1000,
  "health_timeout_ms": 2000,
  "generation_timeout_ms": 120000,
  "coordination": {
    "mutex_timeout_ms": 5000,
    "mutex_stale_ms": 10000,
    "heartbeat_interval_ms": 2000,
    "lease_ttl_ms": 10000,
    "cooldown_ms": 30000,
    "queue_capacity": 32,
    "queue_poll_interval_ms": 50,
    "rate_limit_requests": 60,
    "rate_limit_window_ms": 60000
  },
  "backends": {
    "controller": {
      "enabled": true,
      "url": "http://127.0.0.1:1234/v1",
      "model_discovery": "lmstudio",
      "model_quality": {
        "fast": ["qwen3-coder-30b-a3b-instruct@4bit"],
        "deep": ["qwen3-coder-30b-a3b-instruct@8bit"]
      }
    }
  }
}
```

Environment overrides are
`LOCAL_MLX_DELEGATE_WORKSPACE_ROOT`,
`LOCAL_MLX_DELEGATE_LOG_LEVEL`,
`LOCAL_MLX_DELEGATE_CONNECT_TIMEOUT_MS`,
`LOCAL_MLX_DELEGATE_HEALTH_TIMEOUT_MS`,
`LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS`,
`LOCAL_MLX_DELEGATE_STATE_DIRECTORY`,
`LOCAL_MLX_DELEGATE_MUTEX_TIMEOUT_MS`,
`LOCAL_MLX_DELEGATE_MUTEX_STALE_MS`,
`LOCAL_MLX_DELEGATE_HEARTBEAT_INTERVAL_MS`,
`LOCAL_MLX_DELEGATE_LEASE_TTL_MS`,
`LOCAL_MLX_DELEGATE_COOLDOWN_MS`,
`LOCAL_MLX_DELEGATE_QUEUE_CAPACITY`,
`LOCAL_MLX_DELEGATE_QUEUE_POLL_INTERVAL_MS`,
`LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS`,
`LOCAL_MLX_DELEGATE_RATE_LIMIT_WINDOW_MS`, and
`LOCAL_MLX_DELEGATE_{CONTROLLER,WORKER,CLUSTER}_{URL,ENABLED,MODEL_DISCOVERY}`.
Model discovery is `lmstudio` for LM Studio endpoints and `openai` for generic
OpenAI-compatible endpoints. Boolean values
are `true`, `false`, `1`, or `0`. Backend URLs must be HTTP(S) loopback URLs
without credentials, query strings, or fragments. Model quality is classified
only by exact configured IDs; it is never guessed from a model name.

Delegation resolves one canonical workspace boundary before serving requests.
It reads only explicit `--path` selections and, when requested, a bounded
tracked-file diff from `HEAD`. Symlink escapes and sensitive paths are
rejected; binary, generated, dependency, model-weight, and oversized context
is omitted or truncated with a manifest reason. Untracked files enter context
only when explicitly selected. Repository text is marked as untrusted in the
prompt, and local-model output remains advisory.

Generation capacity is coordinated across independent CLI and MCP processes
through a strict, versioned registry in the user's local application-state
directory. Controller and cluster work contend for `controller`; worker and
cluster work contend for `worker`; cluster allocation reserves both in one
atomic transaction. The default is fail-fast busy handling. A bounded
`busy_behavior=wait` request receives a FIFO ticket relative to requests that
overlap its physical resources. Generation starts share one sliding-window
rate limit across processes.

Active leases heartbeat while a request runs. Known completion outcomes
release immediately; an ambiguous timeout or cancellation enters a 30-second
default cooldown so another heavy request cannot overlap work that may still
be running upstream. `status`, `doctor`, and `leases` report resource state,
queue depth, lease age, cooldown time, and degraded registry state without
including prompts or paths. The state directory is environment-overridable but
cannot be redirected by a repository JSON configuration file.

Decisions for unspecified defaults and open later-chunk questions are recorded
in [the delegation decision log](docs/LOCAL-LLM-DELEGATION-DECISIONS.md).

Exit codes are `0` for successful checks or delegation, `1` for a valid
diagnostic/delegation failure, `2` for usage/configuration errors, and
`70` for unexpected software errors. Run the complete fake-endpoint checks
without a live model:

```bash
mise run delegate:check
mise run delegate:test-protocol
```

Live checks and consultations are optional and never change model lifecycle
state or repository files.

The opt-in v1 release gate covers manually started single-Mac, worker-tunnel,
and cluster profiles; identical correctness/performance workloads; and native
Codex, Claude, Copilot CLI, and VS Code-equivalent behavior. It stores only
redacted, mode-0600 evidence under a gitignored directory. See the
[release runbook](docs/LOCAL-LLM-DELEGATION-RELEASE.md) for the exact profile
sequence, environment variables, routing recommendation, and offline
containment scenario. These tasks never establish or alter model lifecycle
state themselves.

---

## How the single-Mac path fits together

Read this first — the rest of the doc makes more sense once the layers are clear.

```
  ~/.cache/huggingface/hub          ← model weights live here (downloaded once)
          │  symlinked into
          ▼
  ~/.lmstudio/models/…              ← LM Studio sees the same files (no 2nd copy)
          │
          ▼
  LM Studio  ──serves──▶  OpenAI-compatible API @ http://localhost:1234
   (the "warm" engine: holds a model in RAM so replies are instant)
          ▲                         ▲
          │ you type commands       │ agentic coding
          │                         │
  shell/llm.zsh                 opencode
  (ask · chat · review …)       (TUI / `opencode run`)
     uses the `llm` CLI            reads ~/.config/opencode/opencode.json
     pointed at :1234              → talks to LM Studio at :1234
```

Two ways a model runs:

- **Warm (normal):** LM Studio keeps the model loaded in RAM and serves it on port 1234.
  `ask`/`chat` and opencode both hit that endpoint → ~1 s responses.
- **Cold (fallback):** if the LM Studio server is down, `ask`/`chat` load the weights
  **in-process** via the `llm-mlx` plugin (~3 s each). Slower, but always works.

You start the warm engine with **`llm-serve`** (4-bit) or **`llm-serve-hq`** (8-bit). Every
new terminal prints a one-line reminder of these.

**Why LM Studio at all?** It's the maintained, MLX-native way to keep a model warm with a
proper start/stop server and per-model context control. We reuse the Hugging Face weights via
symlinks, so it costs no extra disk.

---

## Single-Mac model: Qwen3-Coder-30B-A3B-Instruct

One coding-specialized Mixture-of-Experts model (30.5B total params, ~3.3B active per token —
so it's fast despite its size), run at two precisions:

| Role                    | LM Studio id                        | Repo                                              | On disk |
| ----------------------- | ----------------------------------- | ------------------------------------------------- | ------- |
| **Daily driver** (fast) | `qwen3-coder-30b-a3b-instruct@4bit` | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit` | 17.2 GB |
| **High quality** (slow) | `qwen3-coder-30b-a3b-instruct@8bit` | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit` | 32.5 GB |

- Native context 256K; we load it at 128K (4-bit) / 64K (8-bit) — see
  [Single-Mac context and RAM](#single-mac-context--ram).
- Emits **proper structured tool calls**, so it drives opencode reliably.
- Apache-2.0.

See [Why the single-Mac model](#why-the-single-mac-model) for the alternatives
that were ruled out.

---

## Single-Mac requirements

- A Mac with **Apple Silicon** (M1 or newer) — will not work on Intel.
- macOS 13.5+ · [Homebrew](https://brew.sh).
- ~55 GB free disk (both model precisions) and 48 GB RAM (32 GB works for the 4-bit only).

---

## Single-Mac setup from scratch

A totally-fresh-machine path. Run from the repo root unless noted. Steps 1–3 are terminal-only;
step 4 needs one click in the LM Studio GUI (called out below).

### 1. Python + MLX tooling

```bash
# Modern Python (we avoid the macOS system python at /usr/bin/python3).
brew install python@3.13
/opt/homebrew/bin/python3.13 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install mlx mlx-lm llm llm-mlx
```

### 2. Download the models + configure the `llm` CLI

```bash
# Download weights into the HF cache AND register them with the llm-mlx plugin
# (this is the "cold" in-process path). ~50 GB total.
llm mlx download-model mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit
llm mlx download-model mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit

# Stable aliases used by the cold path (and the swap point for future models).
llm aliases set coder-fast mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit
llm aliases set coder-hq   mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit

# Tell `llm` how to reach the warm LM Studio endpoint. This registers the model ids
# `coder-live` / `coder-live-hq`, so it must come BEFORE setting their options.
cp config/extra-openai-models.yaml \
  "$HOME/Library/Application Support/io.datasette.llm/extra-openai-models.yaml"

# Sampling defaults (Qwen3-Coder's recommended settings) + token ceilings for all 4 model ids:
# the 2 cold in-process models and the 2 warm LM Studio models.
for M in \
  mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit \
  mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit \
  coder-live coder-live-hq; do
  llm models options set "$M" temperature 0.7
  llm models options set "$M" top_p 0.8
done
llm models options set mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit max_tokens 4096
llm models options set mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit max_tokens 8192
llm models options set coder-live    max_tokens 4096
llm models options set coder-live-hq max_tokens 8192
```

### 3. Shell commands

```bash
echo 'source ~/repos/local-llm/shell/llm.zsh' >> ~/.zshrc
source ~/.zshrc
```

### 4. LM Studio (the warm serving engine)

```bash
brew install --cask lm-studio
open -a "LM Studio"     # run once so it initializes ~/.lmstudio
"/Applications/LM Studio.app/Contents/Resources/app/.webpack/lms" bootstrap   # installs the `lms` CLI

# Reuse the HF-cached weights instead of re-downloading (~50 GB saved).
mkdir -p ~/.lmstudio/models/mlx-community
for r in Qwen3-Coder-30B-A3B-Instruct-4bit Qwen3-Coder-30B-A3B-Instruct-8bit; do
  snap=$(ls -d ~/.cache/huggingface/hub/models--mlx-community--$r/snapshots/*/ | head -1)
  ln -sfn "${snap%/}" ~/.lmstudio/models/mlx-community/$r
done
lms ls                 # should list both qwen3-coder models
```

> **One manual GUI step:** in the LM Studio app, load `qwen3-coder-30b-a3b-instruct@4bit`
> once from the model panel. The first load downloads LM Studio's MLX inference runtime —
> the headless `lms` CLI **cannot** fetch it, and until it's present `lms load` fails with a
> missing `libpython3.11.dylib`. After this one-time download, everything works from the CLI.

### 5. opencode (agentic coding)

```bash
brew install opencode
mkdir -p ~/.config/opencode
cp config/opencode.json ~/.config/opencode/opencode.json
```

### 6. Verify

```bash
# MLX runs on the GPU:
python - <<'PY'
import mlx.core as mx
print("mlx:", mx.__version__, "| device:", mx.default_device())   # expect Device(gpu, 0)
PY

# End-to-end warm path:
llm-serve                     # loads the 4-bit into LM Studio
ask "say hello in 3 words"    # ~1 s reply from the warm server
lms ps                        # CONTEXT column should read 131072
```

---

## Single-Mac daily use

Every new terminal prints a reminder:

> **local-llm ›** warm a model: **llm-serve** (4-bit·128K) **llm-serve-hq** (8-bit·64K) — then: ask · chat · review · dictate

Commands (work from any directory, no venv activation needed):

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `ask "…"`          | One-shot on the **4-bit** daily driver                               |
| `askhq "…"`        | One-shot on the **8-bit** model                                      |
| `askc "…"`         | Continue the **last** conversation                                   |
| `chat` / `chathq`  | Interactive REPL (`exit` or Ctrl-D to quit)                          |
| `review`           | 8-bit code review of piped input — `git diff \| review`              |
| `dictate`          | Clean up a raw dictation transcript — `pbpaste \| dictate \| pbcopy` |
| `llm-serve`        | Start server + load 4-bit @ 128K context                             |
| `llm-serve-hq`     | Load 8-bit @ 64K context (opencode / overnight)                      |
| `llm-serve-stop`   | Stop server + unload (frees the RAM)                                 |
| `llm-serve-status` | Server status + which model is loaded                                |
| `llm-log [N]`      | Show last N logged exchanges                                         |

```bash
ask "explain Python's GIL in two sentences"
cat server.py | ask "spot any bugs"
git diff | review
chat
```

**Warm/cold & auto model-switching** — you don't manage loading manually:

- With the server up (`llm-serve`), replies are instant. With it down, commands cold-load
  in-process (slower) but still work.
- The 4-bit (17 GB) and 8-bit (32 GB) **can't be resident at once** (>48 GB). So `askhq`/`review`
  evict the 4-bit and load the 8-bit; the next `ask`/`chat` swaps back. Consecutive same-model
  calls stay warm. Each load uses the correct big context automatically.

**Config knobs** live at the top of [`shell/llm.zsh`](shell/llm.zsh): `LLM_SERVE_CTX`,
`LLM_SERVE_CTX_HQ`, port, and model ids.

---

## Dictation cleanup

Raw speech-to-text (e.g. Whisper) output is often full of filler words, false
starts, and missing punctuation. The 30B coder model is overkill for cleaning
that up, so a small, fast model is loaded alongside it instead.

- **Model:** [`mlx-community/Qwen3-4B-Instruct-2507-4bit`](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit)
  — ~2.3 GB, loads in a few seconds.
- **Command:** `dictate` — pipes text through a system prompt that fixes
  punctuation, capitalization, and grammar, and removes filler words and
  stutters, while preserving the speaker's wording and meaning (no
  summarizing or rephrasing).

```bash
pbpaste | dictate | pbcopy
dictate < transcript.txt
```

Because the model is only ~2.3 GB, it **co-resides with the 30B coder
model** — `dictate` never evicts whatever else is loaded, unlike `askhq`/
`review` which must swap the 4-bit/8-bit coder model in and out.

To download it:

```bash
lms get "https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit" -y
```

The warm endpoint is registered as `dictate-live` in
[`config/extra-openai-models.yaml`](config/extra-openai-models.yaml). There is
currently no cold (in-process) fallback for dictation — `dictate` requires
`llm-serve`/`llm-serve-hq` to already be running. To add one, download the
model into the llm-mlx cache and set an alias the same way the coder models
are set up in [step 2 of setup](#2-download-the-models--configure-the-llm-cli):

```bash
llm mlx download-model mlx-community/Qwen3-4B-Instruct-2507-4bit
llm aliases set dictate-fast mlx-community/Qwen3-4B-Instruct-2507-4bit
```

---

## Single-Mac agentic coding with OpenCode

opencode talks to the same LM Studio endpoint (config: `~/.config/opencode/opencode.json`,
mirrored in [`config/opencode.json`](config/opencode.json)).

```bash
llm-serve            # ← REQUIRED first (see warning below). Or llm-serve-hq for 8-bit.
cd your/project
opencode             # interactive TUI (switch models with /models)
opencode run "review the diff on this branch and list risky changes"   # one-shot
```

> **Always `llm-serve`/`llm-serve-hq` before opencode.** If you instead load the model from
> LM Studio's **menu-bar / GUI "Load Model"**, it uses LM Studio's tiny **8K default context**
> and opencode fails with _"number of tokens to keep from the initial prompt is greater than
> the context length."_ Our commands load at 128K / 64K, which fits opencode's prompt + tools
>
> - files. (To keep the menu-bar workflow, set the model's default context to 131072 in the
>   LM Studio GUI and save it as the default.)

- **Model choice:** opencode uses whichever model is loaded (4-bit by default). For
  walk-away quality, `llm-serve-hq`, or pass `-m lmstudio/qwen3-coder-30b-a3b-instruct@8bit`.
- **Verified:** Qwen3-Coder's Write/Edit/etc. tool calls execute correctly in opencode.

---

## Two-Mac distributed MLX cluster

This repository also supports tensor-sharded inference across an M5 Pro and an
M4 Pro connected directly by Thunderbolt 5. The cluster uses MLX's
OpenAI-compatible `mlx_lm.server`; it does not use LM Studio for distributed
inference. Both JACCL/RDMA and TCP ring can use the direct Thunderbolt link.
Ring is the current recommended backend for this hardware because JACCL caused
reproducible kernel panics during distributed initialization; see
[JACCL failures and the ring workaround](#jaccl-failures-and-the-ring-workaround).

The shared profiles live in tracked `cluster/models.env`, so both clones use
the same model IDs:

```bash
CLUSTER_MODEL_FAST="mlx-community/Qwen3.5-35B-A3B-4bit"
CLUSTER_MODEL_OVERNIGHT="mlx-community/Qwen3.5-122B-A10B-4bit"
CLUSTER_MODEL_TEST="mlx-community/Llama-3.2-3B-Instruct-4bit"
```

The 35B-A3B profile is the interactive coding model: roughly 20.4 GB of 4-bit
weights and about 3B active parameters per token. The 122B-A10B profile is the
slower overnight model: roughly 69.6 GB and about 10B active parameters. Both
use MLX's shardable `qwen3_5_moe` implementation and tool-aware templates.

Qwen3-Coder-30B remains available through LM Studio on either individual Mac,
but its `qwen3_moe` implementation in the pinned `mlx-lm` release cannot be
tensor- or pipeline-sharded. Each Mac needs a complete on-disk snapshot even
though MLX shards resident weights across their combined 96 GB of memory.

### Initial cluster validation

After completing SSH, RDMA, and topology setup from the full guide, validate
communication and real distributed generation before downloading production models:

```bash
mise run cluster:configure
mise run cluster:smoke
mise run model:download-test       # run locally on each Mac
mise run cluster:start-test
mise run cluster:test
mise run cluster:stop
```

`cluster:start-test` reports ready only after a real chat completion succeeds;
the model-list endpoint alone is not considered proof that loading worked.

### Download models independently

First stop any active cluster from the M5:

```bash
mise run cluster:stop
```

Then, in a normal interactive terminal on **each Mac**, update the clone,
remove the two Llama caches, and start the independent downloads:

```bash
git pull --ff-only
mise run model:remove-llama
mise run model:download-all
```

Cleanup prints the exact cache paths and sizes and requires typing
`remove llama`; it refuses to run while a Llama server is active. The download
task fetches fast and overnight profiles sequentially on that Mac, uses Hugging
Face's resumable cache, and keeps the machine awake with `caffeinate`.

### Run and validate a profile

Run cluster management from the M5 controller:

```bash
mise run cluster:check
mise run cluster:start-fast
mise run cluster:test
mise run cluster:test-tools
mise run cluster:benchmark
mise run cluster:status
mise run cluster:logs          # follow logs; Ctrl-C only stops following
mise run cluster:stop
```

For the overnight profile, substitute `cluster:check-overnight` and
`cluster:start-overnight`. `cluster:test-tools` passes only when the model
returns a structured function call that OpenCode can execute.

Always stop the cluster before disconnecting Thunderbolt, closing either lid,
rebooting, or returning to LM Studio. Startup unloads LM Studio on both Macs to
free memory and binds the cluster API only to `http://127.0.0.1:8080/v1` on the
M5.

### JACCL failures and the ring workaround

On August 5, 2026, this M5 Pro/M4 Pro pair running macOS 26.5.2/26.6, MLX
0.32.0, and `mlx-lm` 0.31.3 failed during JACCL initialization with these
errors:

```text
[jaccl] Couldn't allocate protection domain
[jaccl] Changing queue pair to RTR failed with errno 22
[jaccl] Changing queue pair to RTR failed with errno 60
```

Some early failures were explained by a stale hostfile and direct Thunderbolt
routes that still referenced the previous ports. After regenerating the
hostfile and correcting the interface addresses, a two-rank `cluster:smoke`
still triggered kernel data-abort panics on both Macs. The smoke test does not
load a model or create a large KV cache, so this incident is distinct from
known `mlx_lm.server` memory-pressure panics during long agent sessions.

For now, use TCP ring over the same direct Thunderbolt cable. In the
controller's gitignored `cluster/config.local.env`, set:

```bash
CLUSTER_BACKEND="ring"
CLUSTER_TRANSPORT="thunderbolt"
```

After a reboot, reconnect, or port change, regenerate the hostfile
interactively. When configuration prints a `Setup for ...` block, leave it
waiting, run the displayed `sudo ifconfig` and `sudo route` commands on that
Mac, then press Enter:

```bash
mise run cluster:configure
mise run cluster:smoke
mise run cluster:check-overnight
mise run cluster:start-overnight
```

Ring uses TCP over the configured Thunderbolt interfaces, not Wi-Fi. It has
higher communication latency than RDMA but has remained responsive with the
122B overnight profile on this pair. Do not retry JACCL with unsaved work open.
Before testing it again, stop the cluster, switch `CLUSTER_BACKEND` back to
`jaccl`, regenerate the hostfile, and require `cluster:smoke` to pass before
loading a model.

### T3 Code / OpenCode

Generate all three OpenCode model entries from the shared profile variables:

```bash
mise run opencode:install
```

The installer timestamps a backup of the current OpenCode configuration and
preserves its existing `permission` policy while refreshing model entries.
After restarting T3 Code, select **MLX Cluster (M5 + M4)** and the model
currently reported by `mise run cluster:status`.

#### OpenCode permission-policy starter

[`config/opencode.permissions.template.jsonc`](config/opencode.permissions.template.jsonc)
is a conservative, valid JSONC policy starter for trusted development
repositories. It allows repository-local reads and edits plus a small set of
read-only Git commands, asks about ambiguous operations, and denies sensitive,
external, privileged, and destructive operations. Merge its `permission`
object into the target repository's `opencode.jsonc`, then inspect the resolved
configuration:

```bash
cd /path/to/target-repository
opencode debug config | jq '.permission'
```

Use
[`prompts/design-opencode-permissions.md`](prompts/design-opencode-permissions.md)
in a strong Claude or Codex session rooted in the target repository to audit
its scripts and propose exact allowances for tests, linting, builds, task
runners, and other normal work. The prompt requires a reviewable proposal and
does not authorize the reviewing agent to install it.

The project also provides an OpenCode primary agent at
[`.opencode/agents/implementer.md`](.opencode/agents/implementer.md). Select
`implementer` for a scoped issue when the expected terminal state is a
validated commit, pushed feature branch, and open pull request. It verifies the
assigned worktree before writing and treats the PR URL—not implementation
alone—as completion.

Permission patterns are workflow guardrails rather than an OS sandbox. Do not
use the template with `opencode --auto` unless OpenCode itself is isolated.
Also note that, as of August 2, 2026, T3 Code's OpenCode adapter overwrites
configured permissions with a per-session catch-all; see
[T3 Code issue #5164](https://github.com/pingdotgg/t3code/issues/5164). Until
that is fixed, use direct OpenCode for policy enforcement or keep T3 supervised.

### Cluster mise commands

| Command                                         | Purpose                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `mise run setup`                                | Install the pinned Python/MLX environment on the current Mac             |
| `mise run cluster:init`                         | Create the controller's gitignored local configuration                   |
| `mise run cluster:ssh-setup`                    | Install dedicated passwordless controller-to-worker SSH                  |
| `mise run cluster:worker-setup`                 | Bootstrap the M4 from its existing repository clone                      |
| `mise run cluster:topology`                     | Inspect Thunderbolt interfaces without changing them                     |
| `mise run cluster:configure`                    | Configure the selected Thunderbolt backend and generate its MLX hostfile |
| `mise run cluster:smoke`                        | Exercise a two-rank MLX collective operation                             |
| `mise run model:download-fast`                  | Cache the fast profile on this Mac only                                  |
| `mise run model:download-overnight`             | Cache the overnight profile on this Mac only                             |
| `mise run model:download-all`                   | Cache fast then overnight on this Mac only                               |
| `mise run model:remove-llama`                   | Interactively remove managed Llama caches on this Mac                    |
| `mise run cluster:start-test`                   | Start the small model and verify real generation                         |
| `mise run cluster:check`                        | Validate both Macs and fast-profile caches                               |
| `mise run cluster:check-overnight`              | Validate both Macs and overnight-profile caches                          |
| `mise run cluster:start` / `cluster:start-fast` | Start the fast profile across both ranks                                 |
| `mise run cluster:start-overnight`              | Start the overnight profile across both ranks                            |
| `mise run cluster:test`                         | Send a chat completion to the active cluster model                       |
| `mise run cluster:test-tools`                   | Require a structured function call from the active model                 |
| `mise run cluster:benchmark`                    | Measure uncached prompt and generation latency                           |
| `mise run cluster:status`                       | Show launcher, active model, API, and worker status                      |
| `mise run cluster:logs`                         | Follow the distributed server log                                        |
| `mise run cluster:stop`                         | Stop the launcher and clean managed ranks on both Macs                   |
| `mise run opencode:install`                     | Back up and regenerate the OpenCode configuration                        |
| `mise run repo:check-shell`                     | Validate Bash syntax of cluster scripts                                  |

See **[Two-Mac MLX cluster](docs/CLUSTER.md)** for the full one-time setup,
Recovery-mode RDMA step, SSH bootstrap, T3/OpenCode configuration, daily
operation, cleanup commands, and failure recovery.

## Single-Mac overnight / unattended runs

Speed doesn't matter, so use the 8-bit:

```bash
llm-serve-hq         # 8-bit @ 64K (~38 GB resident — close other big apps first)
cd your/project
opencode run "audit these dependencies for known CVEs and summarize"
```

Give it a small, well-scoped task and walk away. For very large contexts you can raise
`LLM_SERVE_CTX_HQ`, but mind the 48 GB ceiling (see below).

---

## Reference

### Single-Mac context & RAM

KV cache is ~96 KB/token, so **RAM ≈ weights + context×96 KB**. Loaded contexts are chosen to
stay safely under 48 GB:

| Model | Weights | Context                  | KV cache | Total  |
| ----- | ------- | ------------------------ | -------- | ------ |
| 4-bit | 17 GB   | 128K (`LLM_SERVE_CTX`)   | ~13 GB   | ~30 GB |
| 8-bit | 32 GB   | 64K (`LLM_SERVE_CTX_HQ`) | ~6 GB    | ~38 GB |

MLX does **not** swap — if a load would exceed RAM, LM Studio refuses it. Raise these knobs
for bigger repos only if the total stays under ~44 GB.

### Where everything lives

| Path                                                                      | What                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `shell/llm.zsh`                                                           | the `ask`/`chat`/`llm-serve` commands (sourced from `~/.zshrc`) |
| `config/`                                                                 | LM Studio config and the OpenCode template                      |
| `cluster/config.local.env`                                                | gitignored controller settings and model variables              |
| `~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml` | tells `llm` how to reach LM Studio                              |
| `~/.config/opencode/opencode.json`                                        | tells opencode how to reach LM Studio                           |
| `~/.lmstudio/models/mlx-community/*`                                      | symlinks → the HF weights (LM Studio's view)                    |
| `~/.cache/huggingface/hub/*`                                              | the actual model weights                                        |
| `.venv/`                                                                  | Python env (mlx, mlx-lm, llm, llm-mlx)                          |

### Swapping the single-Mac model

The shell helpers reference **aliases**, so swapping is cheap:

- **Cold path:** `llm mlx download-model mlx-community/<new>` then
  `llm aliases set coder-fast mlx-community/<new>`.
- **Warm path:** put `<new>` in `~/.lmstudio/models/…`, load it in LM Studio, and update the
  `model_name` in `extra-openai-models.yaml`.

### Why the single-Mac model

- **Skip Qwen2.5-Coder-32B** (previous gen): it emits tool calls as _plain text_ and **breaks
  in opencode**. The Qwen3 generation fixed this.
- **The 80B Qwen3-Coder-Next doesn't fit.** ~45 GB at 4-bit leaves no room for KV cache in
  48 GB (MLX can't swap).
- **Want vision later?** Qwen3.6-35B-A3B (`mlx-community/Qwen3.6-35B-A3B-4bit`, ~20 GB) is a
  strong multimodal option, but it's `image-text-to-text` and needs `mlx-vlm`, not this stack.

### Pinning versions

```bash
source .venv/bin/activate
pip freeze > requirements.txt          # commit it; reproduce with: pip install -r requirements.txt
```

### Troubleshooting

- **opencode: "number of tokens to keep … greater than the context length"** — the model was
  loaded at LM Studio's 8K default (usually via the GUI/menu-bar "Load Model"). Fix:
  `llm-serve` (4-bit @ 128K) or `llm-serve-hq` (8-bit @ 64K), then retry. Confirm with `lms ps`.
- **`lms load` fails: missing `libpython3.11.dylib`** — the MLX runtime isn't downloaded yet.
  Load the model once in the LM Studio GUI (step 4) to fetch it.
- **Tool calls printed as text instead of executed** — old model generation. Use the Qwen3
  Coder models here.
- **Out-of-memory / machine hangs** — both precisions loaded at once, or context too high.
  `lms unload --all`, then load one model; lower `LLM_SERVE_CTX*` if needed.
- **`ask` is slow (~3 s) not instant** — the warm server isn't running; run `llm-serve`.
  (`llm-serve-status` shows state.)
- **MLX on CPU (`Device(cpu, 0)`)** — you're on Intel or an x86/Rosetta Python; `python -c
"import platform; print(platform.machine())"` must print `arm64`.
