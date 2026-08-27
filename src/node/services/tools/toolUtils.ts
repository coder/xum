import assert from "node:assert/strict";

import type { z } from "zod";

import { getErrorMessage } from "@/common/utils/errors";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import type { WorkflowRunAttachedEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import {
  SIDECAR_MAINTENANCE_RETRY_DELAYS_MS,
  recordAgentWorkflowRunReference,
  registerSidecarMaintenanceTimer,
  scheduleAgentWorkflowRunReferenceRecordRetry,
  takeSidecarMaintenanceTimer,
  trackSidecarMaintenanceWrite,
} from "@/node/services/agentWorkflowRunReferences";
import { log } from "@/node/services/log";
import type { TaskService } from "@/node/services/taskService";

export function requireWorkspaceId(config: ToolConfiguration, toolName: string): string {
  assert(config.workspaceId, `${toolName} requires workspaceId`);
  return config.workspaceId;
}

export function requireTaskService(config: ToolConfiguration, toolName: string): TaskService {
  assert(config.taskService, `${toolName} requires taskService`);
  return config.taskService;
}

export function parseToolResult<TSchema>(
  schema: z.ZodType<TSchema>,
  value: unknown,
  toolName: string
): TSchema {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${toolName} tool result validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

export function emitChatEventBestEffort(
  config: ToolConfiguration,
  event: WorkspaceChatMessage,
  context: string
): void {
  const emitted = config.emitChatEvent?.(event);
  if (emitted == null) {
    return;
  }

  emitted.catch((error: unknown) => {
    log.debug("Failed to emit tool chat event", {
      context,
      eventType: event.type,
      error: getErrorMessage(error),
    });
  });
}

export async function emitWorkflowRunAttachedEvent(input: {
  config: ToolConfiguration;
  workspaceId: string;
  toolCallId?: string;
  runId: string;
  run?: unknown;
}): Promise<void> {
  if (!input.config.emitChatEvent || !input.toolCallId) {
    return;
  }

  const parsedRun = WorkflowRunRecordSchema.safeParse(input.run);
  const event: WorkflowRunAttachedEvent = {
    type: "workflow-run-attached",
    workspaceId: input.workspaceId,
    toolCallId: input.toolCallId,
    runId: input.runId,
    ...(parsedRun.success ? { run: parsedRun.data } : {}),
    timestamp: Date.now(),
  };
  await input.config.emitChatEvent(event);
}

/**
 * Repair a missing boundary snapshot in the background. A kernel launch from a decision-free
 * history whose record-time boundary read failed persists a boundary-less entry, but the
 * decision-free currentness branch accepts only an explicit verified-empty (null) snapshot,
 * so without repair the run's terminal wake is permanently superseded once storage recovers.
 * Rows never disappear outside a full clear (which retires the sidecar), so a history still
 * verified-empty at repair time was also empty at launch and null is faithful launch
 * provenance; a decision row seen at repair time may postdate the launch, so persisting it
 * would overclaim currentness and the entry stays boundary-less (fail safe).
 */
function scheduleBoundarySnapshotRepair(input: {
  workspaceSessionDir: string;
  runId: string;
  createdAtMs: number;
  getBoundary: () => Promise<string | null>;
  retryDelaysMs?: readonly number[] | null;
  attempt?: number;
}): void {
  const retryDelaysMs = input.retryDelaysMs ?? SIDECAR_MAINTENANCE_RETRY_DELAYS_MS;
  const attempt = input.attempt ?? 0;
  const delayMs = retryDelaysMs[attempt];
  if (delayMs == null) {
    log.error("Giving up on workflow boundary snapshot repair after retries", {
      runId: input.runId,
      attempts: attempt,
    });
    return;
  }
  const key = `boundary:${input.runId}`;
  const timer = setTimeout(() => {
    if (!takeSidecarMaintenanceTimer(input.workspaceSessionDir, key, timer)) {
      return;
    }
    const work = (async () => {
      const boundary = await input.getBoundary();
      if (boundary !== null) {
        return;
      }
      await recordAgentWorkflowRunReference({
        workspaceSessionDir: input.workspaceSessionDir,
        runId: input.runId,
        createdAtMs: input.createdAtMs,
        afterBoundaryMessageId: null,
        onlyIfBoundaryAbsent: true,
      });
    })().catch((error: unknown) => {
      log.warn("Workflow boundary snapshot repair failed", {
        runId: input.runId,
        attempt: attempt + 1,
        error: getErrorMessage(error),
      });
      scheduleBoundarySnapshotRepair({ ...input, attempt: attempt + 1 });
    });
    trackSidecarMaintenanceWrite(input.workspaceSessionDir, work);
  }, delayMs);
  timer.unref?.();
  registerSidecarMaintenanceTimer(input.workspaceSessionDir, key, timer);
}

/**
 * Persist agent provenance for a workflow run that outlives the current turn (background
 * start/resume, or a foreground run that backgrounded itself). TaskService reads these
 * references back so the run stays rediscoverable and its terminal result re-engages the agent.
 * Best-effort by design: failing the tool would strand a run that already started successfully,
 * and the history scan fallback can still re-establish provenance for the current context epoch.
 */
export async function recordBackgroundWorkflowRunReference(
  config: ToolConfiguration,
  runId: string,
  createdAtMs: number,
  retryDelaysMs?: readonly number[] | null
): Promise<void> {
  const workspaceSessionDir = config.workspaceSessionDir;
  if (workspaceSessionDir == null || workspaceSessionDir.length === 0) {
    log.warn("Skipping agent workflow run reference without workspace session dir", { runId });
    return;
  }

  // Snapshot which invocation-decision row is newest at launch so the terminal-wake
  // currentness check compares row identity instead of wall-clock order, which clock
  // corrections can reorder (see WorkspaceService.isWorkflowInvocationCurrent). A history read
  // failure must not be persisted as a verified-empty boundary (null): record without the
  // field instead, so the run stays rediscoverable (listAgentReferencedWorkflowRunIds) and a
  // later workflow_resume re-record can repair provenance, while the unverifiable boundary
  // fails safe for wake delivery.
  let afterBoundaryMessageId: string | null | undefined;
  const taskService = config.taskService;
  if (config.workspaceId != null && taskService?.getWorkflowInvocationBoundaryMessageId != null) {
    try {
      afterBoundaryMessageId = await taskService.getWorkflowInvocationBoundaryMessageId(
        config.workspaceId,
        runId
      );
    } catch (error: unknown) {
      log.error("Failed to snapshot workflow invocation boundary for run reference", {
        runId,
        error: getErrorMessage(error),
      });
      const workspaceId = config.workspaceId;
      const getBoundaryMessageId =
        taskService?.getWorkflowInvocationBoundaryMessageId?.bind(taskService);
      if (workspaceId != null && getBoundaryMessageId != null) {
        scheduleBoundarySnapshotRepair({
          workspaceSessionDir,
          runId,
          createdAtMs,
          getBoundary: () => getBoundaryMessageId(workspaceId, runId),
          retryDelaysMs,
        });
      }
    }
  }

  try {
    await recordAgentWorkflowRunReference({
      workspaceSessionDir,
      runId,
      createdAtMs,
      ...(afterBoundaryMessageId !== undefined ? { afterBoundaryMessageId } : {}),
    });
  } catch (error: unknown) {
    log.warn("Failed to record agent workflow run reference", {
      runId,
      error: getErrorMessage(error),
    });
    scheduleAgentWorkflowRunReferenceRecordRetry({
      workspaceSessionDir,
      runId,
      createdAtMs,
      retryDelaysMs,
      ...(afterBoundaryMessageId !== undefined ? { afterBoundaryMessageId } : {}),
    });
  }
}
