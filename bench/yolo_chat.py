#!/usr/bin/env python3
"""Quick chat bench vs a local OpenAI-compatible server on :1234 (oMLX or LM Studio).
Capability-matrix prompts (C1-C10, C12) + prefill/decode speed. Usage: yolo_chat.py MODEL_ID OUT.json"""
import json, sys, time, urllib.request, uuid

BASE = "http://127.0.0.1:1234/v1/chat/completions"
P = {
 "C1": "Given: `def f(xs):\n  t=0\n  for x in xs:\n    if x>0: t+=x\n  return t`. In one sentence, what does `f([])` return and why?",
 "C2": "This function should return the index of `target` in `a`, or -1. Find the single bug and name the exact line: `def find(a,t):\n  for i in range(1,len(a)):\n    if a[i]==t: return i\n  return -1`",
 "C3": "Review this diff for a behavior change. Diff:\n`- if user and user.active:\n+ if user or user.active:`\nWhat breaks? Answer in under 120 words.",
 "C4": "Return a simpler equivalent of: `x = True if n%2==0 else False`. Output only the one-line replacement.",
 "C5": "From this text return ONLY valid JSON with keys name,age,city and no prose: 'Ada, 36, lives in London.'",
 "C6": "Summarize in exactly two sentences, adding no facts: 'The service retries failed jobs up to three times with exponential backoff, then moves them to a dead-letter queue that an operator reviews daily.'",
 "C7": "List three benefits of code review. Exactly three bullets, each <= 8 words, no code, no preamble.",
 "C8": "Module A: `from b import price\ndef total(q): return price()*q`. Module B: `def price(): return 10`. If B changes to `def price(cur): ...` (adds a required arg), what happens when `total(2)` runs, and where?",
 "C9": "Write a regex matching a US ZIP: 5 digits, optionally `-` plus 4 digits. Output only the regex.",
 "C10": "Using ONLY this API surface, how do I delete a record? API: `list()`, `get(id)`, `create(obj)`. If it's not possible, reply exactly 'not supported'.",
 "C12": "Given `def div(a,b): return a/b`, list three input cases a test suite must cover. One line each, input then why.",
}

def call(model, prompt, max_tokens):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0,
            "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True}}
    req = urllib.request.Request(BASE, json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.perf_counter(); first = None; text = []; reasoning = []; usage = {}
    with urllib.request.urlopen(req, timeout=1800) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:") or line.endswith("[DONE]"): continue
            d = json.loads(line[5:])
            if d.get("usage"): usage = d["usage"]
            for c in d.get("choices", []):
                delta = c.get("delta", {})
                if delta.get("content"): text.append(delta["content"])
                if delta.get("reasoning_content"): reasoning.append(delta["reasoning_content"])
                if (delta.get("content") or delta.get("reasoning_content")) and first is None:
                    first = time.perf_counter()
    end = time.perf_counter()
    out_tok = usage.get("completion_tokens")
    return {"answer": "".join(text), "reasoning_chars": len("".join(reasoning)),
            "ttft_s": round(first - t0, 2) if first else None, "total_s": round(end - t0, 2),
            "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": out_tok,
            "decode_tok_s": round(out_tok / (end - first), 1) if first and out_tok and end > first else None}

model, out = sys.argv[1], sys.argv[2]
res = {"model": model, "quality": {}, "speed": {}}
call(model, "hi", 8)  # warm up
for k, p in P.items():
    res["quality"][k] = call(model, p, 2048); print(k, res["quality"][k]["total_s"], flush=True)
line = "def resolve_cluster_value(item): return item.value if item.ready else None\n"
for n in (2048, 8192):
    prompt = f"Review the following source. Reply with one concise observation.\nnonce {uuid.uuid4()}\n\n" + line * ((n * 4) // len(line))
    res["speed"][f"prefill_{n}"] = call(model, prompt, 64); print("speed", n, flush=True)
json.dump(res, open(out, "w"), indent=1)
