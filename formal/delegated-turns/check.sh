#!/usr/bin/env bash
# Delegated-turn peer delivery: TLA+ model
#
# `DelegatedTurns.tla` models peer-message (`task_send_message`) delivery into one root
# workspace that runs delegated workspace turns owned by another workspace. It was written to
# check the protocol from #4997, #5263 and #5272 at commit `491bb881b5`, and it reproduced
# #5277, #5261 and findings F1-F3 below. Each has a fix flag. With every flag on, the model
# matches the fixed code: #5277 by #5303, #5261 by #5308, and F1-F3 by #5311. Its `file:line`
# citations were re-mapped to origin/main `6a3bc7ffe6`, where `InterruptGap` (#5433) was added
# and found F4, which this model's PR fixes (citations reflect the fix).
#
# Run `./check.sh` (TLC at `~/.local/bin/tlc`). The `MC_<finding>.cfg` configs are pre-fix
# configs: they turn their finding's fix off and must still find its violation (TLC exit 12),
# which shows the model can see the bug the fix removes. Each `MC_<finding>_fixed.cfg` twin turns
# that one fix on and must find none. The `MC_Search*.cfg` configs must find none.
# Print a counterexample with `python3 show_trace.py <dump>.json`.
#
# What is modeled
#
# Each await-free code segment is one action. The spec gives `file:line` for each one.
#
# | Actor                                               | Actions                                                                                                         | Code                                                                                                                       |
# | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
# | Sender (owner or non-owner), first attempt or retry | `Enter`, `Corr`, `Gate1`, `WsGate`, `Gate2`, `Rollback`                                                         | `sendTreeMessage` (taskService.ts 9965-10710), WorkspaceService gates (15546, 15722), AgentSession final gate (5413-5432) |
# | Target session queue                                | `Dequeue`                                                                                                       | `sendQueuedMessages` (agentSession.ts 10929-11015)                                                                         |
# | Owner                                               | `CreateDecide`, `CreateRegister`, `CreateLaunch`, `OwnerInterrupt`, `OwnerInterruptLatch(Done)`, `OwnerWithdraw` | `createWorkspaceTurn` (workspaceTurnManager.ts 1513, 1858-2178), `interruptWorkspaceTurn` (3690-3834)                     |
# | Stream end / abort                                  | `StreamEnd`, `Finalize`, `AbortFinalize`                                                                        | `finalizeWorkspaceTurnFromStreamEnd` (5483-5636) under the target's event lock (`runStreamEndHandler`, taskService.ts 3426) |
# | User                                                | `UserStop(Done)`, `UserResume`                                                                                  | `interruptStream` (workspaceService.ts 16349-16376), `markParentWorkspaceInterrupted` (taskService.ts 16587)               |
# | Flush                                               | `FlushBegin`, `FlushStep`, `FlushAwait`                                                                         | `flushParkedPeerSends` (taskService.ts 2625-2680)                                                                          |
#
# The model includes these facts:
#
# - `sendTreeMessage` holds the target's admission lock (the broker delivery lock, then the
#   event lock) for its whole path, and the stream-end handler needs the event lock too.
# - Registrations are counted by `LiveWorkspaceTurnRegistrations.set` whenever the handle ID
#   changes, including a replacement that has no release (workspaceTurnManager.ts 641-661).
# - `createWorkspaceTurn` checks whether the target is busy before several awaits. Separate calls
#   run concurrently.
# - `interruptWorkspaceTurn` writes `interrupted` under the publication lock and bumps the stop
#   epoch and latches in the same step; the registration release follows after awaits. From
#   #5433 until the F4 fix, the bump and latch also waited for the lock's release (`InterruptGap`).
#
# Abstractions:
#
# - Tool-end and turn-end dispatch are one `StreamEnd` action. Dispatch mode changes only when
#   the stream ends.
# - Row rollback always succeeds. A failed rollback returns a visible refusal to the sender.
# - User streams, multiple backends, compaction and agent-task targets are not modeled. With one
#   backend, the publication lock only orders the owner's acceptance and interrupt, which are
#   atomic actions here.
# - The flush pops the parked head; the code peeks and the retry removes it under the admission
#   lock (the queue cap that protects is modeled in formal/peer-limits).
# - The read-time self-heal (`normalizeWorkspaceTurnRecord` → `settleStaleWorkspaceTurn`,
#   workspaceTurnManager.ts 3298-3311, 4700) is not modeled. `NoOrphanedTurn` therefore flags a
#   handle that stays running until something reads it. The #5261 fix reuses that self-heal
#   (`WithdrawSettle`), but a read can still run it outside the event lock, which is why the code
#   keeps both F3 defenses (see `MC_Search_NoStaleCorr`).
#
# Invariants
#
# `NoDuplicate`, `NoDeliveryIntoReplacement`, `UserStopRespected`, `OwnerStopRespected`,
# `NonOwnerNeverCorrelated`, `NoOrphanedTurn`, `NoStrandedPark`, and `NoSilentLoss`. When the
# system is quiescent, `NoSilentLoss` requires every message whose sender was told
# queued/accepted to be delivered or dropped.
#
# Results (6a3bc7ffe6 plus the F4 fix; `MC_SearchBig` was last run before `InterruptGap` existed)
#
# | Config                  | Bounds                                                                       | Result                                                    | Code test (`src/node/services/taskService.delegatedTurnFormalRepro.test.ts`) |
# | ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
# | `MC_5277`               | 1 peer, 2 turns                                                              | `NoDeliveryIntoReplacement` violated (4,530 states)       | regression test (fixed by #5303)                                              |
# | `MC_5261`               | owner msg, 1 turn, withdraw                                                  | `NoOrphanedTurn` violated (198 states)                    | regression tests (fixed by #5308)                                             |
# | `MC_F1_StopPark`        | 1 peer, 1 turn, 1 user Stop                                                  | `UserStopRespected` violated (1,173 states)               | regression test (fixed by #5311)                                              |
# | `MC_F2_RegReplace`      | 1 peer, 2 turns                                                              | `NonOwnerNeverCorrelated` violated (2,919 states)         | regression tests through `createWorkspaceTurn` (fixed by #5311)               |
# | `MC_F3_StaleCorr`       | as `MC_Search`, `FixStaleCorr` and `SettleUnderLock` off                     | `NonOwnerNeverCorrelated` violated                        | regression test, guard only (fixed by #5311)                                  |
# | `MC_F4_InterruptGap`    | owner msg, 1 turn, 1 owner interrupt, all fixes                              | `OwnerStopRespected` violated (351 states)                | regression test + control (fixed by this model's PR)                          |
# | `MC_<finding>_fixed`    | as its pre-fix config with that one fix on (F4: `InterruptGap` off)          | no violation (F3: 15,749,272 states)                      | —                                                                            |
# | `MC_Search`             | 1 peer + owner msg, 2 turns, 1 Stop, 1 owner interrupt, withdraw, the code   | no violation: 15,256,645 states                           | —                                                                            |
# | `MC_Search_NoStaleCorr` | as `MC_Search`, `FixStaleCorr` off: #5308's lock alone closes F3             | no violation: 17,915,817 states                           | —                                                                            |
# | `MC_SearchBig`          | as `MC_Search` with 2 peers                                                  | no violation without `InterruptGap`: 391,510,097 states, depth 57, ~20 min with 16 workers (#5334) | —                                   |
#
# Every config but `MC_F4_InterruptGap` sets `InterruptGap` off (the shipped code); the
# `MC_Search*` configs check every invariant.
# A full local run (every config but `MC_SearchBig`) takes ~6 min with 16 workers.
#
# The fixes, as modeled:
#
# - `Fix5277` (#5303): `park()` stores the registration count seen by the refusing gate
#   (`refusedAtRegistrationEpoch`, taskService.ts 10504-10506, 10606-10611).
# - `Fix5261` (#5308): a withdrawn correlated continuation schedules a reconcile
#   (`scheduleWithdrawnWorkspaceTurnContinuationReconcile`, taskService.ts 12290-12324). It waits
#   until the target is idle with an empty queue, then takes the target's event lock and settles
#   the turn through `settleStaleWorkspaceTurn` if its stream end deferred to a continuation
#   (`WithdrawSettle`). The event lock is FIFO, and stream event handlers are queued on it in the
#   event's own tick, before the session reads idle, so a queued handler with a newer result runs
#   first. Waiting for idle also covers a queued delegated turn that dispatches right after the
#   withdrawal: an earlier single-attempt design without that wait orphaned the turn in
#   `MC_Search`.
# - `FixStopPark` (F1, #5311): `park()` refuses once a user Stop happened since first admission
#   (`workspaceUserStopEpochs`, taskService.ts 10293, 10599-10602), and the sender gets the
#   interrupted refusal.
# - `FixRegReplace` (F2, #5311): under the workspace lifecycle lock, `createWorkspaceTurn`
#   rechecks whether the target is busy and refuses a reservation over a running turn's
#   registration (workspaceTurnManager.ts 1871-1900). An idle target keeps the replacement; the
#   replaced turn's acceptance registers it again (2035-2039, `CreateLaunch`).
# - `FixStaleCorr` (F3, #5311): only the owner resolves a root turn's correlation
#   (taskService.ts 10388-10396), and a send whose resolved correlation has no live registration
#   is refused (10175-10178). `SettleUnderLock` alone also closes F3 in the model.
# - `InterruptGap` off (F4 fix): the stop epoch bump and latch run right after the `interrupted`
#   write, inside the publication lock (workspaceTurnManager.ts 3752-3762). TRUE models the code
#   from #5433 until this fix, where they ran only after awaiting the lock's release.
#
# Findings:
#
# - **F1** (fixed): the user Stops the target while a first attempt awaits its row rollback. The
#   Stop dropped the parked list (taskService.ts 16601) before `onCanceled` parked the message
#   (10679-10682), and the flush's one-time re-baseline (2639-2648) hid the Stop's epoch bump.
# - **F2** (fixed): two concurrent `createWorkspaceTurn` calls on an idle target both took the
#   reserve path. B's `Map.set` replaced the live turn A without a release, and B's failed
#   `requireIdle` send deleted the registration while A ran.
# - **F3** (fixed, was latent): `getDelegatedRootRefusal` returned null when no registration was
#   live, so a message whose correlation was resolved against turn A was dispatched with A's
#   correlation (taskService.ts 10171-10179), even from a non-owner.
# - **F4** (fixed): `interruptWorkspaceTurn` wrote `interrupted` (workspaceTurnManager.ts 3752)
#   inside `withWorkspaceTurnPublicationLock`, then awaited the lock's release before it bumped
#   the stop epoch and latched. An owner message whose admission gates ran before the interrupt
#   passed its final gate (agentSession.ts 5413-5432) in that window and was delivered as a
#   continuation of the interrupted turn; the sender was told it was accepted. The later
#   `stopStream` (3821) cut its turn. #5433 moved the record write into the lock callback
#   (6fbad90884) and left the latch behind; the fix moves the bump and latch into it (3761-3762).
#
# Run the code tests with:
# `bun test src/node/services/taskService.delegatedTurnFormalRepro.test.ts`.
# The #5277, #5261 and F1-F4 tests failed before their fixes and pass now.
#
# Model-check DelegatedTurns.tla. Usage: ./check.sh [config...]  (default: every MC_*.cfg but
# MC_SearchBig, which takes ~20 min with 16 workers; name it to run it). A config argument is a
# path (relative to the caller's directory) or a bare name of a config in this directory; its
# basename selects the EXPECT entry.
# Env: TLC (default ~/.local/bin/tlc), WORKERS (default auto), BUDGET seconds per config
# (default none; a config cut by the budget reports "bounded", which fails: only an exhaustive
# search shows an invariant holds), OUT (default a fresh mktemp dir; made absolute).
# Exit 0 when every config matches EXPECT below: a listed invariant must be violated (TLC exit 12
# naming it), an empty entry must find no violation (exit 0).
set -euo pipefail

