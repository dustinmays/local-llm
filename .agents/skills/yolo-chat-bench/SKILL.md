---
name: yolo-chat-bench
description: Quick chat benchmark of the local model served on :1234 (oMLX or LM Studio) with memory and performance logging. Use when asked to benchmark, compare, or sanity-check a local model's chat quality, decode speed, or prefill speed, or to see what a settings change (drafter, parallel slots, quantization) did.
---

# Yolo chat bench

Fast, repeatable chat benchmark: 11 capability-matrix prompts (C1-C10, C12) plus prefill/decode at ~2k and ~8k tokens. Takes 2-5 minutes on a 27B model. Thinking stays on.

Run from the repo root. Never start, stop, load, or unload models; if the model is not served, tell the user. Scratch output goes in the session scratchpad, not the repo.

1. Check the server and get the exact model id: `curl -s localhost:1234/v1/models`.
2. Start the memory logger in the background: `bench/mem/memlog.sh <scratch>/chat-mem.csv 1` (save its pid). Optional live view: `macmon`.
3. Run `python3 -I bench/yolo_chat.py <MODEL_ID> <scratch>/chat.json`. One run at a time; do not run other inference at the same time.
4. Stop the logger. Summarize: median/max decode tok/s, total seconds for the 11 prompts, time to first token at 2k and 8k, empty answers, and peak wired MB / peak swap MB / peak pressure from the CSV (columns: ts,wired_mb,active_mb,compressed_mb,free_mb,swap_used_mb,free_pct,pressure,lms_rss_mb,pageouts).
5. Compare against the baselines in `docs/OMLX-WORK-MACHINE.md` (oMLX + DFlash2: ~41.6 tok/s decode, ~128 s total, ~14 s to first token at 6.6k tokens). C8 is known to exhaust 2048 tokens while thinking; that is not a regression.
6. Spot-check any answer that differs from a prior run before calling it worse (speculative decoding changes wording, not correctness).

Report the answer first (faster/slower, by how much, memory headroom), details after.
