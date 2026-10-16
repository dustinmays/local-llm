#!/usr/bin/env python3
"""Context-ceiling ladder for a local OpenAI-compatible server (oMLX/LM Studio) on :1234.
Sends increasingly long prompts (random hex lines + one planted MAGIC_TOKEN) and records
time-to-first-token, decode speed and whether the needle was retrieved. Run bench/mem/memlog.sh
alongside to capture peak wired memory / swap / pressure.
Usage: ctx_ceiling.py MODEL_ID OUT.json [TOKENS ...]   (default ladder 16k..128k)"""
import json, sys, time, urllib.request, uuid, secrets

URL = "http://127.0.0.1:1234/v1/chat/completions"

def build(lines, needle):
    body = [f"{i:06d} {uuid.uuid4().hex} {uuid.uuid4().hex[:12]}" for i in range(lines)]
    body.insert(lines // 2, f"MAGIC_TOKEN = {needle}")
    return ("Below is a long log. Read it, then answer the question at the end.\n\n" + "\n".join(body) +
            "\n\nQuestion: what is the value of MAGIC_TOKEN? Reply with only the value.")

def call(model, prompt, max_tokens=1024):
    req = urllib.request.Request(URL, json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
        "temperature": 0, "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True}}).encode(),
        {"Content-Type": "application/json"})
    t0 = time.perf_counter(); first = None; out = []; usage = {}
    with urllib.request.urlopen(req, timeout=3600) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:") or line.endswith("[DONE]"): continue
            d = json.loads(line[5:])
            if d.get("usage"): usage = d["usage"]
            for c in d.get("choices", []):
                dl = c.get("delta", {})
                txt = (dl.get("content") or "") + (dl.get("reasoning_content") or "")
                if txt:
                    if first is None: first = time.perf_counter()
                    out.append(txt)
    end = time.perf_counter(); n = usage.get("completion_tokens")
    return {"text": "".join(out), "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": n,
            "ttft_s": round(first - t0, 1) if first else None, "total_s": round(end - t0, 1),
            "decode_tok_s": round(n / (end - first), 1) if first and n and end > first else None}

model, out_path = sys.argv[1], sys.argv[2]
ladder = [int(x) for x in sys.argv[3:]] or [16000, 32000, 48000, 64000, 96000, 128000]
probe = call(model, build(300, "probe"), 8)
tpl = probe["prompt_tokens"] / 300  # tokens per line
print(f"calibration: {tpl:.1f} tokens/line", flush=True)
results = []
for target in ladder:
    needle = "zx-" + secrets.token_hex(4)
    lines = int(target / tpl)
    row = {"target_tokens": target, "needle": needle}
    try:
        row.update(call(model, build(lines, needle)))
        row["needle_found"] = needle in row.pop("text")
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {e}"[:300]
    results.append(row); print(json.dumps(row), flush=True)
    json.dump(results, open(out_path, "w"), indent=1)
    if "error" in row: break
