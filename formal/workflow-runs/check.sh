#!/usr/bin/env bash
# Model-check WorkflowRuns.tla: one TLC run per (config, property) pair, so each
# violated property gets its own counterexample (BFS-shortest for invariants).
#
# Usage: formal/workflow-runs/check.sh [config-name-glob]   (default: all MC_*.cfg)
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

# Terminates is a temporal property (checked as PROPERTY); the rest are invariants.
# IdsSuffice holding shows a Terminates verdict is not an artifact of the child-id bound.
invariants=(TypeOK SingleLiveChild NoReexec CompletedSound ResultSound IdsSuffice Terminates)

# Expected verdict per config: properties listed here must be violated; all
# others must hold. Configs named *_current model the code at ea52e87b33 with
# every fix flag off; single-finding configs turn on every fix except the one
# they isolate, so each violation is attributed to one finding.
declare -A EXPECT=(
  # The code at ea52e87b33: W7, W8 and W10 each keep a run from ever finishing after a crash.
  [MC_crash_current]="Terminates"
  # Two backends and a stalled lease owner, no crash: the conservative no-record rule keeps
  # one live child per step, and resuming in the owner's backend finishes the run.
  [MC_two_stall]=""
  # The code with the W8 tombstone and the W7 recovery. After a crash W10 still keeps a run from
  # finishing; with two backends and a stalled owner (no crash, so it cannot occur) every
  # property holds.
  [MC_crash_tomb]="Terminates"
  [MC_two_stall_tomb]=""
  # One finding each.
  [MC_pending]="Terminates"         # W7: crash before the first running status
  [MC_norecord]="Terminates"        # W8: crash between started checkpoint and commit
  [MC_prepass]="Terminates"         # W10: crash between interrupted and terminate
  # Why W8 needs more than "replace it": a stalled owner's late commit publishes a second
  # child, and when the replacement already recorded the step, re-executes a recorded step.
  [MC_two_stall_naive]="SingleLiveChild NoReexec"
  # Fixed models and controls.
  [MC_pending_user]=""
  [MC_pending_fixed]=""             # W7 fix: recovery adopts a pending run whose starter is gone
  [MC_retry]=""
  [MC_fixed]=""
  [MC_two_stall_fixed]=""
  [MC_two_crash_fixed]=""
  # Mutant: the lease-owner fence is load-bearing; without it every property breaks (and
  # duplicate children exhaust the child ids).
  [MC_mut_nofence]="SingleLiveChild NoReexec CompletedSound ResultSound IdsSuffice Terminates"
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
    if [[ $inv == Terminates ]]; then
      grep -v '^PROPERTIES' "$tmpcfg" >"$tmpcfg.tmp" && mv "$tmpcfg.tmp" "$tmpcfg"
      echo "PROPERTY $inv" >>"$tmpcfg"
    else
      grep -v '^PROPERTIES' "$tmpcfg" >"$tmpcfg.tmp" && mv "$tmpcfg.tmp" "$tmpcfg"
      echo "INVARIANT $inv" >>"$tmpcfg"
    fi
    log="$out/$name.$inv.log"
    start=$(date +%s)
    rc=0
    (cd "$here" && timeout "$budget" "$tlc" -workers "$workers" -deadlock -noGenerateSpecTE \
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" WorkflowRuns.tla) >"$log" 2>&1 || rc=$?
    secs=$(($(date +%s) - start))
    # A run killed before TLC printed a state count has none (grep exits 1).
    distinct=$(grep -oE '[0-9,]+ distinct states found' "$log" | tail -n 1 | cut -d' ' -f1 || true)
    case $rc in
      0) result=holds ;;
      12 | 13) result=VIOLATED ;;  # 12 safety, 13 liveness
      124) result=bounded ;;
      *) result="error($rc)" ;;
    esac
    if [[ $expected == *" $inv "* ]]; then want=VIOLATED; else want=holds; fi
    [[ $result == "$want" ]] || status=1
    printf '%-22s %-24s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
