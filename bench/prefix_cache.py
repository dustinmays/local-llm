#!/usr/bin/env python3
"""Prefix-cache probe for a local OpenAI-compatible server on :1234.
Sends a long fixed prefix three ways and compares time-to-first-token:
  1 cold            -> full prefill
  2 identical repeat-> should hit the prefix cache
  3 same prefix, different question at the end -> partial hit (agent-style growth)
Usage: prefix_cache.py MODEL_ID OUT.json [PREFIX_TOKENS=32000]"""
import json, sys, time, urllib.request, uuid

URL = "http://127.0.0.1:1234/v1/chat/completions"

def call(model, prompt, max_tokens=256):
    req = urllib.request.Request(URL, json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
        "temperature": 0, "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True}}).encode(),
        {"Content-Type": "application/json"})
    t0 = time.perf_counter(); first = None; usage = {}
    with urllib.request.urlopen(req, timeout=3600) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:") or line.endswith("[DONE]"): continue
            d = json.loads(line[5:])
            if d.get("usage"): usage = d["usage"]
            for c in d.get("choices", []):
                dl = c.get("delta", {})
                if first is None and (dl.get("content") or dl.get("reasoning_content")): first = time.perf_counter()
    end = time.perf_counter()
    return {"prompt_tokens": usage.get("prompt_tokens"), "ttft_s": round(first - t0, 1) if first else None, "total_s": round(end - t0, 1)}

model, out = sys.argv[1], sys.argv[2]
target = int(sys.argv[3]) if len(sys.argv) > 3 else 32000
lines = int(target / 47.8)
prefix = "Long log follows.\n\n" + "\n".join(f"{i:06d} {uuid.uuid4().hex} {uuid.uuid4().hex[:12]}" for i in range(lines)) + "\n\n"
res = {}
res["1_cold"] = call(model, prefix + "Question: how many lines start with 000000? Reply with one number.")
res["2_identical_repeat"] = call(model, prefix + "Question: how many lines start with 000000? Reply with one number.")
res["3_same_prefix_new_question"] = call(model, prefix + "Question: what is the first character of the last line? Reply with one character.")
for k, v in res.items(): print(k, v, flush=True)
json.dump(res, open(out, "w"), indent=1)
