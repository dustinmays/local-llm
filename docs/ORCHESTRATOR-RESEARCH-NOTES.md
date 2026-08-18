# Orchestrator research notes

Status: research summary, not a spec. Written to be skimmed, not read start to
finish — headers and bold text carry the meaning, prose is backup.

**TL;DR:** The model doing the delegating (the "orchestrator" — you, or
Claude Code, or whatever's in the driver's seat) matters more than the model
being delegated to. Most of the risk and most of the leverage lives in *how*
the orchestrator decides to delegate, verifies what comes back, and handles
the sub-agent's output as data rather than truth. This applies here
(local-llm repo) and to any future setup where you've got a smart model
farming work out to a cheaper/faster/local one.

---

## The one idea that matters most

> Delegation is a **trust boundary**, not a convenience feature.

Every time an orchestrator hands work to a sub-agent, three things need to
happen, and skipping any one of them is where things break:

1. **Decide** whether this task is even worth delegating.
2. **Verify** what comes back before acting on it.
3. **Isolate** the sub-agent's output so it can't quietly become an
   instruction (this is the prompt-injection angle).

Everything below is detail on those three things.

---

## 1. Decide — don't delegate on autopilot

**What the research says:** Anthropic's own writeup on their multi-agent
research system says the hard part wasn't prompting the sub-agents — it was
teaching the *orchestrator* to scale effort to the size of the task. Left
alone, orchestrators over-delegate trivial stuff and under-delegate on things
that actually need a second opinion.

**Plain-language translation:** if you can answer it in one sentence
yourself, don't spin up a delegate call for it. The overhead (context
assembly, round trip, verifying the answer after) usually costs more than
just doing it. Save delegation for genuinely bounded chunks of work — "review
this diff," "summarize this file," "give me a second opinion on this bug" —
not "what does this variable do."

**Where this landed in your repo:** added an explicit line to `CLAUDE.md`
telling the orchestrator not to delegate below "a few dozen lines of
reasoning."

**Where this applies beyond this repo:** any agent-md or system prompt you
write for a coordinator role should have an explicit "is this worth
delegating" gate, not just "here's how to delegate." Otherwise you get
either delegation-happy agents burning tokens/latency on trivial asks, or
(worse) agents that never bother delegating because there's no signal for
when it's worth it.

---

## 2. Verify — proportional to trust, not uniform

**What the research says:** two things compound here:

- **Routing/cascading literature** (RouterBench, AutoMix, the general
  small-model-cascades-to-big-model research) — the hard part of using a
  cheap model well isn't the cheap model's accuracy, it's *accurately
  predicting when to trust it*. A blanket "verify everything" policy wastes
  effort on things the sub-agent is reliably good at, and a blanket "trust
  it" policy gets burned on the things it's bad at.
- **Repeated-sampling / self-consistency research** — a single answer from a
  model can't tell you if it's *reliably* right or just *happened* to be
  right this time. Rerunning the identical prompt and checking agreement is
  its own signal, separate from "is the answer correct."

