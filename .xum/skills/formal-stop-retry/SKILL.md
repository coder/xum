---
name: formal-stop-retry
description: "Model-check (TLA+ with TLC) that a Stop ends the stream auto-retry loop, so no automatic retry starts a stopped workspace's turn again. Use when a change touches RetryManager, AgentSession's auto-retry or stream-error handling (handleStreamError, handleStreamFailureForAutoRetry, retryActiveStream, resumeStream), a Stop path (WorkspaceService/AgentSession interruptStream, TaskStopLatch), isStopInProgress, or the compaction cancellation record; run `make formal-check`."
---

# Formal check: a Stop ends the auto-retry loop

**Property.** After a Stop, the auto-retry loop never starts that workspace's turn again on its own.

**Harm when broken.** The agent keeps calling the model and editing the checkout after the user stopped it.

Tests rarely reach the break. It needs a Stop to land while a stream error's handling, a retry backoff, or a fired retry's preflight is suspended at an await. The tests drive these steps one after another. The model checks every order of them, within the bounds under Scope. This check found that a task Stop (a parent's Stop cascade, `task_stop`, a failed launch) left a sub-agent's backoff armed, so the sub-agent restarted after the stop latch dropped. Two repro tests in `src/node/services/stopEndsAutoRetry.repro.test.ts` replay that path on the real ServiceContainer.

## Files

- `StopRetry.tla` is the model. Its comments map each action to its code.
- `ui.cfg`, `api.cfg` and `task.cfg` each check the property for one Stop kind:
  - `ui` is the renderer's Stop button, which passes `disableAutoRetry: true`.
  - `api` is a Stop without `disableAutoRetry`, such as an ACP client's cancel (`src/node/acp/agent.ts`) or an API call.
  - `task` is a `TaskStopLatch` stop: a parent's Stop cascade, `task_stop`, or a failed launch.
- `reachability.cfg` must fail. It proves that an auto-retry can start a turn at all, so a model change that makes retries unreachable cannot pass vacuously.
- `check.sh` runs every config and compares each result with its expected verdict. `make formal-check` runs it.

## Does my change touch the verified code?

The model was last confirmed against the code at sync commit `d2776abfa7671bd2c44924537b17ffb46e845838`.

| Model action | Code |
| --- | --- |
| `StreamErrors`, `PolicySettles` | `src/node/services/agentSession.ts` `handleStreamError` (entry and tail), `src/node/services/turnCoordinator.ts` `consumeCompletion` |
| `PolicyCaptures` | `handleStreamError` awaits `restoreGoalAccountingSnapshot` and `chargeEvaluatorSpendToGoal`, then calls `handleStreamFailureForAutoRetry`, which captures `isCurrent` |
| `PolicySchedules`, `RetryReschedules` (`MayArm`) | `agentSession.ts` `handleStreamFailureForAutoRetry`: `compactionRecoveryBlocked`, the preference load, `isCurrent`, `isStopInProgress`, then `RetryManager.handleStreamFailure` |
| `RetryFires` | `src/node/services/retryManager.ts` `scheduleRetry` (the fiber's guards and `onRetry`), `agentSession.ts` `retryActiveStream` up to `resumeStream`, `resumeStream` up to `applyAutoRoutedResume` |
| `RetryRoutes` | `resumeStream`: the `isBusy` check |
| `RetryGate` | `resumeStream`: `captureCompactionReplacement`, `compactionRecoveryBlocked`, the pricing gate, the synchronous gate (`compactionStopGeneration`, the retry signal, `isStopInProgress`) and `coordinator.prepare` |
| `RetryReschedules` | `retryActiveStream`: its `handleStreamFailureForAutoRetry` calls after a resume that did not start or failed |
| `StopBegins` (ui, api) | `src/node/services/workspaceService.ts` `interruptStream` (`latchHardInterruptCascade`, the `setAutoRetryEnabled(false)` start); `agentSession.ts` `interruptStream` (`cancelCompaction`, `RetryManager.abandon`); `src/node/services/compactionCancellation.ts` `cancel`, `blocksRecovery` |
| `StopBegins` (task) | `src/node/services/taskStopLatch.ts` `beginWorkspaceStop`; callers in `src/node/services/taskService.ts`: `stopDescendantAgentTaskUnderLifecycleLock`, `terminateAllDescendantAgentTasks`, `stopFailedTaskLaunch` |
| `TaskCleanupAbandons` | `taskStopLatch.ts` `runWorkspaceStopCleanup` and `retirePendingWork` (`clearQueue`, `abandonAutoRetry`) |
| `StopAbortsStream` | `agentSession.ts` `interruptStream` (`streamManager.stopStream`); `runWorkspaceStopCleanup` (`aiService.stopStream`) |
| `StopJoinsPolicy` | `agentSession.ts` `interruptStream`: `interruptedPolicy` from `turnCoordinator.ts` `captureInterruptSettlement` |
| `StopReleases` | `workspaceService.ts` `interruptStream`: the opt-out join, then `releaseHardStopLatch` in the `finally` |
| `OptOutApplies` | `agentSession.ts` `applyAutoRetryEnabled` with `enabled: false` |
| `TaskStopReleases` | `taskStopLatch.ts` `recheckWorkspaceStopRelease` |

To list the commits since the sync commit that touched these files, run:

```sh
git log --oneline d2776abfa7671bd2c44924537b17ffb46e845838..HEAD -- src/node/services/retryManager.ts src/node/services/agentSession.ts src/node/services/workspaceService.ts src/node/services/taskStopLatch.ts src/node/services/turnCoordinator.ts src/node/services/compactionCancellation.ts src/node/services/taskService.ts
```

`agentSession.ts`, `workspaceService.ts` and `taskService.ts` change often. Read the diff of the functions in the table, not only the file list. When a change adds an await inside a row, adds a new caller of `handleStreamFailureForAutoRetry` or `RetryManager.handleStreamFailure`, adds a new Stop path, or moves a check across an await, the model needs another look.

## Run it

```sh
make formal-check
```

It needs Java 11 or newer. The first run downloads the pinned `tla2tools.jar` (TLA+ tools 1.7.4) into `build/tla/`, which git ignores. Each config takes about a second. The script prints one line per config and ends with a count line:

```
config        result               expected              distinct generated   secs
reachability  NoRetryEverResumes   NoRetryEverResumes          12        14      1
ui            holds                holds                     3200      5905      1
api           holds                holds                     2165      3610      1
task          holds                holds                     3000      5598      1
formal-stop-retry: 4 of 4 configs as expected
```

It exits 0 when every config matches, 1 when one does not, and 2 when Java or the jar is missing. To check one config, run `.xum/skills/formal-stop-retry/check.sh task`. Set `FORMAL_OUT` to keep the TLC logs in a folder of your choice.

## Read a failure

Read every TLC result with the pstack `/statechart` skill. Give it `StopRetry.tla` and the failing config. It shows each violation as its shortest path in plain words, and when the check passes it draws how a workspace moves between states. A violation of `StopEndsRetries` ends in a `RetryGate` step that starts a turn after the Stop began.

Then decide whether it is a real bug or a modeling error:

1. Replay the path in the real code, one step per action. Use the repro tests as the template: the real ServiceContainer from `tests/ipc/setup`, a mock language model whose first stream fails, and a spy that holds the await the path suspends at (`restoreGoalAccountingSnapshot` for `PolicyCaptures`). Count the provider requests after the Stop.
2. If the replay restarts the stopped workspace, it is a bug. Keep the test, fix the code, and do not weaken the property.
3. If the replay does not restart it, assume the model is wrong until you find the guard it misses. The first version of this model missed the compaction cancellation record. A ui or api Stop's `cancelCompaction` publishes that record, and it blocks every automatic recovery until a user send replaces it. The model reported a false bug for `api` until it gained `cancelDebt`.

## Change the model

When a change to the code above is intended:

1. Edit the action that stands for the changed code. Keep one action per stretch of code between two awaits that can yield (I/O, an IPC call, a timer). A microtask-only await does not split an action.
2. If the change adds a Stop path, add a Stop kind and a config with its own expected verdict in `check.sh`.
3. Run `make formal-check`. Then break the change on purpose in the real code and in the model, check that a config fails, and revert both.
4. Move the sync commit forward only after you have confirmed that the model describes the code at the new commit.

The pstack `/maintain-formal-verification-skill` skill brings the model back in line after changes that skipped this check.

## Scope

The check covers one workspace with one Stop of one kind, at most 3 provider errors, and a retry generation of at most 10. It treats `isStopInProgress` as the latch count of that workspace.

It leaves these out:

- User sends after the Stop. A user send re-enables auto-retry and retires the cancellation record, so a later retry is the user's choice.
- Other automatic turns: a goal's resume after a stream error, bash monitor wakes, queued sends, startup recovery's own scheduling, and compaction follow-ups.
- Soft Stops (`soft: true`), session disposal, shutdown, and a second backend on the same `XUM_ROOT`.
- The first preference load from disk. The model assumes the preference is already loaded.
- A hard-timeout task failure (`TaskService.failAgentTaskForHardTimeout`), which stops the stream without a `TaskStopLatch` stop.
