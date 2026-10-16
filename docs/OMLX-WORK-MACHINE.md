# Work Mac setup: oMLX + Qwen3.8-27B + DFlash (single model)

Snapshot of the work-Mac setup as of **2026-10-16**. This supersedes
[`LMSTUDIO-WORK-MACHINE.md`](LMSTUDIO-WORK-MACHINE.md): the work Mac now runs
**oMLX on `:1234`** with one model for everything (chat, `ask`, `review`,
`dictate`, opencode). LM Studio is still installed but not running (launch at
login off) so it does not fight for port 1234.

## Hardware / software

| | |
| --- | --- |
| Machine | MacBook, Apple silicon, 48 GB unified memory, macOS 27.0.1 |
| oMLX | 0.7.1rc1, Homebrew (`brew tap jundot/omlx https://github.com/jundot/omlx`) |
| Install flags | `brew install jundot/omlx/omlx --with-custom-kernel` (Qwen3.5-family models need the native kernels or fall back to slow paths) |
| Prereq | Full Xcode **plus** the Metal Toolchain: `xcodebuild -downloadComponent MetalToolchain` (~840 MB). Without it the kernel build fails with "cannot execute tool 'metal'". |
| Opencode | 2.0.30 (Homebrew). 1.18.30 was killed on launch by macOS ("Code Signature Invalid"); `brew upgrade opencode` fixed it. |
| Service | `brew services start omlx` (LaunchAgent `sh.brew.omlx`, runs `omlx serve` with settings from `~/.omlx/settings.json`, log `/opt/homebrew/var/log/omlx.log`) |

## Model and drafter

- Target: `mlx-community/Qwen3.8-27B-4bit` -> `~/omlx-models/Qwen3.8-27B-4bit` (15 GB; arch `qwen3_5`, 16 of 64 layers full attention, rest linear).
- Drafter: `z-lab/Qwen3.8-27B-DFlash2` -> `~/omlx-drafts/Qwen3.8-27B-DFlash2` (3.6 GB, kind `dflash2`, target layers 5/19/33/47/61). Kept **outside** the model dir so oMLX does not list it as a chat model.
- Per-model settings live in `~/.omlx/model_settings.json` (backup `.bak-pre-dflash`). Changed for `Qwen3.8-27B-4bit` only:
  `dflash_enabled: true`, `dflash_draft_model: ~/omlx-drafts/Qwen3.8-27B-DFlash2`, `dflash_block_size: 5` (default is 8; the z-lab card suggests <= 5 for quantized MLX). `mtp_enabled` stays off (mutually exclusive with DFlash).
- Thinking stays **on**. Sampler per model card: temperature 1.0, top_p 0.95, top_k 20.
- The drafter loads lazily on the first request; the log line is `DFlash drafter loaded ... kind=dflash2 block=5`.

## Shell and opencode wiring (per machine, not tracked)

- `~/.config/local-llm/env`: `LLM_SERVE_PORT=1234`, `LLM_MODEL=qwen`, `LLM_MODEL_HQ=qwen`.
- `~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml`: one entry, `model_id: qwen` -> `Qwen3.8-27B-4bit` at `http://127.0.0.1:1234/v1` (no `api_key_name`; a missing key makes `llm` hang).
- `shell/llm.zsh` (tracked): now single-model; `LLM_MODEL_HQ` defaults to `LLM_MODEL`.
- `~/.config/opencode/opencode.json`: provider `omlx` -> `:1234`, model `omlx/Qwen3.8-27B-4bit`, context 131072, output 16384, timeout 900000. The `lmstudio` provider was removed; `mlxcluster` untouched.
  **Warning:** `cluster/bin/install-opencode` overwrites that file from `config/opencode.json` in this repo, which still describes the old setup.

## Benchmarks (tooling in `bench/`)

`bench/yolo_chat.py` (11 capability-matrix prompts + prefill/decode), `bench/opencode/` (5 file/tool tasks with shell pass/fail checks, driven by `opencode run --standalone --auto --format json`), `bench/mem/memlog.sh` (1 s CSV of wired/swap/pressure). `macmon` (Homebrew) for live GPU/RAM view.

Chat, Qwen3.8-27B, thinking on, temperature 0:

| Setup | Decode tok/s (median) | 11 prompts total | Start of 6.6k-token prompt |
| --- | --- | --- | --- |
| LM Studio (MLX) | 17.6 | 277 s | 49 s |
| oMLX, no drafter | 17.6 | 264 s | 14 s |
| oMLX + DFlash2 (block 5) | **41.6** (max 48.7) | **128 s** | 14 s |

DFlash acceptance was ~72-85 % (about 3 tokens per cycle). Answers matched or differed only in wording (spot-checked C2, C12). C8 (import/TypeError) exhausts 2048 output tokens while thinking, with or without the drafter.

Opencode task set (2 reps each, `bench/opencode/run.sh`), avg tool calls / seconds per task:

| Task | LM Studio + Qwen3.8 | oMLX + Qwen3.8 + DFlash2 |
| --- | --- | --- |
| create file | 1.5 / 32 s | 2 / 27 s |
| fix failing test | 15 / 443 s | 6 / **39 s** |
| multi-file rename | 11 / 138 s | 9.5 / 51 s |
| find buried secret | 4 / 43 s | 3 / 25 s |
| edit config + run script | 5.5 / 59 s | 4 / 30 s |
| **pass rate** | 10/10 | **10/10**, 0 tool errors |

