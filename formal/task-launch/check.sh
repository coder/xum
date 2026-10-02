#!/usr/bin/env bash
# Model-check TaskLaunch.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/task-launch/check.sh [config-name-glob]   (default: all MC_*.cfg)
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
# A caller-supplied OUT may not exist yet, and may be relative: TLC runs from $here.
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
glob=${1:-MC_*}

invariants=(TypeOK NoInitAfterCancel RemovedRowLeavesNoCheckout CleanupNeverTouchesSuccessor
  PromptRetainedUntilAccepted PromptSentOnce RunningOnlyFromOwnedStarting OneMaterializer)

# Expected verdict per config: invariants listed here must be violated; all others must hold.
# The shipped code is Fixes = {"initRecheck", "clearOnAccept"} plus the missing-row half of
# "missingRowDeletes" (Mutant "fixMissingOnly"): U1 and U4 fixed, U2 half fixed. Each finding
# config has a *_fixed twin with a candidate fix that must hold; the mutants must stay caught.
declare -A EXPECT=(
  # U1 before its fix (Fixes = {}, origin/main c5a0b5ad4a): kept as the record of the finding.
  [MC_cancel]="NoInitAfterCancel"
  [MC_stop]="NoInitAfterCancel"
  # U4 in the shipped code: fixed.
  [MC_prompt]=""
  # Open findings in the shipped code: U2 (its removal-marked half), U3.
  [MC_remove]="RemovedRowLeavesNoCheckout"
  [MC_two_backends]="OneMaterializer CleanupNeverTouchesSuccessor PromptSentOnce"
  # What holds: the superseded launch's cleanup keeps the successor's checkout; restart recovery.
  [MC_two_backends_cancel]="OneMaterializer PromptSentOnce"
  [MC_restart]=""
  # Fixed twins.
  [MC_cancel_fixed]=""
  [MC_stop_fixed]=""
  [MC_remove_fixed]=""
  [MC_prompt_fixed]=""
  [MC_two_backends_fixed]=""
  [MC_all_fixed]=""
  # Mutation checks.
  [MC_mut_recheck_abort_only]="NoInitAfterCancel"
  [MC_mut_clear_prompt_always]="PromptRetainedUntilAccepted"
  [MC_mut_cleanup_no_owner_check]="OneMaterializer CleanupNeverTouchesSuccessor PromptSentOnce"
  [MC_mut_running_unguarded]="RunningOnlyFromOwnedStarting"
  [MC_mut_fix_missing_only]="RemovedRowLeavesNoCheckout"
)
declare -A ONLY=()

status=0
# A full run must cover every EXPECT entry: a deleted or renamed config would otherwise drop its
# scenario silently. A filtered run (a glob argument) checks only the configs it matches.
if [[ $glob == "MC_*" ]]; then
  for name in "${!EXPECT[@]}"; do
    if [[ ! -f $here/$name.cfg ]]; then
      echo "$name: EXPECT entry without a config file" >&2
      status=1
    fi
  done
fi
echo "results in $out"
printf '%-30s %-28s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
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
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" TaskLaunch.tla) >"$log" 2>&1 || rc=$?
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
    printf '%-30s %-28s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
