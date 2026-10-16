#!/bin/bash
# Usage: [PROVIDER=omlx] [ONLY="t1 t2"] run.sh MODEL_ID LABEL [REPS] [TIMEOUT_S]  -> results-LABEL.tsv + runs/LABEL/
S="$(cd "$(dirname "$0")" && pwd)"; source "$S/tasks.sh"
MODEL="$1"; LABEL="$2"; REPS="${3:-2}"; TMO="${4:-600}"
OUT="$S/results-$LABEL.tsv"; : > "$OUT"; printf 'model\ttask\trep\tpass\ttool_calls\ttool_errors\twall_s\texit\n' >> "$OUT"
for t in $TASKS; do for r in $(seq 1 $REPS); do
  D=$(mktemp -d); setup_$t "$D"; t0=$(date +%s)
  (cd "$D" && OPENCODE_CONFIG="$S/oc-omlx.json" perl -e 'alarm shift; exec @ARGV' "$TMO" opencode run --standalone --auto --format json -m "${PROVIDER:-omlx}/$MODEL" "$(prompt_$t)" > "$D/ev.jsonl" 2> "$D/err.txt"); rc=$?
  wall=$(( $(date +%s) - t0 ))
  check_$t "$D" && pass=1 || pass=0
  calls=$(grep -c '"type":"tool' "$D/ev.jsonl"); errs=$(grep -c '"status":"error"\|"type":"error"' "$D/ev.jsonl")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$MODEL" "$t" "$r" "$pass" "$calls" "$errs" "$wall" "$rc" >> "$OUT"
  mkdir -p "$S/runs/$LABEL"; cp -R "$D" "$S/runs/$LABEL/${t}_$r"; echo "$t rep$r pass=$pass calls=$calls ${wall}s"
done; done