# Resolve config arguments before the cd below, so a caller-supplied path is the file TLC checks.
args=()
for arg in "$@"; do
  [[ "$arg" == *.cfg ]] || arg="$arg.cfg"
  if [[ -f "$arg" ]]; then arg=$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg"); fi
  args+=("$arg")
done
cd "$(dirname "${BASH_SOURCE[0]}")"
tlc="${TLC:-$HOME/.local/bin/tlc}"
workers="${WORKERS:-auto}"
budget="${BUDGET:-}"
# Bounded heap: an unbounded default JVM heap was OOM-killed on a shared host.
export TLA_JAVA_OPTS="${TLA_JAVA_OPTS:--Xmx6g}"
out="${OUT:-$(mktemp -d)}"
# A caller-supplied OUT may not exist yet, and TLC runs from this directory.
mkdir -p "$out"
out=$(cd "$out" && pwd)

# Expected verdict per config. Pre-fix configs (MC_<finding>) turn their finding's fix off and
# must find its violation; each *_fixed twin turns that one fix on and must hold; the
# MC_Search* configs model the shipped code (every fix on, or one F3 defense off) and must hold.
declare -A EXPECT=(
  [MC_5277]=NoDeliveryIntoReplacement
  [MC_5277_fixed]=""
  [MC_5261]=NoOrphanedTurn
  [MC_5261_fixed]=""
  [MC_F1_StopPark]=UserStopRespected
  [MC_F1_StopPark_fixed]=""
  [MC_F2_RegReplace]=NonOwnerNeverCorrelated
  [MC_F2_RegReplace_fixed]=""
  [MC_F3_StaleCorr]=NonOwnerNeverCorrelated
  [MC_F3_StaleCorr_fixed]=""
  [MC_F4_InterruptGap]=OwnerStopRespected
  [MC_F4_InterruptGap_fixed]=""
  [MC_Search]=""
  [MC_Search_NoStaleCorr]=""
  [MC_SearchBig]=""
)