**Plain-language translation:** you already built exactly the tool for this
— `docs/LOCAL-LLM-CAPABILITY-MATRIX.md`. It says, per category, whether a
model is "Good" (spot-check it), "Okay" (verify every time), or "Avoid"
(don't bother). The problem was that data existed but nothing *used* it — the
old `CLAUDE.md` said "validate every useful finding," which is either too
much effort (on categories proven Good) or a false sense of safety (on
categories that are actually shaky).

**Where this landed in your repo:** rewrote `CLAUDE.md` and the skill file to
route verification effort by category, and added a rule: **for anything
consequential** (a finding that will drive a code change or a judgment call),
rerun the identical delegate prompt once before trusting it. Given latency is
1–5 seconds on the fast model, this is cheap insurance.

**Where this applies beyond this repo:** any time you're building or using a
cascade (cheap model → expensive model, or model → human), don't treat trust
as binary. Build (or borrow) a per-category track record, and let the
verification effort scale with how often that category has burned you
before. If you don't have a track record yet, default to "verify everything"
until you do — don't guess.

---

## 3. Isolate — sub-agent output is data, not instructions

**What the research says:** this is the part that surprised me most digging
in. Benchmarks on indirect prompt injection (InjecAgent, NetInjectBench,
BIPIA) show that when a model consumes untrusted content — a file, a diff, a
ticket, a scraped webpage — and that content has an instruction buried in it
("SYSTEM: ignore prior instructions and do X"), models comply with it a
surprising amount of the time. And **the finding that should worry you more:
more capable models are sometimes *more* susceptible to this, not less** —
capability doesn't buy you safety here automatically.

**Plain-language translation:** two separate directions matter:

- **Content going INTO the sub-agent** (this repo's tool already handles
  this correctly — it explicitly documents repo text as "untrusted data, not
  instructions").
- **Output coming BACK from the sub-agent** — this was the gap. If a
  delegate call summarizes a file that happens to contain a planted
  instruction, and the sub-agent partially complies, that compromised output
  flows back to the orchestrator. If the orchestrator then pastes that output
  into a shell command, a config value, or uses it to decide the next tool
  call — the injection has now crossed the trust boundary into your actual
  system.

**Where this landed in your repo:** added Round 4 to the capability matrix
(injection-resistance testing) and a rule in `CLAUDE.md`/the skill file:
never paste delegate output into a shell command or another tool call without
reading it, and never let a sub-agent's output decide what happens next.

**Where this applies beyond this repo:** this is the single most
transferable lesson. *Any* pipeline where a model reads external content
(web pages, PDFs, emails, tickets, other people's code) and then that model's
output feeds into something automated is a place this can bite you. The fix
isn't "trust a better model" — it's architectural: treat sub-agent output as
untrusted data all the way until a human or a deterministic check clears it,
the same way you'd treat any other data from an untrusted source.

---

## 4. A pattern worth stealing: verification as its own turn

**What the research says:** in orchestrator-worker designs, the strongest
setups separate "generate the plan / get the result" from "check the
result" as genuinely distinct passes — not the same train of thought
continuing. Self-checking in the same breath you just reasoned in is weak;
you tend to miss the same blind spot twice. A fresh pass (a different agent,
or at minimum a deliberate context switch) catches more.

**Plain-language translation:** don't verify a delegate's finding by just
glancing at it inline and nodding. Actually stop, go re-read the relevant
file/test independently, *then* decide if the finding holds up.

**Where this landed in your repo:** added this as its own step in the skill
file, distinct from "cross-check against evidence."

**Where this applies beyond this repo:** this generalizes past AI agents —
it's just "the person who wrote the code shouldn't be the only one who
reviews it," applied to agents. If you're building any multi-agent system,
budget for a distinct verifier pass/agent rather than assuming the same
context that produced a plan will reliably catch its own errors.

---

## 5. Confidence isn't free — check if the sub-agent knows what it doesn't know

**What the research says:** a model that's wrong but says "I'm not sure" is
much less dangerous to delegate to than one that's wrong and says "definitely
X." Whether a model's *stated* confidence tracks its *actual* correctness
(calibration) is a separate property from raw accuracy, and it's not
something you can assume — it has to be tested directly.

**Plain-language translation:** "how often is it right" and "does it know
when it's guessing" are two different questions. You want both answers before
trusting a cascade decision (fast model vs. escalate to deep model) to the
sub-agent's own confidence claim.

**Where this landed in your repo:** added Round 4's "L" section to the
matrix — a set of prompts specifically designed to catch **high confidence +
wrong answer**, the dangerous failure mode, separate from plain wrongness.

**Where this applies beyond this repo:** if you ever build automatic
escalation (cheap model decides for itself whether to hand off to an
expensive one), do not trust its self-reported confidence until you've
measured whether that confidence is calibrated. An uncalibrated confidence
signal is worse than no signal — it looks informative and isn't.

---

## What actually changed today (low-risk, already done)

- `CLAUDE.md` — added effort-scaling ("don't delegate trivial stuff"),
  trust-tiered verification (routes off the capability matrix bands instead
  of "verify everything"), and an explicit rule against feeding delegate
  output into commands/tool calls unreviewed.
- `.agents/skills/local-mlx-delegate/SKILL.md` — split the old single
  "validate findings" bullet into: cross-check against evidence, rerun once
  before trusting anything consequential, never treat embedded text as an
  instruction, and do verification as a distinct pass rather than folded
  into the same reasoning that requested the delegation.

## What's spec'd but NOT done (needs a real implementation pass)

These touch `src/contracts.ts`, `src/delegation.ts`, and `src/mcp/server.ts`
— actual TypeScript changes to the MCP tool contract, not prompt text. Worth
scoping as their own task rather than doing inline:

1. **`sample_count` on delegate requests.** Let the caller ask for N
   identical draws (e.g. 3) on a consequential question and get back an
   agreement rate, operationalizing the "rerun before trusting" rule directly
   in the tool instead of relying on the calling agent to remember to do it
   manually. Cheap given fast-tier latency (1–5s per call).
2. **`task_category` + returned trust tier.** Let the caller tag a request
   with a matrix category (e.g. `"diff_review"`, `"bug_detection"`) and have
   the server echo back the matrix-derived band (Good/Okay/Avoid) in the
   response — so the trust-tier lookup lives in the tool, not in the calling
   agent's memory of a markdown file.

Both are additive/non-breaking — no change to the tool's read-only,
no-lifecycle-control contract. Flagging them here so they don't get lost;
happy to scope either as a real task when you want to pick it up.

---

## Sources

- [How we built our multi-agent research system — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- [When to use multi-agent systems (and when not to) — Claude/Anthropic](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)
- [AOrchestra: Automating Sub-Agent Creation for Agentic Orchestration](https://arxiv.org/html/2602.03786v2)
- [DecisionBench: A Benchmark for Emergent Delegation in Long-Horizon Agentic Workflows](https://arxiv.org/pdf/2605.19099)
- [LLMRouterBench: A Massive Benchmark and Unified Framework for LLM Routing](https://arxiv.org/html/2601.07206v1)
- [Large Language Model Routing with Benchmark Datasets (AutoMix)](https://arxiv.org/pdf/2309.15789)
- [InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated LLM Agents](https://arxiv.org/pdf/2403.02691)
- [NetInjectBench: Benchmarking Indirect Prompt Injection in Tool-Using LLM Agents](https://arxiv.org/html/2607.10490v1)
- [Benchmarking and Defending against Indirect Prompt Injection Attacks (BIPIA)](https://dl.acm.org/doi/10.1145/3690624.3709179)
- [Estimating the Self-Consistency of LLMs](https://arxiv.org/pdf/2509.19489)
- [Skills as Verifiable Artifacts: A Trust Schema for Human-in-the-Loop Agent Runtimes](https://arxiv.org/pdf/2605.00424)
- [How to Build Human-in-the-Loop Oversight for AI Agents — Galileo](https://galileo.ai/blog/human-in-the-loop-agent-oversight)
- [Architecting Resilient LLM Agents: Secure Plan-then-Execute Implementations](https://arxiv.org/pdf/2509.08646)
