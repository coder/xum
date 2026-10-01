#!/usr/bin/env bash
# Model-check PeerLimits.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/peer-limits/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 300; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-300}
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS=${TLA_JAVA_OPTS:--Xmx6g}
out=${OUT:-$(mktemp -d)}
glob=${1:-MC_*}

invariants=(TypeOK PairRate TargetRate Dedupe QueueCap NoHalfEnqueue StateBounded)

# Expected verdict per config: invariants listed here must be violated; all
# others must hold. Pre-fix configs (all fix flags off, the code at 520ef794aa)
# must still find the bug their fix removes, which shows the model can see it;
# each has a *_fixed twin with every fix flag on that must hold. All other
# configs model the fixed code; the mutants must stay caught, and restart /
# two backends are documented limitations, not bugs.
declare -A EXPECT=(
  # Fixed code.
  [MC_peer_basic]=""
  [MC_family_only]=""
  [MC_fixed]=""
  [MC_cross_route_fixed]=""
  [MC_peer_fail_after_rows_fixed]=""
  [MC_peer_delegated_fixed]=""
  [MC_mut_nopair]="PairRate StateBounded"
  [MC_mut_nodedupe]="Dedupe"
  [MC_mut_nocap]="QueueCap"
  # Pre-fix MC_restart also violated NoHalfEnqueue: a restart between a peer row landing
  # and its post-send charge left the row uncharged. Charging at admission (B2) closes that.
  [MC_restart]="PairRate TargetRate Dedupe"
  [MC_two_backends]="PairRate TargetRate Dedupe"
  # Pre-fix (B1, B2, B3).
  [MC_cross_route]="PairRate TargetRate Dedupe QueueCap StateBounded"
  [MC_peer_fail_after_rows]="PairRate TargetRate"
  [MC_peer_delegated]="QueueCap"
)
# Configs too large to search exhaustively under BUDGET: check only these.
declare -A ONLY=()

status=0
echo "results in $out"
printf '%-22s %-24s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  # A config without an expectation fails instead of defaulting to "all hold".
  if [[ -z ${EXPECT[$name]+set} ]]; then
    echo "$name: no EXPECT entry" >&2
    status=1
    continue
  fi
  expected=" ${EXPECT[$name]} "
  read -r -a invs <<<"${ONLY[$name]-${invariants[*]}}"
  for inv in "${invs[@]}"; do
    tmpcfg="$out/$name.$inv.cfg"
    grep -v '^INVARIANTS' "$cfg" >"$tmpcfg"
    echo "INVARIANT $inv" >>"$tmpcfg"
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" PeerLimits.tla) >"$log" 2>&1 || rc=$?
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
    printf '%-22s %-24s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
