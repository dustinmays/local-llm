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

Opencode task set (2 reps each) on **LM Studio + Qwen3.8-27B**: 10/10 pass; avg tool calls / seconds per task: create-file 1.5 / 32, fix-failing-test 15 / 443, rename 11 / 138, find-secret 4 / 43, edit-config+run 5.5 / 59. Run under heavy swap (12 GB), so treat times as worst case. Not yet rerun on oMLX + DFlash.

Gemma 4 E4B passed 5/5 in a single-rep opencode smoke test; it has since been removed.

## Parked / findings

- **Nemotron 3.5 Bolt 74B-A9B (24 GB GGUF):** parked. ~4.7 tok/s on this Mac; llama.cpp issue #30610 says the NVFP4 Mamba tensors have no Metal kernel and run on the CPU (one user got ~6x from converting those tensors to Q8_0). MLX build fails to load in LM Studio (`nemotron_h_puzzle` unsupported). NVIDIA's LiLiCorr draft is vLLM/Blackwell only per its model card.
- **LM Studio draft model for Qwen:** untested; needs Max Concurrent Predictions = 1 (mlx-engine issue #269). Moot now that oMLX has DFlash2.
- **Gotchas:** LM Studio defaults to an 8192 context, too small for opencode (its prompt + tools exceed it). `omlx` process title is `omlx-server`, so `pkill -f "omlx serve"` misses it. oMLX also scans the Hugging Face cache by default (`hf_cache_enabled`).
- **KV math for Qwen3.8-27B (from config.json):** 16 full-attention layers x 4 KV heads x 256 head_dim x 2 (K,V) x 2 bytes = 64 KiB/token (3 GiB at 48k, 8 GiB at 128k, 16 GiB at 262k) plus a fixed ~150 MB linear-attention state. Theoretical; the measured ceiling is recorded below once run.

## Context ceiling

_Pending: measured with `bench/mem/memlog.sh` on a quiet machine (see commit history)._
