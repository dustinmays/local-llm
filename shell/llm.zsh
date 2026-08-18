# local-llm shell helpers — terminal chat/ask against local models.
# Source this from ~/.zshrc:  source ~/repos/local-llm/shell/llm.zsh
#
# Serving:   LM Studio holds the models warm. Start the server + load a model
#            from the LM Studio app (or `lms load`). These helpers do NOT manage
#            model lifecycle — they just talk to whatever LM Studio is serving.
# Frontend:  Simon Willison's `llm` CLI (one-shots, pipes, interactive chat, logging),
#            pointed at LM Studio's OpenAI endpoint via extra-openai-models.yaml.
#
# Models (see ~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml):
#   gemma -> google/gemma-4-e4b   (fast, snappy — default for ask/chat)
#   muse  -> meta/muse-glimmer    (heavier reasoning — askhq/chathq/review)

LOCAL_LLM_DIR="$HOME/repos/local-llm"
export LLM_BIN="$LOCAL_LLM_DIR/.venv/bin/llm"
export LMS_BIN="$HOME/.lmstudio/bin/lms"
export LLM_SERVE_PORT=1234
export LLM_MODEL="gemma"      # default fast model for ask/chat
export LLM_MODEL_HQ="muse"    # heavier reasoning model for askhq/chathq/review

# Warn (but don't block) if LM Studio's server isn't answering.
_llm_check() {
  curl -s -m 1 -o /dev/null "http://localhost:${LLM_SERVE_PORT}/v1/models" 2>/dev/null && return 0
  print -u2 -P "%F{214}local-llm ›%f LM Studio server not responding on :${LLM_SERVE_PORT} — start it in the app (or: lms server start)."
  return 1
}

# --- one-shots -------------------------------------------------------------
# Fast default.  Usage:  ask "explain X"   |   cat f.py | ask "review this"
ask()   { _llm_check; "$LLM_BIN" -m "$LLM_MODEL"    "$@"; }
# Heavier reasoning (Muse Glimmer).
askhq() { _llm_check; "$LLM_BIN" -m "$LLM_MODEL_HQ" "$@"; }
# Continue the LAST conversation.
askc()  { "$LLM_BIN" -c "$@"; }

# --- interactive chat ------------------------------------------------------
chat()   { _llm_check; "$LLM_BIN" chat -m "$LLM_MODEL"    "$@"; }
chathq() { _llm_check; "$LLM_BIN" chat -m "$LLM_MODEL_HQ" "$@"; }

# --- code review (Muse + reviewer system prompt) ---------------------------
# Usage:  git diff | review        |        review < path/to/file.py
review() {
  _llm_check
  "$LLM_BIN" -m "$LLM_MODEL_HQ" -s \
    "You are a meticulous senior engineer doing a code review. Point out bugs, \
edge cases, security issues, and unclear naming. Be specific and cite the \
relevant snippet. If the code is fine, say so briefly." "$@"
}

# --- dictation cleanup (Whisper transcript -> fluent prose) ----------------
# Usage:  pbpaste | dictate | pbcopy        |        dictate < transcript.txt
dictate() {
  _llm_check
  "$LLM_BIN" -m "$LLM_MODEL" -s \
    "You clean up raw speech-to-text dictation into fluent, well-punctuated \
prose. Fix punctuation, capitalization, and grammar. Remove filler words, \
false starts, and verbal stutters. Preserve the speaker's meaning, tone, and \
word choice — do not summarize, rephrase ideas, or add content that wasn't \
said. Output only the cleaned text, with no preamble or commentary." "$@"
}

# --- utilities -------------------------------------------------------------
llm-log() { "$LLM_BIN" logs -n "${1:-3}"; }   # show last N logged exchanges

# --- new-terminal reminder (interactive shells only) -----------------------
if [[ -o interactive ]]; then
  print -P "%F{244}local-llm ›%f %F{39}ask%f · %F{39}chat%f (gemma)  %F{39}askhq%f · %F{39}chathq%f · %F{39}review%f (muse)  %F{244}— models served by LM Studio%f"
fi
