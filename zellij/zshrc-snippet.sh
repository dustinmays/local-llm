# zellij: attach to a named session, or create+attach if it doesn't exist yet.
# Mirrors `tmux new -A -s name`. Usage: zj minder
zj() {
  if [ -z "$1" ]; then
    zellij attach --create "$(basename "$PWD")"
  else
    zellij attach --create "$1"
  fi
}
