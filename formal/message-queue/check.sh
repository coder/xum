#!/usr/bin/env bash
# Model-checks MessageQueue.tla under every config here and compares TLC's exit code with the
# expected outcome. TLC exit codes: 0 = no error, 12 = invariant violated,
# 13 = temporal property violated.
#
# Usage: formal/message-queue/check.sh   (about 10 minutes, 8 workers)
# Needs `tlc` on PATH or TLC=/path/to/tlc.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
tlc_bin=${TLC:-tlc}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# config<TAB>expected exit code
runs=(
  $'MQ_safety\t0'
  $'MQ_liveness\t0'
  $'MQ_userorder_nohold\t0'
  $'MQ_userorder\t0'
  $'MQ_promoted\t0'
  $'MQ_queuecut\t12'
  $'MQ_mutant_nodequeue\t12'
  $'MQ_mutant_nodrain\t12'
  $'MQ_mutant_trailingrun\t12'
  $'MQ_mutant_directsend\t12'
  $'MQ_stop\t0'
  $'MQ_mutant_nobarrier\t12'
  $'MQ_mutant_cleardrops\t12'
)

status=0
for run in "${runs[@]}"; do
  IFS=$'\t' read -r cfg expected <<<"$run"
  log="$out/$cfg.log"
  start=$SECONDS
  if "$tlc_bin" -noGenerateSpecTE -workers "${WORKERS:-8}" -metadir "$out/$cfg.states" \
    -config "$cfg.cfg" MessageQueue.tla >"$log" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  states=$(grep -Eo '[0-9,]+ distinct states found' "$log" | tail -n 1 || true)
  if [[ $rc == "$expected" ]]; then
    printf 'ok    %-22s exit %s  %s  %ss\n' "$cfg" "$rc" "${states:-?}" $((SECONDS - start))
  else
    printf 'FAIL  %-22s exit %s, expected %s\n' "$cfg" "$rc" "$expected"
    tail -n 30 "$log"
    status=1
  fi
done
exit "$status"
