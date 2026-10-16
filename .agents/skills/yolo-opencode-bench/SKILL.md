---
name: yolo-opencode-bench
description: Quick opencode agent benchmark (tool calls and file edits) against the local model served on :1234, with memory logging. Use when asked to test how a local model does with opencode, tool calling, or file editing, or to compare setups end to end.
---

# Yolo opencode bench

Five small tasks (create file, fix failing unit test, multi-file rename, find a buried secret, edit config and run a script), each with a shell pass/fail check, run via `opencode run --standalone --auto --format json`. Metrics per run: pass, tool calls, tool errors, wall seconds. Takes ~5-10 minutes with oMLX + DFlash on Qwen3.8-27B.

Run from the repo root. Never start, stop, load, or unload models.

1. Preconditions: `opencode --version` works (if macOS kills it with "Code Signature Invalid", `brew upgrade opencode`); server up (`curl -s localhost:1234/v1/models`); the model's loaded context is >= 32k (LM Studio defaults to 8192, which fails; oMLX has no such default).
2. Edit `bench/opencode/oc-omlx.json` only if the model id or limits change. Keep `limit.context` at or below the measured ceiling in `docs/OMLX-WORK-MACHINE.md` (98304 for Qwen3.8-27B on this 48 GB Mac). The harness uses this per-run config, never the user's global opencode config.
3. Start `bench/mem/memlog.sh <scratch>/oc-mem.csv 1` in the background.
4. `bench/opencode/run.sh <MODEL_ID> <label> 2 900` (2 reps, 900 s timeout; `PROVIDER=lmstudio` for the LM Studio provider name; `ONLY="t1 t5"` to run a subset). Run it in the background and wait for completion; do not poll in a tight loop. Results: `bench/opencode/results-<label>.tsv` and per-run logs in `bench/opencode/runs/<label>/` (both gitignored).
5. Stop the logger. Report pass rate, avg tool calls and seconds per task, any tool errors or non-zero exit codes, and peak wired / swap / pressure. For a failed task read that run's `ev.jsonl` and `err.txt` before guessing at causes.
6. Compare with the table in `docs/OMLX-WORK-MACHINE.md` (oMLX + DFlash2: 10/10, fix-failing-test ~39 s).

Note: leftover swap from earlier runs is not freed by macOS; mention it when times look slow.
