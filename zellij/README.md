# Ghostty + Zellij terminal setup

Persistent sessions, splits, and tabs for Ghostty, using Zellij instead of
tmux. Chosen over tmux because Zellij has session/layout persistence built
in — no plugin manager, no `tmux-resurrect` + `tmux-continuum` config.

## Install

```
brew install zellij
```

## Apply the config

```
mkdir -p ~/.config/zellij ~/.config/ghostty
cp zellij/config.kdl ~/.config/zellij/config.kdl
cp zellij/ghostty-config ~/.config/ghostty/config
cat zellij/zshrc-snippet.sh >> ~/.zshrc
```

If you already have a Ghostty or shell config, merge these in by hand
instead of overwriting.

## Usage

```
zj minder     # attach to session "minder", creating it if needed
zj            # attach using the current directory's name
```

Inside a session: `Ctrl+p` for pane actions, `Ctrl+t` for tab actions,
`Ctrl+o d` to detach without losing anything. `⌘\`` opens Ghostty's
disposable quick-terminal outside the zellij workspace; `⌘⇧Z` zooms the
focused pane.

Quit Ghostty entirely (not just close the tab) and relaunch — `zj <name>`
brings back the same tabs, splits, and recent scrollback.

## Caveat

Zellij restores layout, commands, and scrollback, not a running program's
internal state. An AI agent (Claude Code, etc.) that was mid-conversation in
a pane comes back as a fresh process in the right directory, not resumed —
that's the agent harness's own session-resume feature, not something the
multiplexer can provide.
