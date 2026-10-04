#!/usr/bin/env bash
# Model-check StreamRetry.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/stream-retry/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 1800; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise. A full run (no
#        glob) also fails when an EXPECT entry has no config file.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-1800}
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS=${TLA_JAVA_OPTS:--Xmx6g}
out=${OUT:-$(mktemp -d)}
# A caller-supplied OUT may not exist yet, and may be relative: TLC runs from $here.
mkdir -p "$out"
out=$(cd "$out" && pwd)
glob=${1:-MC_*}

invariants=(TypeOK NoStreamAfterStop NoStaleRetry OneStream StopSettles NoStrandedSend)

# Expected verdict per config: invariants listed here must be violated; all
# others must hold. MC_faithful models the code at a186481add; MC_fixed turns on
# the fix probe for its finding and must hold; MC_mut_* break one protocol step
# and must stay caught (they show the model can see the bug class). These configs
# keep a manual send's acceptance and re-enable in one step (AtomicReenable).
# MC_window is the code on main with that window split (#5495): a crash inside
# it strands the send (NoStrandedSend), and a Stop inside it has its opt-out
# overwritten, so a restart auto-retries the stopped send (NoStreamAfterStop).
declare -A EXPECT=(
  [MC_faithful]="NoStaleRetry"
  [MC_fixed]=""
  [MC_stop_only]=""
  [MC_mut_nofence]="NoStreamAfterStop"
  [MC_mut_nooptout]="NoStreamAfterStop"
  [MC_mut_noidle]="OneStream"
  [MC_mut_nostopend]="StopSettles"
  [MC_window]="NoStreamAfterStop NoStrandedSend"
)

status=0
if [[ $# -eq 0 ]]; then
  for name in "${!EXPECT[@]}"; do
    if [[ ! -f "$here/$name.cfg" ]]; then
      echo "$name: EXPECT entry without a config file" >&2
      status=1
    fi
  done
fi

echo "results in $out"
printf '%-20s %-20s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  # A config without an expectation fails instead of defaulting to "all hold".
  if [[ -z ${EXPECT[$name]+set} ]]; then
    echo "$name: no EXPECT entry" >&2
    status=1
    continue
  fi
  expected=" ${EXPECT[$name]} "
  for inv in "${invariants[@]}"; do
    tmpcfg="$out/$name.$inv.cfg"
    grep -v '^INVARIANTS' "$cfg" >"$tmpcfg"
    echo "INVARIANT $inv" >>"$tmpcfg"
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" StreamRetry.tla) >"$log" 2>&1 || rc=$?
    secs=$(($(date +%s) - start))
    # A run killed before TLC printed a state count has none (grep exits 1).
    distinct=$(grep -oE '[0-9,]+ distinct states found' "$log" | tail -n 1 | cut -d' ' -f1 || true)
    case $rc in
      0) result=holds ;;
      12) result=VIOLATED ;;
      124) result=bounded ;;
      *) result="error($rc)" ;;
    esac
    if [[ $expected == *" $inv "* ]]; then want=VIOLATED; else want=holds; fi
    [[ $result == "$want" ]] || status=1
    printf '%-20s %-20s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
