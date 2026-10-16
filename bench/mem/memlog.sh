#!/bin/bash
# usage: memlog.sh out.csv [interval_s]
out=${1:-mem.csv}; iv=${2:-1}
echo "ts,wired_mb,active_mb,compressed_mb,free_mb,swap_used_mb,free_pct,pressure,lms_rss_mb,pageouts" > "$out"
ps_=$(sysctl -n hw.pagesize)
while true; do
  v=$(vm_stat)
  g(){ echo "$v" | awk -v k="$1" -v p=$ps_ '$0 ~ k {gsub(/\./,"",$NF); printf "%d", $NF*p/1048576}'; }
  po=$(echo "$v" | awk '/Pageouts/{gsub(/\./,"",$NF);print $NF}')
  sw=$(sysctl -n vm.swapusage | awk '{gsub(/M/,"",$6); print int($6)}')
  mp=$(memory_pressure | awk '/free percentage/{gsub(/%/,"",$NF);print $NF}')
  lvl=$(sysctl -n kern.memorystatus_vm_pressure_level)   # 1 normal,2 warn,4 critical
  rss=$(ps -axo rss,comm | awk '/LM Studio|lms|llmster|node-mlx|mlx/ {s+=$1} END{print int(s/1024)}')
  echo "$(date +%T),$(g 'Pages wired'),$(g 'Pages active'),$(g 'occupied by compressor'),$(g 'Pages free'),$sw,$mp,$lvl,$rss,$po" >> "$out"
  sleep "$iv"
done
