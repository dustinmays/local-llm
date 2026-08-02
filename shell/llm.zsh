# local-llm shell helpers — MLX daily driver.
# Source this from ~/.zshrc:  source ~/repos/local-llm/shell/llm.zsh
#
# Serving engine: LM Studio (`lms`), which holds the model warm with idle auto-evict.
# Command frontend: Simon Willison's `llm` CLI (one-shots, pipes, logging).
#   * WARM  — `llm-serve` starts LM Studio's server; queries are instant.
#   * COLD  — server down; `ask`/`chat` fall back to in-process mlx-lm (~3s load). Still works.
#
# Model swapping:
#   warm path  -> load a new model in LM Studio and update model_name in
#                 "~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml"
#   cold path  -> llm mlx download-model <repo>; llm aliases set coder-fast <repo>

LOCAL_LLM_DIR="$HOME/repos/local-llm"
export LLM_BIN="$LOCAL_LLM_DIR/.venv/bin/llm"
export LMS_BIN="$HOME/.lmstudio/bin/lms"
export LLM_SERVE_PORT=1234
export LLM_SERVE_MODEL="qwen3-coder-30b-a3b-instruct@4bit"
export LLM_SERVE_MODEL_HQ="qwen3-coder-30b-a3b-instruct@8bit"
# Context length per model. Big enough for opencode (system prompt + tools + files).
# KV cache is ~96 KB/token, so total RAM = weights + ctx*96KB. Kept within 48 GB:
#   4-bit: 17 GB + 128K ctx (12.9 GB) = ~30 GB
#   8-bit: 32 GB +  64K ctx (6.4 GB)  = ~38 GB  (raise only for dedicated/overnight runs)
export LLM_SERVE_CTX=131072
export LLM_SERVE_CTX_HQ=65536

# true if LM Studio's server is answering
_llm_up() { curl -s -m 1 -o /dev/null "http://localhost:${LLM_SERVE_PORT}/v1/models" 2>/dev/null; }
# which coder model is currently loaded (empty if none)
_llm_loaded() { "$LMS_BIN" ps 2>/dev/null | grep -oE 'qwen3-coder-30b-a3b-instruct@[0-9]+bit' | head -1; }
# ensure the wanted model ($1) is resident at context ($2). Evicts a different model first
# (4-bit 17 GB + 8-bit 32 GB > 48 GB, can't co-reside); explicit load avoids LM Studio's
# tiny 8K JIT default. Same-model-already-loaded stays warm (no reload).
_llm_ensure() {
  [ "$(_llm_loaded)" = "$1" ] && return 0
  "$LMS_BIN" unload --all >/dev/null 2>&1
  "$LMS_BIN" load "$1" -c "$2" --gpu max -y >/dev/null 2>&1
}

llm-serve() {                              # start server + load the 4-bit daily driver @ big ctx
  "$LMS_BIN" server start >/dev/null 2>&1
  "$LMS_BIN" unload --all >/dev/null 2>&1
  "$LMS_BIN" load "$LLM_SERVE_MODEL" -c "$LLM_SERVE_CTX" --gpu max -y 2>&1 | tail -1
  _llm_up && echo "warm: 4-bit @ ${LLM_SERVE_CTX} ctx on http://localhost:${LLM_SERVE_PORT}" || echo "check: lms server status"
}
llm-serve-hq() {                           # load the 8-bit @ big ctx (for opencode/overnight)
  "$LMS_BIN" server start >/dev/null 2>&1
  "$LMS_BIN" unload --all >/dev/null 2>&1
  "$LMS_BIN" load "$LLM_SERVE_MODEL_HQ" -c "$LLM_SERVE_CTX_HQ" --gpu max -y 2>&1 | tail -1
  _llm_up && echo "warm: 8-bit @ ${LLM_SERVE_CTX_HQ} ctx on http://localhost:${LLM_SERVE_PORT}" || echo "check: lms server status"
}
llm-serve-stop()   { "$LMS_BIN" unload --all >/dev/null 2>&1; "$LMS_BIN" server stop 2>&1 | tail -1; }
llm-serve-status() { "$LMS_BIN" server status 2>&1 | head -1; "$LMS_BIN" ps 2>&1 | tail -n +1; }

# --- one-shots (auto warm/cold) --------------------------------------------
# Fast daily driver.  Usage: ask "explain X"   |   cat f.py | ask "review"
ask()   { if _llm_up; then _llm_ensure "$LLM_SERVE_MODEL" "$LLM_SERVE_CTX";       "$LLM_BIN" -m coder-live "$@";    else "$LLM_BIN" -m coder-fast "$@"; fi; }
# High-quality 8-bit. Evicts the 4-bit first if it's loaded (they can't co-reside in 48 GB).
askhq() { if _llm_up; then _llm_ensure "$LLM_SERVE_MODEL_HQ" "$LLM_SERVE_CTX_HQ"; "$LLM_BIN" -m coder-live-hq "$@"; else "$LLM_BIN" -m coder-hq "$@"; fi; }
# Continue the LAST conversation.
askc()  { "$LLM_BIN" -c "$@"; }

# --- interactive chat ------------------------------------------------------
chat()   { if _llm_up; then _llm_ensure "$LLM_SERVE_MODEL" "$LLM_SERVE_CTX";       "$LLM_BIN" chat -m coder-live "$@";    else "$LLM_BIN" chat -m coder-fast "$@"; fi; }
chathq() { if _llm_up; then _llm_ensure "$LLM_SERVE_MODEL_HQ" "$LLM_SERVE_CTX_HQ"; "$LLM_BIN" chat -m coder-live-hq "$@"; else "$LLM_BIN" chat -m coder-hq "$@"; fi; }

# --- code review (8-bit + reviewer system prompt) --------------------------
# Usage:  git diff | review        |        review < path/to/file.py
review() {
  local m; if _llm_up; then _llm_ensure "$LLM_SERVE_MODEL_HQ" "$LLM_SERVE_CTX_HQ"; m=coder-live-hq; else m=coder-hq; fi
  "$LLM_BIN" -m "$m" -s \
    "You are a meticulous senior engineer doing a code review. Point out bugs, \
edge cases, security issues, and unclear naming. Be specific and cite the \
relevant snippet. If the code is fine, say so briefly." "$@"
}

# --- utilities -------------------------------------------------------------
llm-log() { "$LLM_BIN" logs -n "${1:-3}"; }   # show last N logged exchanges

# --- new-terminal reminder (interactive shells only) -----------------------
if [[ -o interactive ]]; then
  print -P "%F{244}local-llm ›%f warm a model: %F{39}llm-serve%f (4-bit·128K)  %F{39}llm-serve-hq%f (8-bit·64K)%F{244}  —  then: ask · chat · review%f"
fi
