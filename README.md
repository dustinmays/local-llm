# local-llm

Running LLMs **locally** on Apple Silicon — a fast daily-driver chat/coding model plus an
agentic coding setup (opencode), with no cloud, no API keys, and no data leaving the machine.

It's built on [MLX](https://github.com/ml-explore/mlx), Apple's ML framework that runs on
the unified-memory GPU of M-series chips. One model (Qwen3-Coder-30B) in two precisions
covers everything.

**This machine:** Apple M5 Pro · 48 GB unified memory · macOS 26.4.

---

## How it fits together

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

## The model: Qwen3-Coder-30B-A3B-Instruct

One coding-specialized Mixture-of-Experts model (30.5B total params, ~3.3B active per token —
so it's fast despite its size), run at two precisions:

| Role | LM Studio id | Repo | On disk |
|------|--------------|------|---------|
| **Daily driver** (fast) | `qwen3-coder-30b-a3b-instruct@4bit` | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit` | 17.2 GB |
| **High quality** (slow) | `qwen3-coder-30b-a3b-instruct@8bit` | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit` | 32.5 GB |

- Native context 256K; we load it at 128K (4-bit) / 64K (8-bit) — see [Context & RAM](#context--ram).
- Emits **proper structured tool calls**, so it drives opencode reliably.
- Apache-2.0.

See [Why this model](#why-this-model) for the alternatives that were ruled out.

---

## Requirements

- A Mac with **Apple Silicon** (M1 or newer) — will not work on Intel.
- macOS 13.5+ · [Homebrew](https://brew.sh).
- ~55 GB free disk (both model precisions) and 48 GB RAM (32 GB works for the 4-bit only).

---

## Setup from scratch

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

## Daily use

Every new terminal prints a reminder:

> **local-llm ›** warm a model: **llm-serve** (4-bit·128K)  **llm-serve-hq** (8-bit·64K)  —  then: ask · chat · review

Commands (work from any directory, no venv activation needed):

| Command | What it does |
|---------|--------------|
| `ask "…"` | One-shot on the **4-bit** daily driver |
| `askhq "…"` | One-shot on the **8-bit** model |
| `askc "…"` | Continue the **last** conversation |
| `chat` / `chathq` | Interactive REPL (`exit` or Ctrl-D to quit) |
| `review` | 8-bit code review of piped input — `git diff \| review` |
| `llm-serve` | Start server + load 4-bit @ 128K context |
| `llm-serve-hq` | Load 8-bit @ 64K context (opencode / overnight) |
| `llm-serve-stop` | Stop server + unload (frees the RAM) |
| `llm-serve-status` | Server status + which model is loaded |
| `llm-log [N]` | Show last N logged exchanges |

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

## Agentic coding with opencode

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
> and opencode fails with *"number of tokens to keep from the initial prompt is greater than
> the context length."* Our commands load at 128K / 64K, which fits opencode's prompt + tools
> + files. (To keep the menu-bar workflow, set the model's default context to 131072 in the
> LM Studio GUI and save it as the default.)

- **Model choice:** opencode uses whichever model is loaded (4-bit by default). For
  walk-away quality, `llm-serve-hq`, or pass `-m lmstudio/qwen3-coder-30b-a3b-instruct@8bit`.
- **Verified:** Qwen3-Coder's Write/Edit/etc. tool calls execute correctly in opencode.

---

## Two-Mac distributed MLX cluster

This repository also supports tensor-sharded inference across an M5 Pro and an
M4 Pro connected directly by Thunderbolt 5. The cluster uses MLX's JACCL/RDMA
backend and the OpenAI-compatible `mlx_lm.server`; it does not use LM Studio for
distributed inference.

The setup is managed through pinned mise tasks:

```bash
mise run cluster:check
mise run cluster:configure
mise run cluster:smoke
mise run cluster:start        # 8-bit
mise run cluster:start-fast   # 4-bit
mise run cluster:status
mise run cluster:stop
```

See **[Two-Mac MLX cluster](docs/CLUSTER.md)** for the full one-time setup,
Recovery-mode RDMA step, SSH bootstrap, T3/OpenCode configuration, daily
operation, failure recovery, and the path to a 70-72B model.

### Overnight / unattended runs

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

### Context & RAM

KV cache is ~96 KB/token, so **RAM ≈ weights + context×96 KB**. Loaded contexts are chosen to
stay safely under 48 GB:

| Model | Weights | Context | KV cache | Total |
|-------|---------|---------|----------|-------|
| 4-bit | 17 GB | 128K (`LLM_SERVE_CTX`) | ~13 GB | ~30 GB |
| 8-bit | 32 GB | 64K (`LLM_SERVE_CTX_HQ`) | ~6 GB | ~38 GB |

MLX does **not** swap — if a load would exceed RAM, LM Studio refuses it. Raise these knobs
for bigger repos only if the total stays under ~44 GB.

### Where everything lives

| Path | What |
|------|------|
| `shell/llm.zsh` | the `ask`/`chat`/`llm-serve` commands (sourced from `~/.zshrc`) |
| `config/` | reference copies of the two config files below |
| `~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml` | tells `llm` how to reach LM Studio |
| `~/.config/opencode/opencode.json` | tells opencode how to reach LM Studio |
| `~/.lmstudio/models/mlx-community/*` | symlinks → the HF weights (LM Studio's view) |
| `~/.cache/huggingface/hub/*` | the actual model weights |
| `.venv/` | Python env (mlx, mlx-lm, llm, llm-mlx) |

### Swapping in a different model

The shell helpers reference **aliases**, so swapping is cheap:

- **Cold path:** `llm mlx download-model mlx-community/<new>` then
  `llm aliases set coder-fast mlx-community/<new>`.
- **Warm path:** put `<new>` in `~/.lmstudio/models/…`, load it in LM Studio, and update the
  `model_name` in `extra-openai-models.yaml`.

### Why this model

- **Skip Qwen2.5-Coder-32B** (previous gen): it emits tool calls as *plain text* and **breaks
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