The LM Studio run was under heavy swap (12 GB), so its times are a worst case; the oMLX run had 8 GB of leftover swap but
pressure stayed normal (peak wired 31.5 GB). Opencode context was capped at 98304 for the oMLX run.

Gemma 4 E4B passed 5/5 in a single-rep opencode smoke test; it has since been removed.

## Parked / findings

- **Nemotron 3.5 Bolt 74B-A9B (24 GB GGUF):** parked. ~4.7 tok/s on this Mac; llama.cpp issue #30610 says the NVFP4 Mamba tensors have no Metal kernel and run on the CPU (one user got ~6x from converting those tensors to Q8_0). MLX build fails to load in LM Studio (`nemotron_h_puzzle` unsupported). NVIDIA's LiLiCorr draft is vLLM/Blackwell only per its model card.
- **LM Studio draft model for Qwen:** untested; needs Max Concurrent Predictions = 1 (mlx-engine issue #269). Moot now that oMLX has DFlash2.
- **Gotchas:** LM Studio defaults to an 8192 context, too small for opencode (its prompt + tools exceed it). `omlx` process title is `omlx-server`, so `pkill -f "omlx serve"` misses it. oMLX also scans the Hugging Face cache by default (`hf_cache_enabled`).
- **KV math for Qwen3.8-27B (from config.json):** 16 full-attention layers x 4 KV heads x 256 head_dim x 2 (K,V) x 2 bytes = 64 KiB/token (3 GiB at 48k, 8 GiB at 128k, 16 GiB at 262k) plus a fixed ~150 MB linear-attention state. Theoretical; the measured ceiling is recorded below once run.

## Context ceiling (measured 2026-10-16)

Qwen3.8-27B-4bit + DFlash2 drafter on oMLX 0.7.1rc1, 48 GB Mac, thinking on, temperature 0, one request at a time,
Vivaldi/Slack/Music open, swap already at 4.6 GB. Method: `bench/ctx_ceiling.py` (random hex log lines + one planted
`MAGIC_TOKEN`, ask for it) with `bench/mem/memlog.sh` logging once per second. Cold prompts (no prefix-cache hit).

| Prompt | Time to first token | Needle | Peak wired | Swap | Pressure | Min free |
| --- | --- | --- | --- | --- | --- | --- |
| 16k | 36 s | found | 28.8 GB | flat | 1 (normal) | 30 % |
| 32k | 75 s | found | 30.0 GB | flat | 1 | 26 % |
| 48k | 120 s | found | 31.4 GB | flat | 1 | 20 % |
| 64k | 161 s | found | 31.4 GB | flat | 1 | 20 % |
| 96k | 279 s | found | 31.8 GB | flat | 1 | 17 % |
| 128k | 432 s | found | **37.0 GB** | **+4.1 GB (4.6 -> 8.7)** | **2 (warn)** | 8 % |

Baseline before the first request: 23.2 GB wired (weights + drafter loaded).

**Recommended ceiling: ~96k tokens (set opencode `limit.context` to 98304), comfortable working range 64k.**

- Every rung retrieved the needle, so quality is not what limits it; memory is.
- 128k pushed wired memory to the ~37 GB Metal cap (`max_recommended_working_set_size` 37.4 GB), grew swap by 4 GB and
  hit pressure level 2. It works but stalls the rest of the machine, so treat it as off-limits.
- At ~94-96k oMLX's own prefill guard starts logging `Prefill above max_bytes ... 28.1GB > 27.8GB` (about 300 warnings in
  this run, from ~94k tokens up; the "balanced" tier ceiling is ~27.8 GB). 96k is therefore the practical limit.
- Prefill is slow when cold: ~470 tok/s early, slowing with length (96k = 4.7 min, 128k = 7.2 min). Prefix reuse is what
  makes long agent sessions usable; the prefix cache was **not** exercised by this test.
- Decode stayed at 16-33 tok/s with DFlash across rungs (16 tok/s at 128k).
- KV growth is smaller than the 64 KiB/token estimate suggests for the first 96k (wired rose ~3 GB from 16k to 96k vs
  ~5 GB predicted), but oMLX's transient prefill memory dominates near the limit.
- `max_context_window: 32768` in `~/.omlx/settings.json` did **not** block longer prompts.
- Free RAM matters: this ran with ~4.6 GB of swap already in use. A browser with many tabs shrinks the margin, so close
  heavy tabs before long-context agent runs.

### Prefix cache (`bench/prefix_cache.py`, 32k-token prefix)

| Request | Time to first token |
| --- | --- |
| 1. cold | 74.1 s |
| 2. identical repeat | **1.0 s** |
| 3. same prefix, new question at the end | **3.4 s** |

The oMLX prefix cache works for this hybrid model: repeated or growing agent prompts skip the slow prefill, so the 4-5
minute cold prefill at 96k is a one-time cost per session. Keep the start of the prompt stable (no timestamps or
reordered tools near the top).

Not yet measured: two concurrent long requests, and agent runs that approach 96k in a real session.
