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
# The shipped code is Fixes = {"initRecheck", "missingRowDeletes", "prepLease"}: U1, U2 and U3
# fixed. Each finding keeps a config of the code before its fix as the record; the mutants must
# stay caught.
declare -A EXPECT=(
  # Records of findings before their fixes: U1 (Fixes = {}, origin/main c5a0b5ad4a), U2's
  # removal-marked half and U3 (before the launch lease).
  [MC_cancel]="NoInitAfterCancel"
  [MC_stop]="NoInitAfterCancel"
  [MC_remove_no_lease]="RemovedRowLeavesNoCheckout"
  [MC_two_backends_no_lease]="OneMaterializer CleanupNeverTouchesSuccessor PromptSentOnce"
  # Open finding in the shipped code: U4.
  [MC_prompt]="PromptSentOnce"
  # The shipped code, and the fixed twins.
  [MC_remove]=""
  [MC_two_backends]=""
  [MC_two_backends_cancel]=""
  [MC_restart]=""
  [MC_cancel_fixed]=""
  [MC_stop_fixed]=""
  [MC_prompt_fixed]=""
  [MC_all_fixed]=""
  # Mutation checks.
  [MC_mut_recheck_abort_only]="NoInitAfterCancel"
  [MC_mut_clear_prompt_always]="PromptRetainedUntilAccepted"
  [MC_mut_cleanup_no_owner_check]="OneMaterializer CleanupNeverTouchesSuccessor PromptSentOnce"
  [MC_mut_running_unguarded]="RunningOnlyFromOwnedStarting"
  [MC_mut_late_lease]="OneMaterializer CleanupNeverTouchesSuccessor PromptSentOnce"
  [MC_mut_remove_ignores_launch]="RemovedRowLeavesNoCheckout"
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
