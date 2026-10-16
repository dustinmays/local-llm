---
name: local-llm-context-ceiling
description: Find (or re-check) the safe maximum context length for a local model on this Mac by climbing a ladder of long prompts while logging wired memory, swap, and pressure. Use when changing the model, quantization, drafter, or oMLX memory settings, or when asked how much context the machine can handle.
---

# Local LLM context ceiling

Measured ceiling for Qwen3.8-27B-4bit + DFlash2 on oMLX (48 GB Mac): **~96k tokens** (opencode capped at 98304), comfortable 64k. Details and method in `docs/OMLX-WORK-MACHINE.md`. Re-measure whenever the model, quant, drafter, or `~/.omlx/settings.json` memory tier changes.

Run from the repo root. Never start, stop, load, or unload models. Ask the user to close heavy apps (Vivaldi tabs) first; record what was open.

1. Note baseline: `sysctl vm.swapusage`, `memory_pressure | tail -1`, top RSS processes.
2. Start `bench/mem/memlog.sh <scratch>/ctx-mem.csv 1` in the background and note the line count of `/opt/homebrew/var/log/omlx.log`.
3. `python3 -I bench/ctx_ceiling.py <MODEL_ID> <scratch>/ladder.json [tokens...]` (default ladder 16k, 32k, 48k, 64k, 96k, 128k; each rung is a cold prompt with a planted `MAGIC_TOKEN`; stops at the first error). Run in the background; the 128k rung alone takes ~7 minutes. Check on it every ~4 minutes.
4. Per rung, from the CSV, compute peak wired, swap growth, max pressure, min free %. Also grep the new oMLX log lines for `throttle|guard|Prefill above max_bytes|error`.
5. Safe ceiling = the highest rung where the needle is found, pressure stays 1, swap does not grow, and wired stays under ~34 GB (Metal cap is ~37.4 GB). Back off one rung from the first rung that breaks any of these.
6. Optional follow-ups: `bench/prefix_cache.py <MODEL_ID> <out.json> 32000` (cold vs repeat vs same-prefix; expect ~74 s -> ~1 s) and `bench/concurrent_long.py <MODEL_ID> <out.json> 48000 2` (two long cold requests at once).
7. Update the "Context ceiling" section of `docs/OMLX-WORK-MACHINE.md`, and propose (do not silently apply) a matching `limit.context` in the user's opencode config.

KV math for sanity-checking (Qwen3.8-27B): 16 full-attention layers x 4 KV heads x 256 dim x 2 (K,V) x 2 bytes = 64 KiB/token, plus a fixed linear-attention state. Real peaks are dominated by transient prefill memory near the limit.
