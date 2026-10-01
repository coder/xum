#!/usr/bin/env bash
# Model-check the workspace-lease specs: one TLC run per (config, invariant)
# pair, so each violated invariant gets its own shortest (BFS) counterexample.
# The config prefix picks the module:
#   MC_lease_*, MC_mut_*  -> WorkspaceLeases.tla (leases + mutation gate)
#   MC_init_*             -> InitReplay.tla      (#4918)
#   MC_cascade_*          -> ArchiveCascade.tla  (#4928)
#
# Usage: formal/workspace-leases/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 1800; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tlc=${TLC:-$HOME/.local/bin/tlc}
workers=${WORKERS:-8}
budget=${BUDGET:-1800}
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS=${TLA_JAVA_OPTS:--Xmx6g}
out=${OUT:-$(mktemp -d)}
mkdir -p "$out"
glob=${1:-MC_*}

declare -A INVARIANTS=(
  [WorkspaceLeases]="TypeOK GateExclusion NoTouchDuringMutation OneMutator"
  [InitReplay]="TypeOK FinalRecordCorrect NoErrorWhileOwnerRuns"
  [ArchiveCascade]="TypeOK NoLiveChildUnderArchivedParent"
)

# Expected verdict per config: invariants listed here must be violated; all
# others must hold. Faithful configs model the code at ea52e87b33; *_fixed
# configs turn on a fix probe and must hold; MC_mut_* break one protocol step
# and must stay caught (they show the model can see the bug class).
declare -A EXPECT=(
  # Leases + gate.
  [MC_lease_exec]=""
  [MC_lease_turn]="NoTouchDuringMutation"
  [MC_lease_turn_crash]="NoTouchDuringMutation"
  [MC_lease_turn_rename_one]="NoTouchDuringMutation"
  [MC_lease_turn_fixed]=""
  [MC_mut_noprobe]="GateExclusion NoTouchDuringMutation"
  [MC_mut_noscan]="GateExclusion NoTouchDuringMutation"
  [MC_mut_scanfirst]="GateExclusion NoTouchDuringMutation"
  # #4918 init replay.
  [MC_init_faithful]="FinalRecordCorrect NoErrorWhileOwnerRuns"
  [MC_init_holdfirst]="FinalRecordCorrect"
  # Gap 1 alone also breaks the final record: R's stale write lands after O finished.
  [MC_init_endfirst]="FinalRecordCorrect NoErrorWhileOwnerRuns"
  [MC_init_fixed]=""
  # #4928 archive cascade.
  [MC_cascade_two_backends]="NoLiveChildUnderArchivedParent"
  [MC_cascade_one_backend]=""
  [MC_cascade_fixed]=""
)

module_of() {
  case $1 in
    MC_lease_* | MC_mut_*) echo WorkspaceLeases ;;
    MC_init_*) echo InitReplay ;;
    MC_cascade_*) echo ArchiveCascade ;;
    *) echo "" ;;
  esac
}

status=0
echo "results in $out"
printf '%-26s %-30s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
for cfg in "$here"/$glob.cfg; do
  name=$(basename "$cfg" .cfg)
  module=$(module_of "$name")
  # A config without an expectation or module fails instead of defaulting to "all hold".
  if [[ -z ${EXPECT[$name]+set} || -z $module ]]; then
    echo "$name: no EXPECT entry or module" >&2
    status=1
    continue
  fi
  expected=" ${EXPECT[$name]} "
  read -r -a invs <<<"${INVARIANTS[$module]}"
  for inv in "${invs[@]}"; do
    tmpcfg="$out/$name.$inv.cfg"
    grep -v '^INVARIANTS' "$cfg" >"$tmpcfg"
    echo "INVARIANT $inv" >>"$tmpcfg"
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" "$module.tla") >"$log" 2>&1 || rc=$?
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
    printf '%-26s %-30s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
