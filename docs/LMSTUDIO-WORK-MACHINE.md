# Running the shell helpers on LM Studio (work Mac)

The repo's source of truth (`src/shared-config.ts`) assumes **oMLX on `:8000`**
serving `gemma-4-e4b-mlx` and `qwen3.6-27b-4bit`. The work Mac still uses
**LM Studio on `:1234`** with different models, so the generated config does not
apply there. Rather than fork the shared config, the work Mac uses a small
per-machine override.

## What differs

| | Home / oMLX (repo default) | Work / LM Studio |
| --- | --- | --- |
| Port | `8000` | `1234` |
| `ask` / `chat` model | `gemma` (`gemma-4-e4b-mlx`) | `lm-fast` (`qwen3-4b-instruct-2507`) |
| `askhq` / `chathq` / `review` model | `qwen` (`qwen3.6-27b-4bit`) | `lm-hq` (`qwen/qwen3.6-35b-a3b`) |
| Model lifecycle | oMLX loads on first request | LM Studio loads on first request (~12-15 s) |

Gemma and Muse are not installed in LM Studio on the work Mac.

## Setup (once per machine)

1. **Shell override** — `~/.config/local-llm/env` (not tracked in git). It is
   sourced by `shell/llm.zsh` after the generated `shell/llm.env`:

   ```sh
   export LLM_SERVE_PORT=1234
   export LLM_MODEL=lm-fast
   export LLM_MODEL_HQ=lm-hq
   ```

2. **`llm` CLI models** — `~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml`:

   ```yaml
   - model_id: lm-fast
     model_name: qwen3-4b-instruct-2507
     api_base: http://127.0.0.1:1234/v1
   - model_id: lm-hq
     model_name: qwen/qwen3.6-35b-a3b
     api_base: http://127.0.0.1:1234/v1
   ```

   Use the ids exactly as `lms ls` or `curl localhost:1234/v1/models` print them.

3. Make sure the LM Studio server is running (`lms server start` or the app).

## Verify

```sh
curl -s localhost:1234/v1/models      # model ids the server offers
source ~/repos/local-llm/shell/llm.zsh
ask "Reply with only the word OK"     # fast model
askhq "Reply with only the word OK"   # 35B model, slower first call
```

The terminal banner prints the active models and port, so a wrong override is
visible when a shell starts.

## Gotchas

- `model_name` in the yaml must match an id LM Studio serves, or the call fails.
- `LLM_MODEL` / `LLM_MODEL_HQ` must match a `model_id` in the yaml, or `llm`
  reports `'<name>' is not a known model`.
- Do not edit `shell/llm.env` or `config/extra-openai-models.yaml` for this;
  they are generated and will be overwritten by `pnpm config:render`.
- `CLAUDE.md` still describes Gemma + Muse and the `qwen3.6-35b` trust tiers.
  Those describe the home setup and the older matrix run, not this machine.