status=0
if [[ $# -gt 0 ]]; then
  configs=("${args[@]}")
else
  configs=()
  for cfg in MC_*.cfg; do
    [[ "$cfg" == MC_SearchBig.cfg ]] || configs+=("$cfg")
  done
  # A full run also fails when an expectation has lost its config (renamed or deleted).
  for name in "${!EXPECT[@]}"; do
    if [[ ! -f "$name.cfg" ]]; then
      echo "FAIL $name: EXPECT entry has no $name.cfg"
      status=1
    fi
  done
fi

echo "results in $out"
for cfg in "${configs[@]}"; do
  name="$(basename "${cfg%.cfg}")"
  # A config without an expectation fails instead of defaulting to "holds".
  if [[ -z ${EXPECT[$name]+set} ]]; then
    echo "FAIL $name: no EXPECT entry"
    status=1
    continue
  fi
  want="${EXPECT[$name]}"
  rc=0
  timeout_cmd=()
  [[ -z "$budget" ]] || timeout_cmd=(timeout "$budget")
  "${timeout_cmd[@]}" "$tlc" -noGenerateSpecTE -workers "$workers" -metadir "$out/$name.states" \
    -dumpTrace json "$out/$name.json" -config "$cfg" DelegatedTurns.tla >"$out/$name.log" 2>&1 || rc=$?
  summary=$(grep -E "is violated|distinct states found" "$out/$name.log" | tr '\n' ' ' || true)
  case $rc in
    0) result=holds ;;
    12) result="violated:$(grep -oE 'Invariant [A-Za-z0-9_]+ is violated' "$out/$name.log" | head -n 1 | cut -d' ' -f2 || true)" ;;
    124) result=bounded ;;
    *) result="error($rc)" ;;
  esac
  expected=holds
  [[ -z "$want" ]] || expected="violated:$want"
  if [[ "$result" == "$expected" ]]; then
    echo "ok   $name ($result) $summary"
  else
    echo "FAIL $name ($result, expected $expected) $summary; see $out/$name.log"
    status=1
  fi
  if [[ "$rc" -eq 12 ]]; then
    echo "     trace: python3 show_trace.py $out/$name.json"
  fi
done
exit "$status"
