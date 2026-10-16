#!/usr/bin/env python3
"""Two long cold requests at once against a local OpenAI-compatible server on :1234.
Shows whether concurrent long prefills stay inside the memory budget (pair with bench/mem/memlog.sh).
Usage: concurrent_long.py MODEL_ID OUT.json [TOKENS_EACH=48000] [N=2]"""
import json, sys, time, urllib.request, uuid, threading

URL = "http://127.0.0.1:1234/v1/chat/completions"

def call(model, prompt, max_tokens=128):
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
each = int(sys.argv[3]) if len(sys.argv) > 3 else 48000
n = int(sys.argv[4]) if len(sys.argv) > 4 else 2
res = [None] * n
def worker(i):
    body = "\n".join(f"{j:06d} {uuid.uuid4().hex} {uuid.uuid4().hex[:12]}" for j in range(int(each / 47.8)))
    try: res[i] = call(model, f"Log {i}:\n{body}\n\nQuestion: reply with the single word done.")
    except Exception as e: res[i] = {"error": f"{type(e).__name__}: {e}"[:300]}
t0 = time.perf_counter()
ts = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
[t.start() for t in ts]; [t.join() for t in ts]
out_d = {"n": n, "tokens_each": each, "wall_s": round(time.perf_counter() - t0, 1), "requests": res}
print(json.dumps(out_d), flush=True); json.dump(out_d, open(out, "w"), indent=1)
