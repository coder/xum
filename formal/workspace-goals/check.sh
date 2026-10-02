#!/usr/bin/env bash
# Model-check WorkspaceGoals.tla: one TLC run per (config, invariant) pair, so each
# violated invariant gets its own shortest (BFS) counterexample.
#
# Usage: formal/workspace-goals/check.sh [config-name-glob]   (default: all MC_*.cfg)
# Env:   TLC (default ~/.local/bin/tlc), WORKERS (default 8),
#        BUDGET seconds per run (default 300; an unfinished search that found
#        no violation reports "bounded", which fails the check: only an
#        exhaustive search shows an invariant holds),
#        OUT (default a fresh mktemp dir; traces land in $OUT/<cfg>.<inv>.log)
# Exit:  0 when every result matches EXPECT below, 1 otherwise.
#
# Findings (G1 regression test: src/node/services/workspaceGoals.formalRepro.test.ts):
#   G1 NoStrandedGoal (fixed): checkGoalContinuationEligibility captured the candidate before
#      its awaits but dropped "the" candidate by key. A replacement that armed its kickoff
#      candidate during those awaits lost it to the stale goal_mismatch drop; the queued dispatch
#      then found no candidate and the new goal idled. The drop now deletes only the captured
#      candidate (deletePendingCandidateIfStillSame): FixStaleDrop. MC_G1_stale_drop keeps the
#      pre-fix behaviour and must still find the violation.
#   G2 NoHeartbeatWhenOff (open; its regression tests land with the fix): a heartbeat queued
#      behind a busy turn (whenBusy tool-end/turn-end) sits in the session queue with no
#      settings generation; unset/disable
#      (workspaceService.ts unsetHeartbeatSettings 8599, setHeartbeatSettings 9022) leaves it,
#      and the queue drain sends it. G2b: executeHeartbeat (20194) never re-checks `enabled`
#      after HeartbeatService's eligibility check.
#   G4 NoStrandedGoal (MC_error_stall, design gap, open, tracked in #5461): a terminal stream
#      error (agentSession.ts handleStreamError) requests no continuation, so an active goal idles
#      until the user, a heartbeat or a restart drives it. Other configs exempt this state.
# Sanity: MC_mut_noprobe removes the admissionStale probe and must find a stale continuation.
# Limitations: one workspace and one backend (two backends not modeled); each await window is
# one step; the candidate's source (kickoff / stream_end / wrap-up) and the cooldown are not
# modeled; accounting is one step at stream end (no previews, no child-report attribution, no
# evaluator charges); compaction and context reset run as an ordinary heartbeat turn; user
# Stop, plan/compact agents and descendant tasks are not modeled; tool-end and turn-end queue
# modes share one drain point.
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
# Absolute: each TLC run cds into $here, where a relative OUT would name another directory.
out=$(cd "$out" && pwd)
glob=${1:-MC_*}

invariants=(TypeOK NoStrandedGoal NoStaleContinuation NoHeartbeatWhenOff NoDoubleFire UsedBounded
  NoTurnWhenArchived)

# Expected verdict per config: invariants listed here must be violated; all others must hold.
# Pre-fix configs model the code at f30a1945a6 and must find their finding; *_fixed twins and
# MC_cap / MC_all_fixed_big turn the fix flags on and must hold everything. MC_code tracks the
# shipped code: its fix flags turn on as each fix lands (G1 so far; G2, G2b and G4 are open).
declare -A EXPECT=(
  [MC_G1_stale_drop]="NoStrandedGoal"
  [MC_G1_fixed]=""
  [MC_G2_queued_hb]="NoHeartbeatWhenOff"
  [MC_G2_send_gap]="NoHeartbeatWhenOff"
  [MC_G2_fixed]=""
  [MC_mut_noprobe]="NoStaleContinuation"
  [MC_error_stall]="NoStrandedGoal"
  [MC_cap]=""
  [MC_code]="NoHeartbeatWhenOff"
  [MC_all_fixed_big]=""
)
# Configs too large to search exhaustively under BUDGET: check only these.
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
printf '%-18s %-20s %-9s %-8s %12s %6s\n' config invariant result expect distinct secs
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
      -metadir "$out/meta.$name.$inv" -config "$tmpcfg" WorkspaceGoals.tla) >"$log" 2>&1 || rc=$?
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
    printf '%-18s %-20s %-9s %-8s %12s %6s\n' "$name" "$inv" "$result" "$want" "${distinct:-?}" "$secs"
  done
done
exit "$status"
