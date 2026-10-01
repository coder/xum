#!/usr/bin/env bash
# Model-check WorkspaceLifecycle.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/workspace-lifecycle/check.sh [config-name-glob]   (default: all MC_*.cfg)
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
# A caller-supplied OUT may not exist yet.
mkdir -p "$out"
glob=${1:-MC_*}

invariants=(TypeOK NoOrphanCheckout UserBranchSafe FailedNoGrant Finalized UniqueNames NoReappear)

# Expected verdict per config: invariants listed here must be violated; all others must hold.
# Each finding config (F1-F4, the code at origin/main 7fd99d0d3f) has a *_fixed twin with the
# candidate fix on that must hold; the mutants must stay caught. The code now ships the F1, F3
# and F4 candidate fixes (lockRollback, mpKeep, mpPendingConsent).
declare -A EXPECT=(
  [MC_single_ok]=""
  [MC_single_none]=""
  [MC_same_name]=""
  [MC_create_faults]=""
  [MC_remove_retry_noclash]=""
  [MC_multi_ok]=""
  # Findings.
  [MC_lock_fault]="NoOrphanCheckout"
  [MC_remove_retry]="UserBranchSafe"
  [MC_multi_p2fail]="UserBranchSafe"
  [MC_multi_meta]="FailedNoGrant"
  # Fixed twins.
  [MC_lock_fault_fixed]=""
  [MC_remove_retry_fixed]=""
  [MC_multi_p2fail_fixed]=""
  [MC_multi_meta_fixed]=""
  # Mutation checks.
  [MC_mut_rollback_branch]="UserBranchSafe"
  [MC_mut_grant]="Finalized"
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
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" WorkspaceLifecycle.tla) >"$log" 2>&1 || rc=$?
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
