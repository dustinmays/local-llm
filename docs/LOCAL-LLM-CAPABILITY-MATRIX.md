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

**Output truncation is not signalled by the `truncated` field** — that field
reports only input/context-manifest truncation. A response cut off by
`max_output_tokens` still returns `truncated: false`, so detect it by inspection
(answer ends mid-sentence). When output is cut off, re-run once with a higher
`max_output_tokens` (add an explicit length hint to the task, e.g. "under 120
words") before scoring; only cap Compliance at 1 if it still overruns.

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

### Round 1 results — FAST (`qwen3.6-35b`), 2026-08-17

Clean sweep: every category scored **Good (1.00)**. Nothing culled; all 13
advance to Round 2. Latency range 0.6–4.8 s. C3 required a re-run with a length
hint (original overran the 200-token output cap — see truncation note above).

| ID | Category | C | G | Comp | Norm | Latency s | Band | request_id |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Comprehension | 3 | – | 3 | 1.00 | 1.4 | Good | e9fcdb0b |
| C2 | Bug detection | 3 | 3 | 3 | 1.00 | 3.5 | Good | 8b0daf64 |
| C3 | Diff review | 3 | 3 | 3 | 1.00 | 3.4 | Good | ac220b3a (re-run) |
| C4 | Refactor/simplify | 3 | – | 3 | 1.00 | 0.7 | Good | 0f819b03 |
| C5 | Structured extraction | 3 | – | 3 | 1.00 | 0.9 | Good | 41c876b5 |
| C6 | Summarization | 3 | 3 | 3 | 1.00 | 1.4 | Good | e6cea9bf |
| C7 | Instruction/scope | – | – | 3 | 1.00 | 1.2 | Good | be139fef |
| C8 | Multi-file reasoning | 3 | 3 | 3 | 1.00 | 4.8 | Good | faa92414 |
| C9 | Algorithm/logic | 3 | – | 3 | 1.00 | 0.8 | Good | 33694c94 |
| C10 | Grounding/anti-halluc. | 3 | 3 | 3 | 1.00 | 0.6 | Good | 67f0fcfd |
| C11 | Long-context retrieval | 3 | 3 | – | 1.00 | 2.2 | Good | 717a6cc9 |
| C12 | Test-case ideation | 3 | – | 3 | 1.00 | 2.0 | Good | 55a0a86a |
| C13 | Repo context plumbing | 3 | 3 | – | 1.00 | 1.2 | Good | ff0f0c85 |

Takeaway: the Easy-tier cull does not discriminate this model — differentiation
must come from Round 2's harder ladders.

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

### Round 2 results — FAST (`qwen3.6-35b`), 2026-08-17

Run Hard-first (Round 1 already established Easy = Good everywhere), stepping
down only when Hard failed.

| Ladder | Hard result | Ceiling | Evidence |
| --- | --- | --- | --- |
| Comprehension | Good (1.00) — pre-order DFS + depth invariant | **Hard** | ea2b492d |
| Structured extraction | Good (1.00) — 6→JSON array, `null` for missing | **Hard** | 0bd3bb50 |
| Grounding / anti-halluc. | Good (1.00) — flagged impossible step, no invented method | **Hard** | e0cd01d4 |
| Multi-file reasoning | Good (0.89) — mutable-default persistence, answer `[3]` | **Hard** | a96466a3 |
| Algorithm / logic | Good (1.00) — stack + valid `")("` counterexample | **Hard** | 999afa74 |
| Diff review | Okay (0.78) — got emergent bug + trigger, but a factual slip and missed that `load()` became dead code; Medium = Good | **Medium** | 5a2d8324 (H), c20b21f8 (M) |
| Bug detection | Fail — missed the load-bearing even-branch index bug even when pointed at it; Medium = Good | **Medium** | 26af18c7 (H), 9d1cfdcb (M) |

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

### Verdict — FAST (`qwen3.6-35b`), 2026-08-17

Run: Round 1 (13/13 Good) + Round 2 Hard-first ladders. Latency 0.6–9.0 s;
median ~2 s. All runs confirmed `actual_quality: "fast"` on the `controller`
backend.

```
GOOD  (delegate freely, reliable through Hard):
  - Code comprehension (incl. recursion + invariants)
  - Structured extraction / JSON (nested, null-for-missing, format-exact)
  - Grounding / anti-hallucination (refuses absent APIs, flags impossible steps)
  - Multi-file reasoning (cross-module, mutable-default/global side effects)
  - Algorithm & logic (regex, stack reasoning, counterexamples)
  - Summarization, instruction/scope-following, long-context retrieval,
    test-case ideation (Round 1 Good; not laddered — treat as Good ≤ Medium)

OKAY  (delegate + verify):
  - Diff review — reliable for local/single-hunk effects; on multi-hunk
    INTERACTION bugs it finds the symptom but slips on details and misses
    dead-code consequences. Verify its diff conclusions.

AVOID (do not rely on):
  - Deep bug-hunting — finding a subtle, load-bearing bug (esp. when a second
    issue masks it, or the real bug sits behind surface nits like style/side
    effects). It misses the actual defect even when pointed at the line. Use it
    to *triage*, never as the sole reviewer of correctness-critical code.

One-line guidance for coordinators:
"qwen3.6-35b (fast) is safe for comprehension, extraction, grounded Q&A,
 multi-file reasoning, and algorithmic explanation; acceptable-with-review for
 diff review; and must not be the sole authority on subtle bug detection."
```

Operational notes discovered during the run:
- Give an explicit length hint ("under N words") on any prompt whose answer
  could run long — the `fast` model narrates, and the response `truncated` field
  does **not** flag output cut off by `max_output_tokens`.
- Token/latency were cheap for these bounded tasks; the token-budget guard
  (`INPUT_LIMIT_EXCEEDED`) never triggered at these sizes.

### Verdict — DEEP (TBD)

Pending: cluster/`deep` backend is offline. Run the identical matrix once it is
up (`quality: "deep"`, verify `actual_quality`), then fill this in beside FAST.
The interesting comparison is whether DEEP clears the two ceilings FAST hit:
**deep bug detection** and **multi-hunk-interaction diff review**.

---

# Round 3 — depth & variation stress (Good categories only)

Rounds 1–2 rated five categories **Good** off a single Hard sample each. One
sample can't tell "reliable" from "lucky," and it can't find *which* edge case
breaks an otherwise-strong capability. Round 3 fixes that: **6 samples per
category**, each a deliberate variation that attacks a different failure mode
with a **trap** (misdirection / subtlety), because Round 2 showed this model
breaks on subtlety, not size. Difficulty runs Medium → Hard → Extra-hard (XH);
Easy is omitted (Round 1 proved it non-discriminating).

Scope = the five laddered-Good categories (A–E). The four Good-but-only-Round‑1
categories get a lighter confirm ladder (F–I, 2 samples each). Same models, same
sequential single-thread protocol, same 0–3 scoring rubric and bands as above.

## What Round 3 produces (the point)

Per category, an aggregate over its samples:

| Reliability tier | Rule | Meaning for the verdict |
| --- | --- | --- |
| **Rock-solid** | Good on ≥ 5/6 (≥ 83%) | Keep in "delegate freely" |
| **Reliable** | Good on 3–4/6 | Keep, but note the failing variations |
| **Fragile** | Good on ≤ 2/6 | Demote out of "Good" — it only looked good on the easy sample |

**The failing samples are the deliverable, not just the rate.** Record which
variation(s) broke and add each as a named "avoid" edge case under that category
(e.g. "extraction: reliable, EXCEPT it coerces leading-zero IDs to numbers").

## Run protocol (Round 3 specifics)

Identical invocation to earlier rounds. Additions from lessons learned:
- **Always include the length hint already written into each prompt** — output
  truncation is invisible in the `truncated` field.
- Suggested `max_output_tokens`: comprehension one-liners **96**; JSON **400**;
  grounding **220**; multi-file **200**; algorithm **200**; F–I **300**.
- All prompts are self-contained (code/data inline) — no fixtures, no repo
  paths, so answer keys never drift. (`paths`/`include_diff` plumbing was already
  proven in Round 1 C11/C13; Round 3 isolates reasoning.)
- Grounding-critical prompts (C-series, plus A/D "predict exact output"): any
  fabricated value/API/line = **Grounding 0 = hard Avoid** for that sample.

---

## A — Code comprehension (predict the EXACT result)

Prompt template: *"State exactly what this evaluates to / returns. Answer with
only the value, one line."* Trap = a subtle language semantic.

| ID | Diff | Variation / trap | Program | Answer key |
| --- | --- | --- | --- | --- |
| A1 | M | right-assoc `**` | `2 ** 3 ** 2` | `512` |
| A2 | H | closure late-binding | `fns=[lambda:i for i in range(3)]; [f() for f in fns]` | `[2, 2, 2]` |
| A3 | H | `finally` overrides return | `def f():\n try: return 1\n finally: return 2` → `f()` | `2` |
| A4 | XH | mutable default persists | `def g(x,acc=[]): acc.append(x); return acc` → call `g(1)` then `g(2)` | `[1, 2]` |
| A5 | H | generator exhaustion | `g=(x for x in [1,2,3]); sum(g), sum(g)` | `(6, 0)` |
| A6 | XH | floor-div / mod signs | `-7 // 2, -7 % 2` | `(-4, 1)` |

## B — Structured extraction / JSON (output ONLY valid JSON)

Trap = coercion & escaping decisions. Score: must `json.loads` clean, exact
values, zero prose.

| ID | Diff | Variation / trap | Task | Answer key |
| --- | --- | --- | --- | --- |
| B1 | M | word→number coercion | `{order_id,customer,total}` from "Order 88, customer Ada, total twelve dollars fifty"; total numeric | `{"order_id":88,"customer":"Ada","total":12.5}` |
| B2 | H | escaping quotes+newline | `{title,note}` from title=`He said "hi"`, note=`line one`⏎`line two` | `{"title":"He said \"hi\"","note":"line one\nline two"}` |
| B3 | H | do-NOT-coerce IDs | `{id,zip}` from "id 007, zip 01234" | `{"id":"007","zip":"01234"}` (both strings) |
| B4 | XH | honor a correction | `{name,age}` from "Ada is 30. Correction: Ada is 31." | `{"name":"Ada","age":31}` |
| B5 | M | empty → `[]` | "JSON array of any prices in: 'no prices here'" | `[]` |
| B6 | XH | unicode + negative float | `{city,temp_c}` from "München is at -3.5°C" | `{"city":"München","temp_c":-3.5}` |

## C — Grounding / anti-hallucination

Trap = pressure to invent. Fabricating any value/method = Grounding 0.

| ID | Diff | Variation / trap | Task | Answer key |
| --- | --- | --- | --- | --- |
| C1 | M | absent-but-derivable | API `read(k)`,`write(k,v)`,`keys()`. "Check if key exists." | No `exists`; use `k in keys()`. Must not invent `has/exists`. |
| C2 | H | extrapolate past data | "Sales 2021=10, 2022=12, 2023=15. What were 2025 sales?" | Not in data / unknown. A bare number = Grounding 0. |
| C3 | H | contradictory sources | "Doc A: timeout 30s. Doc B: timeout 60s. What is the timeout?" | Must flag the conflict, not silently pick one. |
| C4 | XH | partially answerable | "Fields available: `user.name`, `user.email`. Output the user's phone and name." | name = available; phone = NOT available. Must flag phone. |
| C5 | M | distractor synonym | API `sortAsc(list)` only. "Sort this list descending." | No descending method; `sortAsc` then reverse. Don't invent `sortDesc`. |
| C6 | XH | false-premise field | "In config `{timeout:30, workers:4}`, what does `retry_backoff` control?" | No such field present. Describing it = Grounding 0. |

## D — Multi-file reasoning (predict exact behavior across modules)

Trap = import-binding & shared-state semantics. Prompt: *"What is printed /
returned? One line, then one sentence why."*

| ID | Diff | Variation / trap | Setup | Answer key |
| --- | --- | --- | --- | --- |
| D1 | H | `from a import f` snapshots name | `b: from a import greet`; main sets `a.greet=lambda:"yo"`; `b.run()` calls `greet()` | `"hi"` — b's name bound at import, unaffected by patch |
| D2 | H | `import a; a.f()` sees patch | same but `b.run()` calls `a.greet()` | `"yo"` — attribute looked up at call time |
| D3 | H | shared module global | `counter.py: count=0; inc()` global++; x and y both `from counter import inc`; `x.inc()` then `y.inc()` | `2` — one shared module object |
| D4 | XH | circular import, partial init | `a: import b; X=1` · `b: import a; Y=a.X`; main imports `a` | `AttributeError` — `a` partially initialized (X unset) when b runs |
| D5 | H | rebinding is namespace-local | `consts.MAX=100`; `a: from consts import MAX; MAX=200`; `b: from consts import MAX; print(MAX)` | `100` — a rebound its own name, not `consts.MAX` |
| D6 | XH | shared mutable class attr | `m.py: class Box: contents=[]`; a does `Box.contents.append(1)`; b prints `Box.contents` | `[1]` — class attribute shared across importers |

## E — Algorithm & logic

Trap = a precise rule (greedy/lazy, stability, sign, complexity).

| ID | Diff | Variation / trap | Task | Answer key |
| --- | --- | --- | --- | --- |
| E1 | M | Big-O of nested loop | tight time of `for i in range(n): for j in range(i): work()` | `O(n^2)` |
| E2 | H | greedy vs lazy regex | On `<a><b>`: what does `<.*>` match, and `<.*?>`? | `<a><b>` and `<a>` |
| E3 | H | boolean / De Morgan | simplify `not (a and not b)` | `not a or b` |
| E4 | XH | stable-sort order | stable sort of `[(1,'a'),(2,'b'),(1,'c')]` by first elem | `[(1,'a'),(1,'c'),(2,'b')]` |
| E5 | M | Python mod sign | value of `-1 % 5` | `4` |
| E6 | XH | claim + counterexample | "True for all lists: `sorted(a+b)==sorted(a)+sorted(b)`? If false, give a counterexample." | False; e.g. `a=[2],b=[1]` → `[1,2]` vs `[2,1]` |

## F–I — confirm ladders (Good-but-Round-1-only, 2 samples each)

| ID | Category | Diff | Prompt | Answer key |
| --- | --- | --- | --- | --- |
| F1 | Summarization | H | "Summarize in 2 sentences, adding no facts and OMITTING any opinion: 'The API is fast (I love it) and rate-limited to 100 req/min.'" | 2 sentences; keeps fast + 100 req/min limit; drops "I love it". |
| F2 | Summarization | XH | "Compress to EXACTLY 7 words, meaning preserved: 'The nightly job backs up the database and emails a report.'" | Exactly 7 words, meaning intact (word-count is objective). |
| G1 | Instruction / scope | H | "Name three fruits. Do NOT mention apples or bananas. Comma-separated, one line." | 3 fruits, neither apple nor banana, single line. |
| G2 | Instruction / scope | XH | "Return JSON `{a,b,c}` with values 1,2,3 but keys in REVERSE alpha order (c,b,a). Only JSON." | Valid JSON, key order c,b,a, values 3? — keys map to given values: `{"c":3,"b":2,"a":1}`? See note. |
| H1 | Long-context retrieval | H | inline ~1.5k-word block containing both `TOKEN_A="red-42"` and `TOKEN_B="red-43"`; ask only for `TOKEN_B`. | `red-43` — must not confuse the near-duplicate. |
| H2 | Long-context retrieval | XH | same block; "what is TOKEN_A, and is it larger or smaller than TOKEN_B's number?" | `red-42`; smaller (42 < 43) — retrieval + tiny synthesis. |
| I1 | Test-case ideation | H | "For `def clamp(x,lo,hi): return max(lo,min(x,hi))`, give the minimal set of inputs covering: below range, in range, above range, and lo>hi misuse." | 4 cases incl. lo>hi degenerate case. |
| I2 | Test-case ideation | XH | "This `is_leap(y)` returns `y%4==0`. Give the ONE input that exposes the bug and the correct expected output." | `1900` (or `2100`) → expected `False` (century non-leap). |

> **G2 note:** the objective check is (a) valid JSON, (b) key order `c,b,a`,
> (c) each key maps to its stated value `a→1,b→2,c→3`. Pin whichever value
> mapping you intend before running so the key is unambiguous; the wording above
> assigns 1,2,3 to a,b,c respectively.

> **H1/H2 fixture-free:** paste a ~1.5k-word filler block inline in the `task`
> (well under the 20k char limit) with the two tokens buried far apart. Reuse the
> style of `tests/fixtures/needle.txt`. Pin the block once so both prompts share it.

## Round 3 results template

One row per sample; roll up per category to a tier and an edge-case list.

```
Sample | Diff | C | G | Comp | Norm | Band | Latency s | request_id | Note (esp. if failed)
```

```
Category | Good count | Tier (Rock-solid / Reliable / Fragile) | Failing variations → avoid
A  Comprehension     | _/6 | ... | ...
B  Extraction        | _/6 | ... | ...
C  Grounding         | _/6 | ... | ...
D  Multi-file        | _/6 | ... | ...
E  Algorithm         | _/6 | ... | ...
F  Summarization     | _/2 | ... | ...
G  Instruction/scope | _/2 | ... | ...
H  Long-context      | _/2 | ... | ...
I  Test ideation     | _/2 | ... | ...
```

Feed the result back into the FAST verdict above: promote **Rock-solid**
categories, annotate **Reliable** ones with their failing edge cases, and
**demote any Fragile** category out of "delegate freely." Then run the identical
Round 3 against DEEP and compare tiers side by side.
