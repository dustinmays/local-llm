#!/usr/bin/env python3

import json
import sys
import time
import urllib.request
import uuid


def main() -> None:
    host, port, model, target_tokens = sys.argv[1:]
    target_tokens = int(target_tokens)
    source_line = "def resolve_cluster_value(item): return item.value if item.ready else None\n"
    prompt = (
        "Review the following representative source context. Reply with one concise observation.\n"
        f"Benchmark nonce: {uuid.uuid4()}\n\n"
    )
    prompt += source_line * max(1, (target_tokens * 4) // len(source_line))

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 64,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    request = urllib.request.Request(
        f"http://{host}:{port}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )

    started = time.perf_counter()
    first_token = None
    usage = {}
    text = []
    with urllib.request.urlopen(request, timeout=1800) as response:
        for raw_line in response:
            line = raw_line.decode().strip()
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            chunk = json.loads(data)
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices", []):
                delta = choice.get("delta", {})
                piece = delta.get("content") or delta.get("reasoning_content") or ""
                if piece:
                    if first_token is None:
                        first_token = time.perf_counter()
                    text.append(piece)
    finished = time.perf_counter()

    if first_token is None:
        raise RuntimeError("stream completed without generated text")
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    ttft = first_token - started
    total = finished - started
    decode_time = max(finished - first_token, 0.001)

    print(f"model:              {model}")
    print(f"prompt tokens:      {prompt_tokens or 'unreported'}")
    print(f"completion tokens:  {completion_tokens or 'unreported'}")
    print(f"time to first text: {ttft:.2f} s")
    print(f"total request time: {total:.2f} s")
    if prompt_tokens:
        print(f"effective prefill:  {prompt_tokens / ttft:.2f} tok/s")
    if completion_tokens:
        print(f"decode after first: {completion_tokens / decode_time:.2f} tok/s")
    print(f"response preview:   {''.join(text).strip()[:160]}")


if __name__ == "__main__":
    main()
