#!/usr/bin/env bash
# Model-check FileLock.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/filelock/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 300; an unfinished search that found
#        no violation reports "bounded", which counts as holding),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-300}
out=${OUT:-$(mktemp -d)}
glob=${1:-MC_*}

invariants=(TypeOK MutualExclusion CommitExclusion GuardExclusion NoReclaimFromLiveHolder
  ReleaseOwnOnly StaleGuardReclaimSafe NoOrphanLock NoOrphanGuard)

# Expected verdict per config: invariants listed here must be violated; all
# others must hold. Keep in sync with the report in the commit message.
declare -A EXPECT=(
  [MC_mutation_noreread]="MutualExclusion CommitExclusion NoReclaimFromLiveHolder ReleaseOwnOnly NoOrphanLock"
  [MC_stale_lock]=""
  [MC_stale_guard]=""
  [MC_stale_guard_2p]=""
  [MC_crash_small]=""
  [MC_crash_guard]=""
  [MC_release_fault]=""
  [MC_old_lease]="MutualExclusion CommitExclusion NoReclaimFromLiveHolder ReleaseOwnOnly NoOrphanLock"
  [MC_nonlinux_reuse]="NoOrphanLock NoOrphanGuard"
)
# Configs too large to search exhaustively under BUDGET: check only these.
declare -A ONLY=(
  [MC_crash_guard]="GuardExclusion StaleGuardReclaimSafe"
)

status=0
echo "results in $out"
printf '%-22s %-24s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  expected=" ${EXPECT[$name]-UNKNOWN} "
  read -r -a invs <<<"${ONLY[$name]-${invariants[*]}}"
  for inv in "${invs[@]}"; do
    tmpcfg="$out/$name.$inv.cfg"
    grep -v '^INVARIANTS' "$cfg" >"$tmpcfg"
    echo "INVARIANT $inv" >>"$tmpcfg"
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" FileLock.tla) >"$log" 2>&1 || rc=$?
    secs=$(($(date +%s) - start))
    distinct=$(grep -oE '[0-9,]+ distinct states found' "$log" | tail -n 1 | cut -d' ' -f1)
    case $rc in
      0) result=holds ;;
      12) result=VIOLATED ;;
      124) result=bounded ;;
      *) result="error($rc)" ;;
    esac
    if [[ $expected == *" $inv "* ]]; then want=VIOLATED; else want=holds; fi
    [[ $result == "$want" || ($result == bounded && $want == holds) ]] || status=1
    printf '%-22s %-24s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
