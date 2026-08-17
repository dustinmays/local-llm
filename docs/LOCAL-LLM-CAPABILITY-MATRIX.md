# Local Model Capability Matrix

Status: runnable evaluation spec. Purpose is to produce a short, evidence-backed
verdict per model: **what it can reliably do, what it can do with verification,
and what it must not be asked to do.**

This document is consumed by a future runner agent. It runs entirely through the
`local_llm_delegate` MCP tool. It is read-only and does not depend on token /
thinking-budget wiring (handled separately) — the runner uses whatever
per-prompt output caps are listed here.

## Models under test

| Slot | Model (as of 2026-08-17) | Backend | How selected |
| --- | --- | --- | --- |
| `fast` | `qwen3.6-35b` (`quality_class: fast`) | controller @ `127.0.0.1:1234` | `quality: "fast"` |
| `deep` | TBD — not yet loaded (cluster offline) | cluster | `quality: "deep"` |

Runs are **sequential and single-threaded**. Complete the entire `fast` run and
record it before starting the `deep` run. Never interleave.

## How to run one prompt

For each prompt, make exactly one `local_llm_delegate` call:

```
task:               <the prompt text from the matrix>
cwd:                /Users/dustin/repos/local-llm
quality:            "fast"   (fast run)  |  "deep"  (deep run)
busy_behavior:      "wait"
max_wait_seconds:   120
max_output_tokens:  <per-prompt cap in the matrix>
paths / include_diff: only where the prompt's Inputs column says so
```

Before each run, call `local_llm_status` and confirm the target model is loaded
and `availability: "ready"`. After each call, **verify `actual_quality` equals
the requested `quality`.** If `deep` silently falls back to `fast`, abort the
deep run and report it — the results would be meaningless.

Record from every response: `request_id`, `backend`, `model`, `actual_quality`,
`elapsed_seconds`, `truncated`, `input_characters`.

## Scoring — objective measures

Each response is scored on up to three measures, each on a **0–3 anchored
scale**. A measure marked `n/a` for a prompt is excluded from that prompt's
average.

**Correctness** — does the answer match the prompt's answer key?
- 0 wrong / misses the point · 1 partially right, major gap · 2 right, minor imprecision · 3 fully correct.

**Grounding** — does it stay inside the given evidence?
- 0 fabricates an API/fact/line that isn't there · 1 mostly grounded, one unsupported claim · 2 grounded, minor overreach · 3 fully grounded, or correctly says "insufficient context / not supported".

**Compliance** — did it obey the output format and scope constraints?
- 0 ignores format · 1 major deviation · 2 minor deviation · 3 exact.

Per-prompt normalized score = `sum(applicable measures) / (3 × count)` → 0.0–1.0.

**Rating bands** (applied to a prompt, and to a category = mean of its prompts):

| Band | Rule | Meaning |
| --- | --- | --- |
| **Good** | mean ≥ 0.80 **and** no Correctness=0 **and** no Grounding=0 | Reliable — safe to delegate |
| **Okay** | 0.55 ≤ mean < 0.80 | Usable, but verify every output |
| **Avoid** | mean < 0.55 **or** any Grounding=0 on a grounding-critical prompt | Do not delegate |

`truncated: true` caps that prompt's Compliance at 1 (it ran out of room — note
it and, if the cap looks too tight, re-run once with a higher `max_output_tokens`
before scoring).

---

## Round 1 — culling (breadth, one prompt per category)

Goal: eliminate categories the model is plainly bad at so Round 2 doesn't waste
runs on them. **A category advances to Round 2 only if its Round 1 prompt scores
Okay or better (≥ 0.55).** Grounding-critical categories (C2, C3, C8, C10) that
hit Grounding=0 are hard-failed to **Avoid** regardless of the other measures.

Prompts are self-contained (code inline) unless the Inputs column says
otherwise, so ground truth never drifts.

