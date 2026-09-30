#!/usr/bin/env bash
# Delegated-turn peer delivery: TLA+ model
#
# `DelegatedTurns.tla` models peer-message (`task_send_message`) delivery into one root
# workspace that runs delegated workspace turns owned by another workspace. It was written to
# check the protocol from #4997, #5263 and #5272 at commit `491bb881b5`, and it reproduced
# #5277, #5261 and findings F1-F3 below. Each has a fix flag. With every flag on, the model
# matches the fixed code: #5277 by #5303, #5261 by #5308, and F1-F3 by the change that added
# this sentence.
#
# Run `./check.sh` (TLC at `~/.local/bin/tlc`). The `MC_<finding>.cfg` configs are pre-fix
# configs: they turn their finding's fix off and must still find its violation (TLC exit 12),
# which shows the model can see the bug the fix removes. Every `MC_Search*.cfg` must find none.
# Print a counterexample with `python3 show_trace.py <dump>.json`.
#
# What is modeled
#
# Each await-free code segment is one action. The spec gives `file:line` for each one.
#
# | Actor                                               | Actions                                                                                   | Code                                                                                                                      |
# | --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
# | Sender (owner or non-owner), first attempt or retry | `Enter`, `Corr`, `Gate1`, `WsGate`, `Gate2`, `Rollback`                                   | `sendTreeMessage` (taskService.ts 9532-10214), WorkspaceService gates (15060, 15226), AgentSession final gate (5141-5160) |
# | Target session queue                                | `Dequeue`                                                                                 | `sendQueuedMessages` (agentSession.ts 10540-10626)                                                                        |
# | Owner                                               | `CreateDecide`, `CreateRegister`, `CreateLaunch`, `OwnerInterrupt(Done)`, `OwnerWithdraw` | `createWorkspaceTurn` (workspaceTurnManager.ts 1529, 1874-2124), `interruptWorkspaceTurn` (3636-3757)                     |
# | Stream end / abort                                  | `StreamEnd`, `Finalize`, `AbortFinalize`                                                  | `finalizeWorkspaceTurnFromStreamEnd` (5373-5526) under the target's event lock (taskService.ts 4616)                      |
# | User                                                | `UserStop(Done)`, `UserResume`                                                            | `interruptStream` (workspaceService.ts 15792-15818), `markParentWorkspaceInterrupted` (taskService.ts 15943)              |
# | Flush                                               | `FlushBegin`, `FlushStep`, `FlushAwait`                                                   | `flushParkedPeerSends` (taskService.ts 2527-2572)                                                                         |
#
# The model includes these facts:
#
# - `sendTreeMessage` holds the target's event lock for its whole path, and the stream-end
#   handler needs that lock too.
# - Registrations are counted by `LiveWorkspaceTurnRegistrations.set` whenever the handle ID
#   changes, including a replacement that has no release (workspaceTurnManager.ts 636-656).
# - `createWorkspaceTurn` checks whether the target is busy before several awaits. Separate calls
#   run concurrently.
#
# Abstractions:
#
# - Tool-end and turn-end dispatch are one `StreamEnd` action. Dispatch mode changes only when
#   the stream ends.
# - Row rollback always succeeds. A failed rollback returns a visible refusal to the sender.
# - User streams, multiple backends, compaction and agent-task targets are not modeled.
# - The read-time self-heal (`normalizeWorkspaceTurnRecord` → `settleStaleWorkspaceTurn`,
#   workspaceTurnManager.ts 3244-3257, 4623) is not modeled. `NoOrphanedTurn` therefore flags a
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
# Results
#
# | Config             | Bounds                                                                      | Result                                                   | Code repro (`src/node/services/taskService.delegatedTurnFormalRepro.test.ts`) |
# | ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
# | `MC_5277`          | 1 peer, 2 turns                                                             | `NoDeliveryIntoReplacement` violated (4,530 states)      | confirmed                                                                     |
# | `MC_5261`          | owner msg, 1 turn, withdraw                                                 | `NoOrphanedTurn` violated (198 states)                   | confirmed (handle stays running until a read normalizes it)                   |
# | `MC_F1_StopPark`   | 1 peer, 1 turn, 1 user Stop                                                 | `UserStopRespected` violated (1,173 states)              | confirmed                                                                     |
# | `MC_F2_RegReplace` | 1 peer, 2 turns                                                             | `NonOwnerNeverCorrelated` violated (5,011 states)        | confirmed (through `createWorkspaceTurn`)                                     |
# | `MC_F3_StaleCorr`  | as `MC_Search`, `FixStaleCorr` and `SettleUnderLock` off                    | `NonOwnerNeverCorrelated` violated                       | `F3` test (guard only)                                                        |
# | `MC_Search`        | 1 peer + owner msg, 2 turns, 1 Stop, 1 owner interrupt, withdraw, all fixes | no violation: 12,218,576 distinct states, ~1.5 min      | —                                                                             |
# | `MC_Search_NoStaleCorr` | as `MC_Search`, `FixStaleCorr` off: #5308's lock alone closes F3       | no violation: 14,172,438 distinct states                 | —                                                                             |
# | `MC_SearchBig`     | as `MC_Search` with 2 peers | no violation in 118,052,419 distinct states before the #5261 and F2 fixes were modeled as implemented (not exhaustive: stopped after ~15 min with 1.06M states queued); not rerun | — |
#
# Each fix flag, turned on alone in its own config, removes that config's violation.
#
# The fixes, as modeled:
#
# - `Fix5277` (#5303): `park()` stores the registration count seen by the refusing gate.
# - `Fix5261` (#5308): a withdrawn correlated continuation schedules a reconcile
#   (`scheduleWithdrawnWorkspaceTurnContinuationReconcile`, taskService.ts). It waits until the
#   target is idle with an empty queue, then takes the target's event lock and settles the turn
#   through `settleStaleWorkspaceTurn` if its stream end deferred to a continuation
#   (`WithdrawSettle`). The event lock is FIFO, and stream event handlers are queued on it in the
#   event's own tick, before the session reads idle, so a queued handler with a newer result runs
#   first. Waiting for idle also covers a queued delegated turn that dispatches right after the
#   withdrawal: an earlier single-attempt design without that wait orphaned the turn in
#   `MC_Search`.
# - `FixStopPark` (F1): `park()` refuses once a user Stop happened since first admission
#   (`workspaceUserStopEpochs`), and the sender gets the interrupted refusal.
# - `FixRegReplace` (F2): under the workspace lifecycle lock, `createWorkspaceTurn` rechecks
#   whether the target is busy and refuses a reservation over a running turn's registration. An
#   idle target keeps the replacement; the replaced turn's acceptance registers it again, which
#   the model now includes (`CreateLaunch`).
# - `FixStaleCorr` (F3): only the owner resolves a root turn's correlation, and a send whose
#   resolved correlation has no live registration is refused. `SettleUnderLock` alone also
#   closes F3 in the model.
#
# - **F1**: the user Stops the target while a first attempt awaits its row rollback. The Stop
#   drops the parked list before `onCanceled` parks the message (taskService.ts 15953 vs
#   10185-10187). The flush's one-time re-baseline (2541-2550) then hides the Stop's epoch bump.
#   After any user send, the message runs.
# - **F2**: two concurrent `createWorkspaceTurn` calls on an idle target both take the reserve
#   path. B's `Map.set` replaces the live turn A without a release. B's failed `requireIdle`
#   send then deletes the registration while A runs. Non-owner messages stop waiting (#4997)
#   and queue into A's session.
# - **F3 (latent)**: `getDelegatedRootRefusal` returns null when no registration is live. A
#   message whose correlation was resolved against turn A is then dispatched with A's
#   correlation (taskService.ts 9731-9732), even from a non-owner. The event lock currently
#   prevents the release from happening in that window. A #5261 fix that settles the turn
#   outside the event lock would open it; #5308 settles under it.
#
# Run the repros with:
# `bun test src/node/services/taskService.delegatedTurnFormalRepro.test.ts`.
# Each failed before its fix and passes now.
#
# Model-check DelegatedTurns.tla. Usage: ./check.sh [config...]  (default: all MC_*.cfg but
# MC_SearchBig). Exit 0 when every config behaves as expected: the MC_<finding> configs must
# find their violation (TLC exit 12) and the MC_Search* configs must find none (exit 0).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
tlc="${TLC:-$HOME/.local/bin/tlc}"
out="${XUM_SCRATCH_DIR:-${TMPDIR:-/tmp}}/delegated-turns-tlc"
mkdir -p "$out"

if [[ $# -gt 0 ]]; then
  configs=("$@")
else
  configs=()
  for cfg in MC_*.cfg; do
    [[ "$cfg" == MC_SearchBig.cfg ]] || configs+=("$cfg")
  done
fi

status=0
for cfg in "${configs[@]}"; do
  name="${cfg%.cfg}"
  expected=12
  [[ "$name" == MC_Search* ]] && expected=0
  rc=0
  "$tlc" -noGenerateSpecTE -workers auto -metadir "$out/$name.states" \
    -dumpTrace json "$out/$name.json" -config "$cfg" DelegatedTurns.tla >"$out/$name.log" 2>&1 || rc=$?
  summary=$(grep -E "is violated|distinct states found" "$out/$name.log" | tr '\n' ' ')
  if [[ "$rc" -eq "$expected" ]]; then
    echo "ok   $name (exit $rc) $summary"
  else
    echo "FAIL $name (exit $rc, expected $expected) $summary; see $out/$name.log"
    status=1
  fi
  if [[ "$rc" -eq 12 ]]; then
    echo "     trace: python3 show_trace.py $out/$name.json"
  fi
done
exit "$status"
