---
name: formal-stop-retry
description: "Model-check (TLA+ with TLC) that a Stop ends the stream auto-retry loop, so no automatic retry starts a stopped workspace's turn again. Use when a change touches RetryManager, AgentSession's auto-retry or stream-error handling (handleStreamError, handleStreamFailureForAutoRetry, retryActiveStream, resumeStream), a Stop path (WorkspaceService/AgentSession interruptStream, TaskStopLatch, interruptWorkspaceTurn, failAgentTaskForHardTimeout), the stop latch or abandonAutoRetry, the compaction cancellation record, or startup recovery (runStartupRecovery, scheduleStartupAutoRetryIfNeeded, StartupRecovery, the workspace-turn handle read); run `make formal-check`."
---

# Formal check: a Stop ends the auto-retry loop

**Property.** After a Stop, the auto-retry loop never starts that workspace's turn again on its own, also not after a restart of the backend.

**Harm when broken.** The agent keeps calling the model and editing the checkout after the user stopped it.

Tests rarely reach the break. It needs a Stop to land while a stream error's handling, a retry backoff, or a fired retry's preflight is suspended at an await. The tests drive these steps one after another. The model checks every order of them, within the bounds under Scope. This check found three Stop paths that left a backoff armed, so the stopped workspace restarted after the Stop: a task Stop (a parent's Stop cascade, `task_stop` on a sub-agent, a failed launch), a workspace-turn interrupt, and a workflow step's hard timeout. It also found that startup recovery ignored the interrupted handle the interrupt wrote, so a restart resumed the stopped turn, and that a turn interrupt did nothing to a handle that restart recovery had settled, though startup recovery resumed that turn. The repro tests in `src/node/services/stopEndsAutoRetry.repro.test.ts` replay those paths on the real ServiceContainer, and restart it on the same `XUM_ROOT` for the last one. They check the retry state itself, not elapsed time.

## Files

- `StopRetry.tla` is the model. Its comments map each action to its code.
- `ui.cfg`, `api.cfg`, `task.cfg`, `turn.cfg` and `timeout.cfg` each check the property for one Stop kind, with one restart of the backend before the Stop, during its startup recovery, or after the Stop ended:
  - `ui` is the renderer's Stop button, which passes `disableAutoRetry: true`.
  - `api` is a Stop without `disableAutoRetry`, such as an ACP client's cancel (`src/node/acp/agent.ts`) or an API call.
  - `task` is a `TaskStopLatch` stop: a parent's Stop cascade, `task_stop` on a sub-agent, a failed launch, a removal, or a terminal stream failure while work is live.
  - `turn` is a workspace-turn interrupt (`WorkspaceTurnManager.interruptWorkspaceTurn`, which `task_stop` runs for a workspace-turn ID). Its latch drops after its stream stop and cleanup, without waiting for the target's error handling. It latches, then writes the turn's handle `interrupted` before it abandons or stops anything, and that handle is its only trace on disk: startup recovery reads it. A handle that restart recovery settled gets the same interrupt while the turn owns the row that a retry replays.
  - `timeout` is a workflow step's hard timeout (`TaskService.failAgentTaskForHardTimeout`). It latches only when the task still has live work.
- `reachability.cfg` must fail. It proves that an auto-retry can start a turn at all, so a model change that makes retries unreachable cannot pass vacuously.
- `check.sh` runs every config and compares each result with its expected verdict. `make formal-check` runs it.

## Does my change touch the verified code?

`make formal-check` never reads `src/`. It checks the model only, so it checks a code change only after you change the model to match that code.

The sync commit is the last commit that changed the line below. Change that line only after you confirmed that the model describes the code at your commit, with or without a model change. A typo fix elsewhere in this folder does not move the sync commit. Main squash-merges PRs, so write the PR number, not a branch SHA, which would not survive the squash.

Model confirmed against the code in: #7903

| Model action | Code |
| --- | --- |
| `StreamErrors`, `PolicySettles` | `src/node/services/agentSession.ts` `handleStreamError` (entry, which keeps its turn's `activeStreamContext.admissionAutoRetryStops`, and tail), `src/node/services/turnCoordinator.ts` `consumeCompletion`. |
| `PolicyCaptures` | `handleStreamError` awaits `restoreGoalAccountingSnapshot` and `chargeEvaluatorSpendToGoal`, then calls `handleStreamFailureForAutoRetry`, which captures `isCurrent` |
| `PolicySchedules`, `RetryReschedules` (`MayArm`, `PolicyMayArm`) | `agentSession.ts` `handleStreamFailureForAutoRetry`: `compactionRecoveryBlocked`, the preference load, `isCurrent`, `autoRetryStops` (`handleStreamError` passes its turn's `admissionAutoRetryStops`), then `RetryManager.handleStreamFailure`. It does not read the stop latch: an interrupt of a queued workspace turn latches too |
| `RetryFires` | `src/node/services/retryManager.ts` `scheduleRetry` (the fiber's guards and `onRetry`), `agentSession.ts` `retryActiveStream` up to `resumeStream`, `resumeStream` up to `applyAutoRoutedResume` |
| `RetryRoutes` | `resumeStream`: the `isBusy` check |
| `RetryGate` | `resumeStream`: `captureCompactionReplacement`, `compactionRecoveryBlocked`, the pricing gate, the synchronous gate (`compactionStopGeneration`, the retry signal, `isStopInProgress`) and `coordinator.prepare`; the resumed turn's `admissionAutoRetryStops` (`streamWithHistory`) |
| `RetryReschedules` | `retryActiveStream`: its `handleStreamFailureForAutoRetry` calls after a resume that did not start or failed |
| `StopBegins` (ui, api) | `src/node/services/workspaceService.ts` `interruptStream` (`latchHardInterruptCascade`, the `setAutoRetryEnabled(false)` start); `agentSession.ts` `interruptStream` (`cancelCompaction`, `RetryManager.abandon`); `src/node/services/compactionCancellation.ts` `cancel`, `blocksRecovery`. The model reads the record (`cancelDebt`) in `MayArm` and in `RetryGate`, like the code's two `compactionRecoveryBlocked` calls. Either read alone keeps `api` holding: `api` fails only without both |
| `StopBegins` (task) | `src/node/services/taskStopLatch.ts` `beginWorkspaceStop`; callers in `src/node/services/taskService.ts`: `stopDescendantAgentTaskUnderLifecycleLock`, `terminateAllDescendantAgentTasks`, `terminateDescendantAgentTask`, `stopFailedTaskLaunch`, `failAgentTaskTerminally` |
| `StopBegins` (turn) | `src/node/services/workspaceTurnManager.ts` `interruptWorkspaceTurn`: `settledInterruptResult` refuses a `completed` or `error` handle and ends the interrupt of an explicit-Stop or supersede handle at once. Then `latchUnlessSuperseded`: for a handle that restart recovery settled, a first read of the replayed row before the latch (see `TurnWrites`), then `latchWorkspaceStopsInProgress` under the publication lock. A queued handle latches too but abandons nothing. The model has no queued handle: the repro test "interrupting a queued workspace turn leaves the running turn's retry armed" covers it |
| `TurnWrites` | `interruptWorkspaceTurn`: `latchUnlessSuperseded` reads the replayed row again under the latch, and `isSupersededRestartInterrupt` ends the interrupt of a handle that restart recovery settled when the turn no longer owns that row (`ownsRetryRow`: `findLastRetryUserMessage` and `retriedWorkspaceTurn` in `src/node/services/retryUserMessage.ts`, which AgentSession's retry and startup recovery use too; for a compaction row, `retriedWorkspaceTurn` reads the follow-up with `getCompactionFollowUpContent`, its `workspaceTurnMetadata` first). Otherwise `retireSettledOutcomeFields` drops the handle's error and delivery markers, `upsertWorkspaceTurn` writes `status: "interrupted"` without an error (`handle`), `bumpWorkspaceStopEpoch` follows, and only then `deleteReplacedRestartWakes` deletes the restart outcome's stored wake. The model's one tail is the turn's, so the read always lets the Stop go on. The repro test "interrupting a turn that restart recovery settled, during its startup recovery, keeps it from arming a retry" covers a Stop between startup recovery's handle read and its arm |
| `StopBegins` (timeout) | `taskService.ts` `failAgentTaskForHardTimeout`: `clearQueue`, `abandonAutoRetry` |
| `TurnAbandons` | `interruptWorkspaceTurn`: `WorkspaceService.abandonAutoRetry`, which also reaches a session still in its startup recovery (`transientStartupRecoverySessions`). The model has one session; without that lookup, an abandon that misses the recovering session fails `turn`. No repro test pins the lookup: in the real stack, a workspace-turn target's session is already registered while its startup recovery runs |
| `TurnStopReleases` | `interruptWorkspaceTurn`: `releaseStopLatch` in the method-level `finally` |
| `TimeoutFails` | `taskService.ts` `failAgentTaskTerminally`: `sampleLiveExecution`, then `beginWorkspaceStop` and the task cleanup, or nothing for an idle task |
| `TaskCleanupAbandons` | `taskStopLatch.ts` `runWorkspaceStopCleanup` and `retirePendingWork` (`clearQueue`, `abandonAutoRetry`); `abandonAutoRetry` in `agentSession.ts` counts `autoRetryStops` |
| `StopAbortsStream` | `agentSession.ts` `interruptStream` (`streamManager.stopStream`); `aiService.stopStream` in `runWorkspaceStopCleanup`, `interruptWorkspaceTurn` and `failAgentTaskForHardTimeout` |
| `StopJoinsPolicy` | `agentSession.ts` `interruptStream`: `interruptedPolicy` from `turnCoordinator.ts` `captureInterruptSettlement` |
| `StopReleases` | `workspaceService.ts` `interruptStream`: the opt-out join, then `releaseHardStopLatch` in the `finally` |
| `OptOutApplies` | `agentSession.ts` `applyAutoRetryEnabled` with `enabled: false` |
| `TaskStopReleases` | `taskStopLatch.ts` `recheckWorkspaceStopRelease` |
| `Restart` | A new backend on the same `XUM_ROOT`: `readAutoRetryState` loads the opt-out, `readCompactionCancellation` the cancellation record; the handle stays in the owner's `task-handles` |
| `StartupBegins` | `workspaceService.ts` `initialize` (skips sub-agents, `SubAgent`) and `startStartupRecovery`; `agentSession.ts` `runStartupRecovery`: the metadata read and the recovery steps before the check |
| `StartupSchedules` | `scheduleStartupAutoRetryIfNeeded`: `compactionRecoveryBlocked`, then captures the retry generation (`isCurrent`), then the preference and the tail read |
| `StartupReads` | `startupWorkspaceTurnOutcome`: `isWorkspaceTurnStopped` for the turn that the tail's retry row resumes (`retriedWorkspaceTurn`, the reader `ownsRetryRow` uses: a compaction row counts through its follow-up; `TaskService`, `WorkspaceTurnManager.isWorkspaceTurnStopped`: the handle is `interrupted` without an error), then `isCurrent`. A handle that restart recovery settled is `interrupted` with an error and still resumes: the repro test "a restart still resumes a workspace turn that restart recovery settled as interrupted" fails without the error check |
| `StartupArms` | `scheduleStartupAutoRetryIfNeeded`: the derivation, then `handleStreamFailureForAutoRetry` with `isCurrent` |
| `StaleSettles` | `workspaceTurnManager.ts` `settleStaleWorkspaceTurn`, which writes the handle `interrupted` with `WORKSPACE_TURN_STALE_RESTART_ERROR` when `isLiveWorkspaceTurn` finds nothing of the turn live. Its callers include the startup stale-turn sweep (`countActiveWorkspaceTurnsInGlobalScan`, from `TaskService`'s queue drain) and the active-turn scans (`listActiveWorkspaceTurnTaskIdsForOwner`, `normalizeWorkspaceTurnRecord`). Startup recovery arms its retry only at its end (`StartupArms`), so a sweep before then finds nothing live and settles the turn that this recovery then resumes. The repro tests "interrupting a turn that startup recovery resumed after restart recovery settled it stops it" fail without the full interrupt |

To see what changed in the covered files since the sync commit, uncommitted edits included, run:

```sh
sync=$(git log -1 --format=%H -G '^Model confirmed against the code in:' -- .xum/skills/formal-stop-retry/SKILL.md)
files="src/node/services/retryManager.ts src/node/services/agentSession.ts src/node/services/workspaceService.ts
  src/node/services/taskStopLatch.ts src/node/services/turnCoordinator.ts src/node/services/compactionCancellation.ts
  src/node/services/taskService.ts src/node/services/workspaceTurnManager.ts src/node/services/taskWorkspaceSeam.ts
  src/node/services/turnRequestBuilder.ts src/node/services/contextManagement/strategies/summarize.ts
  src/node/services/startupRecovery.ts src/node/services/taskHandleStore.ts src/node/services/retryUserMessage.ts
  src/node/acp/agent.ts src/node/orpc/router.ts src/browser/utils/stopStream.ts
  src/browser/features/Messages/ChatBarrier/StreamingBarrier.tsx src/browser/features/Messages/ChatBarrier/RetryBarrier.tsx
  src/browser/hooks/useAIViewKeybinds.ts src/browser/utils/commands/sources.ts src/browser/utils/compaction/handler.ts"
git diff --stat "$sync" -- $files
git diff "$sync" -- $files
```

The `src/node` files hold the functions in the table and in Scope. The ACP agent, the ORPC router and the renderer files decide which Stop kind a Stop is (`disableAutoRetry`, `soft`). `agentSession.ts`, `workspaceService.ts`, `taskService.ts` and `workspaceTurnManager.ts` change often. Read the diff of the functions in the table and in Scope, not only the file list. When a change adds an await inside a row, adds a new caller of `handleStreamFailureForAutoRetry` or `RetryManager.handleStreamFailure`, adds a new Stop path, or moves a check across an await, the model needs another look.

## Run it

```sh
make formal-check
```

It needs Java 11 or newer. The first run downloads the pinned `tla2tools.jar` (TLA+ tools 1.7.4) into `build/tla/`, which git ignores. Set `TLA2TOOLS_CACHE` to keep the jar in another folder, for example one that several checkouts share. Each config takes a second or two. The script prints one line per config and ends with a count line:

```
config        result               expected              distinct generated   secs
reachability  NoRetryEverResumes   NoRetryEverResumes          28        45      1
ui            holds                holds                    26397     51995      1
api           holds                holds                    16763     30211      1
task          holds                holds                     9772     19782      1
turn          holds                holds                    39384     80430      1
timeout       holds                holds                    10043     19668      1
formal-stop-retry: 6 of 6 configs as expected
```

It exits 0 when every config matches, 1 when one does not or a config name is unknown, and 2 when Java or the jar is missing. To check one config, run `.xum/skills/formal-stop-retry/check.sh task`. The script keeps each TLC log, with its counterexample trace, in a new temp folder and prints the path. Set `FORMAL_OUT` to choose the folder.

## Read a failure

Read every TLC result with the pstack `/statechart` skill. Give it `StopRetry.tla` and the failing config. It shows each violation as its shortest path in plain words, and when the check passes it draws how a workspace moves between states. Without pstack, read the trace in `<config>.log` in the folder that `check.sh` prints on its first line (`TLC logs in ...`): each `State N:` block starts with the action that TLC took. A violation of `StopEndsRetries` ends in a `RetryGate` step that starts a turn after the Stop began.

Then decide whether it is a real bug or a modeling error:

1. Replay the path in the real code, one step per action. Use the repro tests as the template: the real ServiceContainer from `tests/ipc/setup`, a mock language model whose first stream fails, and a spy that holds the await the path suspends at (`restoreGoalAccountingSnapshot` for `PolicyCaptures`). After the Stop, check the retry state: a pending backoff (`hasPendingAutoRetry`) or an `auto-retry-scheduled` or `auto-retry-starting` chat event since the Stop. Do not wait out the backoff and count requests, because a slow runner then passes with the bug present.
2. If the replay leaves a retry armed or fired after the Stop, it is a bug. Keep the test, fix the code, and do not weaken the property.
3. If the replay does not restart it, assume the model is wrong until you find the guard it misses. The first version of this model missed the compaction cancellation record. A ui or api Stop's `cancelCompaction` publishes that record, and it blocks every automatic recovery until a user send replaces it. The model reported a false bug for `api` until it gained `cancelDebt`.

## Change the model

When a change to the code above is intended:

1. Edit the action that stands for the changed code. Keep one action per stretch of code between two awaits that can yield (I/O, an IPC call, a timer). A microtask-only await does not split an action.
2. If the change adds a Stop path, add a Stop kind and a config with its own expected verdict in `check.sh`.
3. Run `make formal-check`. Then break the change on purpose in the real code and in the model, check that a config fails, and revert both.
4. Move the sync commit forward only after you have confirmed that the model describes the code at the new commit, with or without a model change: write your PR number in the `Model confirmed against the code in:` line, in the same commit.

The pstack `/maintain-formal-verification-skill` skill, where installed, brings the model back in line after changes that skipped this check.

## Scope

The check covers one workspace with one Stop of one kind and one backend restart while no Stop is in progress, so the Stop can come before the restart or during startup recovery. It allows at most 3 provider errors and a retry generation of at most 10. It treats `isStopInProgress` as the latch count of that workspace, and assumes the tail is interrupted at the restart, so startup recovery would resume it without a durable Stop record.

Startup recovery also runs without a restart, in a new session when a chat subscribes (`subscribeChat`, `agentSession.ts:2315`, and `src/node/orpc/routerSubscriptions.ts:529`), and `StartupRecovery` reruns its check after a deferred check or a failed read (`startupRecovery.ts:75`, `:93`). The model's one startup pass covers these runs: every rerun of the check captures a new retry generation and reads the handle again, and a new session reads the same disk state as a session after a restart.

For `turn`, the order in `interruptWorkspaceTurn` keeps the property: the handle write comes before the abandon. A startup recovery that reads the handle before the write meets the abandon after its read, which bumps its retry generation, and one that reads it after the write refuses. `turn` fails when the handle is written after the stream stop instead, when startup recovery does not read the handle, when it does not check its generation, when the abandon misses a session in its startup recovery, or when the interrupt ends at once for a handle that restart recovery settled. The repro tests in `stopEndsAutoRetry.repro.test.ts` that restart the backend fail without the handle read.

It leaves these out:

- User sends after the Stop. A user send re-enables auto-retry and retires the cancellation record, so a later retry is the user's choice.
- Other automatic turns: a goal's resume after a stream error, bash monitor wakes, queued sends, compaction follow-ups, and a sub-agent's startup recovery, which TaskService owns.
- Soft Stops (`soft: true`), session disposal, shutdown, and a second backend on the same `XUM_ROOT`.
- The first preference load from disk. The model assumes the preference is already loaded.
- A crash inside a Stop, and a second restart. A crash inside a turn interrupt keeps its handle, which it writes before it abandons or stops anything.
- A failed handle write (`workspaceTurnManager.ts:4038`). The write rejects before the interrupt abandons or stops anything, and the method-level `finally` drops the latch, so the interrupt fails and the turn keeps running and retrying. A handle that restart recovery settled keeps its outcome and that outcome's wake together ("a failed handle write keeps the restart outcome's wake").
- A failed execution-mirror write (`updateAgentTaskExecutionState`, after the handle write). It rejects the interrupt after the handle reads `interrupted` and before the abandon and the stream stop, and the method-level `finally` drops the latch. So the turn keeps running and retrying until the next restart, whose startup recovery reads the stopped handle and does not resume it.
- A rejected row read inside `latchUnlessSuperseded` (a throw, not an `Err`). The interrupt fails, and a rejected second read drops the latch it took ("a rejected second read leaves no stop latch behind").
- A stream error handled without a stream context (`activeStreamContext` unset). `handleStreamError` then passes no admission count, so `handleStreamFailureForAutoRetry` reads `autoRetryStops` when it is called, after the accounting awaits, and a Stop during those awaits is not seen.
- The startup abandon marker. No Stop kind in the model relies on it: ui and api rely on the opt-out and the cancellation record, turn on its handle.
- A tail whose retry user row carries no workspace-turn metadata, neither on the row nor, for a compaction row, on its follow-up. `startupWorkspaceTurnOutcome` then reads no handle, so it does not check for a Stop of that tail. A compaction row whose follow-up carries the turn counts as the turn's: the repro test "a restart after interrupting a turn whose tail is its automatic compaction does not resume it" fails without the follow-up read.
- A tail whose handle is missing, corrupt or written by a newer build. The handles live in the owner's session folder (`taskHandleStore.ts:590`), and removing the owner workspace deletes that folder (`workspaceService.ts:8176`). `getWorkspaceTurn` answers null for a record that fails the strict schema (`readWorkspaceTurnFile`, `taskHandleStore.ts:618`), and `isWorkspaceTurnStopped` (`workspaceTurnManager.ts:1154`) reads null as stopped. Startup recovery does not resume such a tail, also when the turn was not stopped. The repro test "a restart after the owner of a stopped turn was removed does not resume the turn" fails without it.
- A fork of a stopped turn's workspace whose owner was removed. The fork copies the chat (`workspaceService.ts:13779`), with the tail's workspace-turn metadata, but not the task handles, which live in the owner's folder. Its tail then reads no handle and stays stopped.
- A failed handle read. `startupWorkspaceTurnOutcome` returns `retryable` (`agentSession.ts:3554`), so startup recovery retries the read a bounded number of times and never resumes a tail whose handle it could not read.
- A turn that restart recovery settled whose row is no longer the one that auto-retry and startup recovery replay. The model has one tail, so the turn always owns that row. After a newer user message, a retry replays that message and not the turn, so `isSupersededRestartInterrupt` ends the interrupt and leaves the newer stream alone, without a latch or an epoch bump ("interrupting a turn that restart recovery settled leaves a newer prompt's stream running"). The interrupt reads the row once before it latches and once more under the latch. A send writes its row before its final admission, which the latch refuses. So a send that started before the latch shows in the second read: the interrupt drops its latch, bumps nothing and leaves that stream alone ("a user's send that starts between a turn interrupt's first read and its latch keeps streaming"). A send during the second read or the handle write is refused, never aborted ("a user's send during a turn interrupt's second read is refused, not aborted", "a user's send during a turn interrupt's handle write is refused, not aborted"). Rows that retry skips (a child's completed report, a goal-pause boundary, a snapshot, a hidden synthetic row, a context-budget warning) and a compaction request whose follow-up is the turn's, also a legacy `continueMessage` one, leave the turn the owner ("interrupting a turn that restart recovery settled stops it after $row"). A malformed compaction row does not fail the interrupt ("a malformed compaction request in a restart-settled turn's history does not fail the interrupt"). When the history read fails, the interrupt stops the workspace's work ("interrupting a turn that restart recovery settled stops it when its history cannot be read").
- A handle in `error` status. `interruptWorkspaceTurn` refuses it (`workspaceTurnManager.ts:683`), so `task_stop` reports an error and stops nothing.
- An `interrupted` handle with a supersede error. New input in its workspace replaced the turn, so the interrupt ends at once, also while that workspace still retries ("interrupting a superseded turn stays a no-op while its workspace still retries").
- A Stop, then a manual Retry of the stopped tail, then a crash. The handle stays `interrupted`, so the next start does not resume that turn. The user can retry it again by hand. The repro test "a crash after a manual retry of a stopped turn does not resume the turn" covers it.
- Three more callers of `handleStreamFailureForAutoRetry`, which the model has no steps for:
  - `sendCompactionRequest` (`agentSession.ts:7924`), when a mid-stream compaction's dispatch fails. A workspace-turn interrupt or a hard timeout does not cancel the compaction, so its latch refuses the dispatch with a retryable error. The call passes the interrupted stream's `admissionAutoRetryStops`, like `handleStreamError`. The test "a Stop during the mid-stream compaction dispatch arms no retry" in `src/node/services/agentSession.autoCompaction.test.ts` fails without it.
  - `settleRuntimeFailureWithoutErrorEvent` (`agentSession.ts:8794`), which `handleStreamWithHistoryFailure` calls, for a `runtime_not_ready` or `runtime_start_failed` failure without a pre-start error. An emergency context-window rollover produces one: its request preparation (`prepareContextRecovery`, `prepareRolloverRequest`) reports a failed runtime start only as its result, and a remote runtime reports an aborted start as `runtime_start_failed`. The call passes its turn's `admissionAutoRetryStops`. The test "a Stop during an emergency rollover's runtime start arms no retry" in `src/node/services/agentSession.pinnedBudget.test.ts` fails without it.
  - The turn-abort path (`agentSession.ts:10433`). It passes `aborted`, which `RetryManager` never schedules (`NON_RETRYABLE_STREAM_ERRORS` in `src/common/utils/messages/retryEligibility.ts`).
- Retries that should happen. The model checks safety only: `reachability.cfg` proves that a retry can start, but no property catches a retry that the code refuses wrongly. For example, an interrupt of a queued workspace turn must leave the running turn's retry alone, also when the running turn's error handling ends inside the interrupt's latch window. The repro test "interrupting a queued workspace turn leaves the running turn's retry armed" covers that case, not the model.
