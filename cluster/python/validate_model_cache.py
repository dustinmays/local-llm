#!/usr/bin/env python3

import json
import sys
from pathlib import Path

from huggingface_hub import snapshot_download


def main() -> None:
    model = sys.argv[1]
    snapshot = Path(snapshot_download(model, local_files_only=True))

    index_file = snapshot / "model.safetensors.index.json"
    if index_file.exists():
        with index_file.open() as handle:
            index = json.load(handle)
        weight_files = {snapshot / name for name in index["weight_map"].values()}
    else:
        weight_files = set(snapshot.glob("*.safetensors"))

    if not weight_files:
        raise RuntimeError(f"no model weights found in {snapshot}")
    missing = sorted(str(path) for path in weight_files if not path.exists())
    if missing:
        raise RuntimeError("missing cached weights:\n" + "\n".join(missing))

    print(snapshot)


if __name__ == "__main__":
    main()