| ID | Category | Prompt (task text) | Inputs | Answer key | Measures |
| --- | --- | --- | --- | --- | --- |
| C1 | Code comprehension | "Given: `def f(xs):\n  t=0\n  for x in xs:\n    if x>0: t+=x\n  return t`. In one sentence, what does `f([])` return and why?" | tok 128 | Returns `0`; loop never runs so `t` stays 0. | Correctness, Compliance |
| C2 | Bug detection | "This function should return the index of `target` in `a`, or -1. Find the single bug and name the exact line: `def find(a,t):\n  for i in range(1,len(a)):\n    if a[i]==t: return i\n  return -1`" | tok 200 | `range(1,...)` skips index 0 — off-by-one; misses the first element. | Correctness, Grounding, Compliance |
| C3 | Diff review | "Review this diff for a behavior change. Diff:\n`- if user and user.active:\n+ if user or user.active:`\nWhat breaks?" | tok 200 | `or` now truthy when `user` is None → `user.active` may not even be evaluated but callers relying on 'active user only' now pass inactive/None users; logic inverted. | Correctness, Grounding, Compliance |
| C4 | Refactor / simplify | "Return a simpler equivalent of: `x = True if n%2==0 else False`. Output only the one-line replacement." | tok 64 | `x = n % 2 == 0` (or `x = (n%2)==0`). | Correctness, Compliance |
| C5 | Structured extraction | "From this text return ONLY valid JSON with keys name,age,city and no prose: 'Ada, 36, lives in London.'" | tok 128 | `{"name":"Ada","age":36,"city":"London"}` — must parse, no extra text. | Correctness, Compliance |
| C6 | Summarization | "Summarize in exactly two sentences, adding no facts: 'The service retries failed jobs up to three times with exponential backoff, then moves them to a dead-letter queue that an operator reviews daily.'" | tok 160 | Two sentences; mentions 3 retries + backoff and dead-letter/operator review; invents nothing. | Correctness, Grounding, Compliance |
| C7 | Instruction / scope | "List three benefits of code review. Exactly three bullets, each ≤ 8 words, no code, no preamble." | tok 128 | 3 bullets, each ≤8 words, no preamble/code. | Compliance (Correctness n/a) |
| C8 | Multi-file reasoning | "Module A: `from b import price\ndef total(q): return price()*q`. Module B: `def price(): return 10`. If B changes to `def price(cur): ...` (adds a required arg), what happens when `total(2)` runs, and where?" | tok 200 | `TypeError: price() missing 1 required arg` raised inside `total` at the `price()` call in A. | Correctness, Grounding, Compliance |
| C9 | Algorithm / logic | "Write a regex matching a US ZIP: 5 digits, optionally `-` plus 4 digits. Output only the regex." | tok 64 | `^\d{5}(-\d{4})?$` (equivalent accepted). | Correctness, Compliance |
| C10 | Grounding / anti-hallucination | "Using ONLY this API surface, how do I delete a record? API: `list()`, `get(id)`, `create(obj)`. If it's not possible, reply exactly 'not supported'." | tok 96 | Must answer `not supported` — no delete exists. Inventing `delete()` = Grounding 0. | Correctness, Grounding, Compliance |
| C11 | Long-context retrieval | "Read the provided file and answer only: what is the value of `MAGIC_TOKEN`?" | **paths:** `[<fixture path>]`, tok 96 | The planted token value in the fixture. Exercises context loading; confirm `context_manifest` is non-empty. | Correctness, Grounding |
| C12 | Test-case ideation | "Given `def div(a,b): return a/b`, list three input cases a test suite must cover. One line each, input then why." | tok 200 | Should include b=0 (ZeroDivisionError); plus e.g. negatives, non-integer/float, type mismatch. | Correctness, Compliance |
| C13 | Repo context plumbing | "In one sentence, what does this project's delegate tool refuse to do?" | **paths:** `["CLAUDE.md"]`, tok 128 | Never starts/stops/loads/unloads/swaps models; read-only advisory. Confirms `paths` loading + grounding on real repo text. | Correctness, Grounding |

> **Fixture for C11:** create `tests/fixtures/needle.txt` — a ~2–3k word block
> of filler with a single line `MAGIC_TOKEN = "<random>"` buried in the middle.
> Pin the value so the answer key is stable.

### Round 1 output

Fill one row per prompt, then roll up:

```
Prompt | Correctness | Grounding | Compliance | Norm | Latency s | Truncated | Notes
```

Category verdict = the prompt's band. Categories in **Avoid** are dropped;
everything **Okay+** proceeds to Round 2.

---

## Round 2 — graded ladders (depth, survivors only)

For each surviving category, run an Easy → Medium → Hard ladder (same scoring).
The category's **capability ceiling** is the hardest level that still scores
**Good (≥ 0.80)**. Stop a ladder early once a level lands in Avoid — harder
levels won't recover.

Ladders below are written for the categories most likely to survive; if a
different set survives, build its ladder on the same E/M/H shape (same task type,
rising input size / branching / subtlety).

| Cat | Easy | Medium | Hard |
| --- | --- | --- | --- |
| Comprehension | Explain a 5-line pure function's return. | Explain control flow of a 30-line function with two loops + early return. | Explain a 60-line function with recursion or a subtle state mutation; identify the invariant. |
| Bug detection | One obvious off-by-one (as C2). | One logic bug among 25 lines, no hint which line. | Two bugs in 40 lines where one masks the other; must find both. |
| Diff review | 1-line diff, local effect (as C3). | 3-hunk diff, one hunk has a subtle side effect. | Diff touching 2 functions where the break is an interaction between hunks, not either hunk alone. |
| Structured extraction | 3 flat keys (as C5). | Nested object + an array field, 1 value must be coerced to number. | 6 records → JSON array, one record has a missing field that must become `null`; must stay valid JSON. |
| Grounding | Missing single method (as C10). | Plausible-but-absent method next to real ones; must refuse. | Multi-step task where step 2 is impossible with the given API; must complete steps it can and flag the impossible one. |
| Multi-file reasoning | 2 files, direct call (as C8). | 3 files, one indirection (A→B→C). | 3 files with a shared mutable default / import-time side effect; trace the surprising result. |
| Algorithm / logic | ZIP regex (as C9). | Regex with an alternation + anchoring edge case; provide 2 must-match + 2 must-not-match. | Small state/counting problem (e.g. balanced-bracket check) — give the approach and the failing edge case. |

### Round 2 output

Per category: the E/M/H scores and the **ceiling** (Easy / Medium / Hard / None).
This is the granularity for the final verdict — e.g. "bug detection: reliable at
Easy–Medium, unreliable at Hard."

---

## Final deliverable — the verdict

Produce this table per model at the end of each run. This is the whole point of
the exercise.

```
Model: <fast: qwen3.6-35b | deep: ...>
Run date / request_ids: ...
Median latency: ... s

GOOD  (delegate freely):        <categories @ ceiling>
OKAY  (delegate + verify):      <categories @ ceiling>
AVOID (never delegate):         <categories>

One-line guidance for coordinators:
"<model> is safe for <good list>, acceptable with review for <okay list>,
 and must not be used for <avoid list>."
```

Keep the fast and deep verdicts side by side so the difference in what each is
"especially good at" is visible at a glance — that comparison is the reason both
runs exist.
