---
name: formal-stop-retry
description: "Model-check (TLA+ with TLC) that a Stop ends the stream auto-retry loop, so no automatic retry starts a stopped workspace's turn again. Use when a change touches RetryManager, AgentSession's auto-retry or stream-error handling (handleStreamError, handleStreamFailureForAutoRetry, retryActiveStream, resumeStream), a Stop path (WorkspaceService/AgentSession interruptStream, TaskStopLatch, interruptWorkspaceTurn, failAgentTaskForHardTimeout), the stop latch or abandonAutoRetry, or the compaction cancellation record; run `make formal-check`."
---

# Formal check: a Stop ends the auto-retry loop

**Property.** After a Stop, the auto-retry loop never starts that workspace's turn again on its own, also not after a restart of the backend.

**Harm when broken.** The agent keeps calling the model and editing the checkout after the user stopped it.

Tests rarely reach the break. It needs a Stop to land while a stream error's handling, a retry backoff, or a fired retry's preflight is suspended at an await. The tests drive these steps one after another. The model checks every order of them, within the bounds under Scope. This check found three Stop paths that left a backoff armed, so the stopped workspace restarted after the Stop: a task Stop (a parent's Stop cascade, `task_stop` on a sub-agent, a failed launch), a workspace-turn interrupt, and a workflow step's hard timeout. It also found that a workspace-turn interrupt left nothing on disk, so startup recovery after a restart resumed the stopped turn. The repro tests in `src/node/services/stopEndsAutoRetry.repro.test.ts` replay those paths on the real ServiceContainer, and restart it on the same `XUM_ROOT` for the last one. They check the retry state itself, not elapsed time.

## Files

- `StopRetry.tla` is the model. Its comments map each action to its code.
- `ui.cfg`, `api.cfg`, `task.cfg`, `turn.cfg` and `timeout.cfg` each check the property for one Stop kind, with one restart of the backend before the Stop, during its startup recovery, or after the Stop ended:
  - `ui` is the renderer's Stop button, which passes `disableAutoRetry: true`.
  - `api` is a Stop without `disableAutoRetry`, such as an ACP client's cancel (`src/node/acp/agent.ts`) or an API call.
  - `task` is a `TaskStopLatch` stop: a parent's Stop cascade, `task_stop` on a sub-agent, a failed launch, a removal, or a terminal stream failure while work is live.
  - `turn` is a workspace-turn interrupt (`WorkspaceTurnManager.interruptWorkspaceTurn`, which `task_stop` runs for a workspace-turn ID). Its latch drops after its stream stop and cleanup, without waiting for the target's error handling. Before that it persists the startup abandon marker of the stopped tail, its only trace on disk.
  - `timeout` is a workflow step's hard timeout (`TaskService.failAgentTaskForHardTimeout`). It latches only when the task still has live work.
- `reachability.cfg` must fail. It proves that an auto-retry can start a turn at all, so a model change that makes retries unreachable cannot pass vacuously.
- `check.sh` runs every config and compares each result with its expected verdict. `make formal-check` runs it.

## Does my change touch the verified code?

`make formal-check` never reads `src/`. It checks the model only, so it checks a code change only after you change the model to match that code.

The sync commit is the last commit that changed the line below. Change that line only after you confirmed that the model describes the code at your commit, with or without a model change. A typo fix elsewhere in this folder does not move the sync commit. Main squash-merges PRs, so write the PR number, not a branch SHA, which would not survive the squash.

Model confirmed against the code in: #7898

| Model action | Code |
| --- | --- |
| `StreamErrors`, `PolicySettles` | `src/node/services/agentSession.ts` `handleStreamError` (entry, which keeps its turn's `activeStreamContext.admissionAutoRetryStops`, and tail), `src/node/services/turnCoordinator.ts` `consumeCompletion`. In the tail, `updateStartupAutoRetryAbandonFromFailure` clears the marker for a retryable error only while that count has not moved |
| `PolicyCaptures` | `handleStreamError` awaits `restoreGoalAccountingSnapshot` and `chargeEvaluatorSpendToGoal`, then calls `handleStreamFailureForAutoRetry`, which captures `isCurrent` |
| `PolicySchedules`, `RetryReschedules` (`MayArm`, `PolicyMayArm`) | `agentSession.ts` `handleStreamFailureForAutoRetry`: `compactionRecoveryBlocked`, the preference load, `isCurrent`, `autoRetryStops` (`handleStreamError` passes its turn's `admissionAutoRetryStops`), then `RetryManager.handleStreamFailure`. It does not read the stop latch: an interrupt of a queued workspace turn latches too |
| `RetryFires` | `src/node/services/retryManager.ts` `scheduleRetry` (the fiber's guards and `onRetry`), `agentSession.ts` `retryActiveStream` up to `resumeStream`, `resumeStream` up to `applyAutoRoutedResume` |
| `RetryRoutes` | `resumeStream`: the `isBusy` check |
| `RetryGate` | `resumeStream`: `captureCompactionReplacement`, `compactionRecoveryBlocked`, the pricing gate, the synchronous gate (`compactionStopGeneration`, the retry signal, `isStopInProgress`) and `coordinator.prepare`; the resumed turn's `admissionAutoRetryStops` (`streamWithHistory`) |
| `RetryReschedules` | `retryActiveStream`: its `handleStreamFailureForAutoRetry` calls after a resume that did not start or failed, and the `updateStartupAutoRetryAbandonFromFailure` call (behind `isCurrent`) before the second |
| `StopBegins` (ui, api) | `src/node/services/workspaceService.ts` `interruptStream` (`latchHardInterruptCascade`, the `setAutoRetryEnabled(false)` start); `agentSession.ts` `interruptStream` (`cancelCompaction`, `RetryManager.abandon`); `src/node/services/compactionCancellation.ts` `cancel`, `blocksRecovery`. The model reads the record (`cancelDebt`) in `MayArm` and in `RetryGate`, like the code's two `compactionRecoveryBlocked` calls. Either read alone keeps `api` holding: `api` fails only without both |
| `StopBegins` (task) | `src/node/services/taskStopLatch.ts` `beginWorkspaceStop`; callers in `src/node/services/taskService.ts`: `stopDescendantAgentTaskUnderLifecycleLock`, `terminateAllDescendantAgentTasks`, `terminateDescendantAgentTask`, `stopFailedTaskLaunch`, `failAgentTaskTerminally` |
| `StopBegins` (turn) | `src/node/services/workspaceTurnManager.ts` `interruptWorkspaceTurn`: `latchWorkspaceStopsInProgress`, then `abandonAutoRetry` when the handle owns the running turn (`shouldStopStream`). A queued handle latches too but abandons nothing. The model has no queued handle (see Scope) |
| `StopBegins` (timeout) | `taskService.ts` `failAgentTaskForHardTimeout`: `clearQueue`, `abandonAutoRetry` |
| `TurnRecords` | `interruptWorkspaceTurn`: `WorkspaceService.recordStopForStartupRecovery` after the stream stop, which adopts or creates the session (`getOrCreateSession`); `agentSession.ts` `recordStopForStartupRecovery`: `persistStartupAutoRetryAbandon("aborted", ...)` for the tail's retry user message, then a second `abandonAutoRetry`. `WorkspaceService.abandonAutoRetry` also reaches a session still in its startup recovery (`transientStartupRecoverySessions`) |
| `TurnStopReleases` | `interruptWorkspaceTurn`: `releaseStopLatch` in the method-level `finally` |
| `TimeoutFails` | `taskService.ts` `failAgentTaskTerminally`: `sampleLiveExecution`, then `beginWorkspaceStop` and the task cleanup, or nothing for an idle task |
| `TaskCleanupAbandons` | `taskStopLatch.ts` `runWorkspaceStopCleanup` and `retirePendingWork` (`clearQueue`, `abandonAutoRetry`); `abandonAutoRetry` in `agentSession.ts` counts `autoRetryStops` |
| `StopAbortsStream` | `agentSession.ts` `interruptStream` (`streamManager.stopStream`); `aiService.stopStream` in `runWorkspaceStopCleanup`, `interruptWorkspaceTurn` and `failAgentTaskForHardTimeout` |
| `StopJoinsPolicy` | `agentSession.ts` `interruptStream`: `interruptedPolicy` from `turnCoordinator.ts` `captureInterruptSettlement` |
| `StopReleases` | `workspaceService.ts` `interruptStream`: the opt-out join, then `releaseHardStopLatch` in the `finally` |
| `OptOutApplies` | `agentSession.ts` `applyAutoRetryEnabled` with `enabled: false` |
| `TaskStopReleases` | `taskStopLatch.ts` `recheckWorkspaceStopRelease` |
| `Restart` | A new backend on the same `XUM_ROOT`: `readAutoRetryState` loads the opt-out and the marker, `readCompactionCancellation` the cancellation record |
| `StartupBegins` | `workspaceService.ts` `initialize` (skips sub-agents, `SubAgent`) and `startStartupRecovery`; `agentSession.ts` `runStartupRecovery`: captures `autoRetryStops` before its first await, then the metadata read and the recovery steps before the check |
| `StartupSchedules` | `scheduleStartupAutoRetryIfNeeded`: captures the retry generation (`isCurrent`) before its first await |
| `StartupArms` | `scheduleStartupAutoRetryIfNeeded`: `compactionRecoveryBlocked`, the preference, a non-retryable marker that matches the tail, then `handleStreamFailureForAutoRetry` with `isCurrent` and the count from `runStartupRecovery` |

To see what changed in the covered files since the sync commit, uncommitted edits included, run:

```sh
sync=$(git log -1 --format=%H -G '^Model confirmed against the code in:' -- .xum/skills/formal-stop-retry/SKILL.md)
files="src/node/services/retryManager.ts src/node/services/agentSession.ts src/node/services/workspaceService.ts
  src/node/services/taskStopLatch.ts src/node/services/turnCoordinator.ts src/node/services/compactionCancellation.ts
  src/node/services/taskService.ts src/node/services/workspaceTurnManager.ts src/node/services/taskWorkspaceSeam.ts
  src/node/services/turnRequestBuilder.ts src/node/services/contextManagement/strategies/summarize.ts
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

It needs Java 11 or newer. The first run downloads the pinned `tla2tools.jar` (TLA+ tools 1.7.4) into `build/tla/`, which git ignores. Set `TLA2TOOLS_CACHE` to keep the jar in another folder, for example one that several checkouts share. Each config takes about a second. The script prints one line per config and ends with a count line:

```
config        result               expected              distinct generated   secs
reachability  NoRetryEverResumes   NoRetryEverResumes          28        43      1
ui            holds                holds                    23139     44483      1
api           holds                holds                    14985     26423      1
task          holds                holds                     9863     19159      1
turn          holds                holds                    31655     57139      1
timeout       holds                holds                    10204     19185      1
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

For `turn`, the record's second abandon keeps the property when the interrupt's first abandon lands before startup recovery begins and its record after that recovery armed a retry: without it, `turn` fails. Startup recovery's own count and generation checks are redundant in the model (it holds without them), because every `turn` Stop ends with the record. They still end the retry for an abandon whose record does not come. The repro test "a turn interrupt's startup record ends a retry that startup recovery armed after its abandon" fails without the second abandon, and "a Stop during startup recovery's first await keeps it from arming a retry", which abandons without a record, fails without the count check.

It leaves these out:

- User sends after the Stop. A user send re-enables auto-retry and retires the cancellation record, so a later retry is the user's choice.
- Other automatic turns: a goal's resume after a stream error, bash monitor wakes, queued sends, compaction follow-ups, and a sub-agent's startup recovery, which TaskService owns.
- Soft Stops (`soft: true`), session disposal, shutdown, and a second backend on the same `XUM_ROOT`.
- The first preference load from disk. The model assumes the preference is already loaded.
- A crash inside a Stop, and a second restart. A crash inside the Stop can lose the record that the Stop had not written yet.
- A failed write of the turn's record. `recordStopForStartupRecovery` retries the write once (`recordPendingAutoRetryState`) and only logs when it still fails, while a user Stop fails the Stop (`STOP_UNRECORDED_MESSAGE`). The interrupt already settled its handle, and an error would skip its callers' terminal-attention suppression.
- A stream error handled without a stream context (`activeStreamContext` unset). `handleStreamError` then passes no admission count, so `handleStreamFailureForAutoRetry` and the marker update read `autoRetryStops` when they are called, after the accounting awaits, and a Stop during those awaits is not seen.
- These marker clears:
  - `retryActiveStream` after a resume started (`agentSession.ts:2673`), left out because a resume that starts after the Stop is already a violation, and before the Stop the marker is unset.
  - `handleProviderConfigChanged` (`agentSession.ts:2911`), left out because it clears only a provider-config reason, never `aborted`.
  - A manual user send (`agentSession.ts:6492`), left out because user sends after the Stop are out of scope.
  - A stream that ends normally (`agentSession.ts:10561`), left out because the model has no normal stream end, and a turn that ended normally is not resumed.
- Three more callers of `handleStreamFailureForAutoRetry`, which the model has no steps for:
  - `sendCompactionRequest` (`agentSession.ts:7975`), when a mid-stream compaction's dispatch fails. A workspace-turn interrupt or a hard timeout does not cancel the compaction, so its latch refuses the dispatch with a retryable error. The call passes the interrupted stream's `admissionAutoRetryStops`, like `handleStreamError`. The test "a Stop during the mid-stream compaction dispatch arms no retry" in `src/node/services/agentSession.autoCompaction.test.ts` fails without it.
  - `settleRuntimeFailureWithoutErrorEvent` (`agentSession.ts:8847`), which `handleStreamWithHistoryFailure` calls, for a `runtime_not_ready` or `runtime_start_failed` failure without a pre-start error. An emergency context-window rollover produces one: its request preparation (`prepareContextRecovery`, `prepareRolloverRequest`) reports a failed runtime start only as its result, and a remote runtime reports an aborted start as `runtime_start_failed`. The call passes its turn's `admissionAutoRetryStops`. The test "a Stop during an emergency rollover's runtime start arms no retry" in `src/node/services/agentSession.pinnedBudget.test.ts` fails without it.
  - The turn-abort path (`agentSession.ts:10497`). It passes `aborted`, which `RetryManager` never schedules (`NON_RETRYABLE_STREAM_ERRORS` in `src/common/utils/messages/retryEligibility.ts`).
- Retries that should happen. The model checks safety only: `reachability.cfg` proves that a retry can start, but no property catches a retry that the code refuses wrongly. For example, an interrupt of a queued workspace turn must leave the running turn's retry alone, also when the running turn's error handling ends inside the interrupt's latch window. The repro test "interrupting a queued workspace turn leaves the running turn's retry armed" covers that case, not the model.
