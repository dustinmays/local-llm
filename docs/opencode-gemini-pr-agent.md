# Task: Use OpenCode + Gemini 3.7 Flash to open a PR

You will drive **OpenCode** (headless) with **Google Gemini 3.7 Flash** (via OpenRouter)
to make a code change and open a GitHub pull request against a specific base branch.

## Inputs (supplied by the orchestrator)
- `REPO_DIR`   = <absolute path to the local git clone, e.g. /Users/dustin/repos/local-llm>
- `BASE_REF`   = <the base branch the PR targets, e.g. main or release/2.1>
- `TASK`       = <plain-English description of the change to make>
- `BRANCH`     = <new branch name, e.g. feat/gemini-<short-slug>>

## Environment facts (already true on this machine — do not re-configure)
- **Invoke `opencode` as a BARE leading command** — e.g. `opencode run ...`, not
  `/opt/homebrew/bin/opencode run ...` and not `$(command -v opencode)`. Claude Code's
  permission allow-rule is `Bash(opencode *)`, which only matches when `opencode` is the
  leading word; an absolute path or a command-substitution wrapper does NOT match the rule
  and gets sent to the auto-mode classifier, which blocks it. `opencode` already resolves
  globally on PATH (`/opt/homebrew/bin/opencode`), so the bare form always works.
- Sanity check before proceeding: `opencode --version` (should print 1.18.x).
  If that is blocked by the permission classifier, the `Bash(opencode *)` allow-rule is
  missing from settings — STOP and report that (it is a permission problem, not a repo or
  PATH problem). It is currently present in `~/.claude/settings.json` (global).
- **Directory-independent:** OpenCode does NOT need to be run from inside the target repo.
  Auth and the binary are user-global; `--dir "$REPO_DIR"` selects the repo. Running from
  a different repo/cwd is fine.
- OpenRouter is already authenticated for OpenCode (`~/.local/share/opencode/auth.json`,
  user-global — works from any directory). No API key setup needed.
- Model id: **`openrouter/google/gemini-3.7-flash`** (confirmed in the catalog).
- `gh` CLI v2.97 is authenticated as GitHub user **dustinmays**; `git` identity is
  "Dustin Mays <drm2010.dustin@gmail.com>". PRs will be created under that account.

## Model / delegation choice — why OpenCode, not the MLX delegate
The local `local_llm_delegate` MCP tool is **read-only** (text-in/text-out advice; no shell,
no git). It cannot create branches or PRs. OpenCode's default agent has real
bash/edit/write tools, which is what makes PR creation possible. Gemini 3.7 Flash runs the
agent loop; git/gh do the VCS work.

## Procedure

### 1. Prepare a clean branch off the exact base ref
```bash
cd "$REPO_DIR"
git fetch origin
git checkout -B "$BRANCH" "origin/$BASE_REF"   # branch from the intended base, not from whatever's checked out
```
If `BASE_REF` is a local-only ref, use `git checkout -B "$BRANCH" "$BASE_REF"`.

### 2. Make the change with Gemini 3.7 Flash (headless)
```bash
opencode run \
  -m openrouter/google/gemini-3.7-flash \
  --dir "$REPO_DIR" \
  --format json \
  "$TASK

Constraints:
- Only edit files needed for this task.
- Do NOT commit, push, or run git/gh yourself — a wrapper handles VCS.
- When done, print a one-paragraph summary of what changed and why."
```
Notes:
- `--format json` yields parseable events; drop it for human-readable output.
- OpenCode will prompt for tool permissions in interactive mode. For unattended runs you
  may add `--auto` to auto-approve — **this is dangerous** (it lets the model run any
  non-denied tool). Only use `--auto` in a sandbox/worktree you trust, and scope it with a
  restricted `--agent` (see "Safer variant" below).
- Keep the model confined to *editing* files. Let the deterministic steps below do git/gh,
  so branch/base/commit hygiene is controlled by you, not the model.

### 3. Review, commit, push
```bash
cd "$REPO_DIR"
git status
git --no-pager diff              # eyeball the change before committing
git add -A
git commit -m "<concise title>

<what/why>"
git push -u origin "$BRANCH"
```

### 4. Open the PR against the specific base ref
```bash
gh pr create \
  --base "$BASE_REF" \
  --head "$BRANCH" \
  --title "<PR title>" \
  --body  "<PR body: what changed, why, how verified>

Authored with OpenCode + Gemini 3.7 Flash (openrouter/google/gemini-3.7-flash)."
```
`--base "$BASE_REF"` is the load-bearing flag — it guarantees the PR targets the intended
reference rather than the repo's default branch.

### 5. Report
Print the PR URL from `gh pr create`, plus a short summary of the diff.

## Safer variant (recommended for unattended runs)
Create a scoped OpenCode agent so Gemini can edit but not touch git/network, then keep all
VCS in the deterministic wrapper (steps 1, 3, 4):
```bash
opencode agent create   # define an agent with edit+read tools, bash denied, then:
opencode run --agent <that-agent> -m openrouter/google/gemini-3.7-flash --dir "$REPO_DIR" "$TASK"
```

## Guardrails
- **Cost/egress:** Gemini via OpenRouter is a paid, remote call — repo contents are sent to
  a third party. Don't point it at secrets.
- **Verify before merge:** treat the diff as untrusted; run the repo's tests/linters
  (`pnpm check` here) before requesting review.
- Never merge automatically. Open the PR and stop.
