#!/bin/bash

set -euo pipefail

CLUSTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLUSTER_REPO_ROOT="$(cd "$CLUSTER_LIB_DIR/../.." && pwd -P)"
CLUSTER_CONFIG_FILE="${CLUSTER_CONFIG_FILE:-$CLUSTER_REPO_ROOT/cluster/config.local.env}"
CLUSTER_GENERATED_DIR="$CLUSTER_REPO_ROOT/cluster/generated"
CLUSTER_RUN_DIR="$CLUSTER_REPO_ROOT/cluster/run"

cluster_note() { printf 'cluster: %s\n' "$*"; }
cluster_warn() { printf 'cluster: warning: %s\n' "$*" >&2; }
cluster_die() { printf 'cluster: error: %s\n' "$*" >&2; exit 1; }

cluster_mise() {
  if [ -x /opt/homebrew/bin/mise ]; then
    printf '%s\n' /opt/homebrew/bin/mise
  elif command -v mise >/dev/null 2>&1; then
    command -v mise
  else
    cluster_die "mise is not installed; run 'brew install mise'"
  fi
}

cluster_load_config() {
  [ -f "$CLUSTER_CONFIG_FILE" ] || cluster_die "missing $CLUSTER_CONFIG_FILE; run 'mise run cluster:init'"
  # shellcheck disable=SC1090
  source "$CLUSTER_CONFIG_FILE"

  : "${CLUSTER_CONTROLLER_ALIAS:?missing CLUSTER_CONTROLLER_ALIAS}"
  : "${CLUSTER_CONTROLLER_HOST:?missing CLUSTER_CONTROLLER_HOST}"
  : "${CLUSTER_CONTROLLER_USER:?missing CLUSTER_CONTROLLER_USER}"
  : "${CLUSTER_CONTROLLER_SSH:?missing CLUSTER_CONTROLLER_SSH}"
  : "${CLUSTER_WORKER_ALIAS:?missing CLUSTER_WORKER_ALIAS}"
  : "${CLUSTER_WORKER_HOST:?missing CLUSTER_WORKER_HOST}"
  : "${CLUSTER_WORKER_USER:?missing CLUSTER_WORKER_USER}"
  : "${CLUSTER_WORKER_REPO:?missing CLUSTER_WORKER_REPO}"
  : "${CLUSTER_BACKEND:?missing CLUSTER_BACKEND}"
  : "${CLUSTER_TRANSPORT:?missing CLUSTER_TRANSPORT}"
  : "${CLUSTER_MODEL:?missing CLUSTER_MODEL}"
  : "${CLUSTER_MODEL_FAST:?missing CLUSTER_MODEL_FAST}"
  : "${CLUSTER_MODEL_TEST:?missing CLUSTER_MODEL_TEST}"
  : "${CLUSTER_SHARED_ROOT:?missing CLUSTER_SHARED_ROOT}"

  CLUSTER_API_HOST="${CLUSTER_API_HOST:-127.0.0.1}"
  CLUSTER_API_PORT="${CLUSTER_API_PORT:-8080}"
  CLUSTER_MAX_OUTPUT_TOKENS="${CLUSTER_MAX_OUTPUT_TOKENS:-4096}"
  CLUSTER_PROMPT_CACHE_SIZE="${CLUSTER_PROMPT_CACHE_SIZE:-1}"
  CLUSTER_PROMPT_CACHE_BYTES="${CLUSTER_PROMPT_CACHE_BYTES:-4294967296}"
  CLUSTER_SSH_KEY="${CLUSTER_SSH_KEY:-$HOME/.ssh/id_ed25519_local_llm_cluster}"
  CLUSTER_WORKER_SSH="$CLUSTER_WORKER_ALIAS"
  CLUSTER_HOSTFILE="$CLUSTER_GENERATED_DIR/hosts-$CLUSTER_BACKEND.json"
  CLUSTER_PIDFILE="$CLUSTER_RUN_DIR/server.pid"
  CLUSTER_MODEL_FILE="$CLUSTER_RUN_DIR/server.model"
  CLUSTER_LOGFILE="$CLUSTER_RUN_DIR/server.log"
}

cluster_python() {
  local mise_bin
  mise_bin="$(cluster_mise)"
  "$mise_bin" -C "$CLUSTER_REPO_ROOT" exec -- python "$@"
}

cluster_exec() {
  local mise_bin
  mise_bin="$(cluster_mise)"
  "$mise_bin" -C "$CLUSTER_REPO_ROOT" exec -- "$@"
}

cluster_remote() {
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$CLUSTER_WORKER_SSH" "$@"
}

cluster_model_cache_dir() {
  local model="$1"
  printf '%s/.cache/huggingface/hub/models--%s\n' "$HOME" "${model//\//--}"
}

cluster_require_hostfile() {
  [ -s "$CLUSTER_HOSTFILE" ] || cluster_die "missing $CLUSTER_HOSTFILE; run 'mise run cluster:configure'"
}

cluster_server_up() {
  curl -fsS --max-time 2 "http://$CLUSTER_API_HOST:$CLUSTER_API_PORT/v1/models" >/dev/null 2>&1
}

cluster_read_pid() {
  [ -f "$CLUSTER_PIDFILE" ] || return 1
  local pid
  pid="$(sed -n '1p' "$CLUSTER_PIDFILE")"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$pid"
}

cluster_launcher_running() {
  local pid
  pid="$(cluster_read_pid)" || return 1
  kill -0 "$pid" 2>/dev/null
}

cluster_cleanup_ranks() {
  # The API port uniquely identifies this managed server. mlx.launch can exit
  # before cleaning a rank whose background model-loader thread failed, so
  # terminate only mlx_lm server processes carrying this exact port.
  # Bracket the first character so pkill's own command line cannot match.
  local pattern="[m]lx_lm server .*--port $CLUSTER_API_PORT"
  pkill -TERM -f "$pattern" 2>/dev/null || true
  cluster_remote "pkill -TERM -f '$pattern' 2>/dev/null || true" 2>/dev/null || true
}
