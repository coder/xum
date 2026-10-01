#!/usr/bin/env bash
# Model-check TaskLifecycle.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/task-lifecycle/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 300; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
#
# Findings (repros: src/node/services/taskService.lifecycleFormalRepro.test.ts):
#   L1 NoAutoStartAfterStop: reactivateInactiveAgentTask (taskService.ts 8631-8830) has no
#      stop-epoch or sender-chain fence. With R > P > C, the user's Stop of R latches C, but a
#      reported/idle C releases its latch independently of P's cleanup, so P's suspended
#      task_send_message reawakening commits a fresh attempt after the Stop and C runs.
#   L2 NoLostReport/AtMostOneLive: reawakenInterruptedTask (16151-16328) rotates an
#      `interrupted` row whose attempt a reactivation just published (reactivation leaves the
#      status `interrupted`; neither side rechecks the other's live attempt), superseding the
#      live continuation, whose report is then dropped.
#   L3 RunningIsLive: WorkspaceService's resume rescue returns on a fence refusal
#      (workspaceService.ts 15315-15318) without restoreInterruptedTaskAfterResumeFailure,
#      leaving the row `running` with an owned attempt and no turn.
# Limitations: one backend (two backends not modeled); one task C with a single parent; Phase A
# and each mutex section atomic; WTM registration and execution mirror merged; a refused send
# leaves nothing; report CAS atomic; no compaction, workflows, bash-monitor wakes or per-task
# task_stop (a bash-monitor reawakening takes no tree lock and can overlap a Stop, but it is the
# child's own monitor input, which stays automatic after an ordinary Stop: it carries no L1 fence,
# see reactivateInactiveAgentTaskFromBashMonitorWake and #5377); the
# outcome of a refused startup re-drive is not modeled, so RunningIsLive exempts the one attempt
# a restart left `running` (every later attempt is checked).
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

invariants=(TypeOK NoAutoStartAfterStop NoReopen AtMostOneLive NoLostReport RunningIsLive)

# Expected verdict per config: invariants listed here must be violated; all others
# must hold. Pre-fix configs model the code at ea52e87b33 and must find their finding (the
# FixReactEpoch and FixInactiveRecheck branches model the L1/L2 fixes as shipped);
# each *_fixed twin turns on the fix flag(s) and must hold everything.
declare -A EXPECT=(
  [MC_L1_nested]="NoAutoStartAfterStop"
  [MC_L1_root]=""
  [MC_L1_fixed]=""
  # Depth2 is on here too, so L1 shows up as well.
  [MC_L2_manual_react]="NoAutoStartAfterStop AtMostOneLive NoLostReport"
  [MC_L2_fixed]=""
  [MC_L3_removal]="RunningIsLive"
  [MC_L3_fixed]=""
  [MC_all_fixed]=""
  [MC_all_fixed_reported]=""
  [MC_all_fixed_big]=""
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
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" TaskLifecycle.tla) >"$log" 2>&1 || rc=$?
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
