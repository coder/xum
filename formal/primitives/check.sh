#!/usr/bin/env bash
# Model-checks every spec in this directory and compares TLC's exit code with the expected
# outcome. TLC exit codes: 0 = no error, 11 = deadlock, 12 = invariant violated,
# 13 = temporal/action property violated.
#
# Usage: formal/primitives/check.sh           (all quick models, about 30 s)
#        DEEP=1 formal/primitives/check.sh    (adds KeyedFifoLock_deep, about 8 min)
# Needs `tlc` on PATH or TLC=/path/to/tlc.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
tlc_bin=${TLC:-tlc}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# spec<TAB>config<TAB>expected exit code
runs=(
  $'AsyncMutex\tAsyncMutex_safety\t0'
  $'AsyncMutex\tAsyncMutex_fifo\t0'
  $'AsyncMutex\tAsyncMutex_barging\t0'
  $'AsyncMutex\tAsyncMutex_double\t0'
  $'AsyncMutex\tAsyncMutex_mutant\t12'
  $'AsyncMutex\tAsyncMutex_mutant_noflag\t12'
  $'AsyncSemaphore\tAsyncSemaphore_safety\t0'
  $'AsyncSemaphore\tAsyncSemaphore_safety1\t0'
  $'AsyncSemaphore\tAsyncSemaphore_fifo\t0'
  $'AsyncSemaphore\tAsyncSemaphore_barging\t0'
  $'AsyncSemaphore\tAsyncSemaphore_mutant\t12'
  $'KeyedFifoLock\tKeyedFifoLock_safety\t0'
  $'KeyedFifoLock\tKeyedFifoLock_mutant_nosplice\t12'
  $'KeyedFifoLock\tKeyedFifoLock_mutant_noflag\t12'
  $'MutexMap\tMutexMap_safety\t0'
  $'MutexMap\tMutexMap_nested\t11'
  $'MutexMap\tMutexMap_mutant\t12'
  $'WithTimeout\tWithTimeout_safety\t0'
  $'WithTimeout\tWithTimeout_mutant\t12'
)
if [[ ${DEEP:-0} == 1 ]]; then
  runs+=($'KeyedFifoLock\tKeyedFifoLock_deep\t0')
fi

status=0
for run in "${runs[@]}"; do
  IFS=$'\t' read -r spec cfg expected <<<"$run"
  log="$out/$cfg.log"
  start=$SECONDS
  if "$tlc_bin" -noGenerateSpecTE -workers 4 -metadir "$out/$cfg.states" \
    -config "$cfg.cfg" "$spec.tla" >"$log" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  states=$(grep -Eo '[0-9,]+ distinct states found' "$log" | tail -n 1 || true)
  if [[ $rc == "$expected" ]]; then
    printf 'ok    %-34s exit %s  %s  %ss\n' "$cfg" "$rc" "${states:-?}" $((SECONDS - start))
  else
    printf 'FAIL  %-34s exit %s, expected %s\n' "$cfg" "$rc" "$expected"
    tail -n 30 "$log"
    status=1
  fi
done
exit "$status"
