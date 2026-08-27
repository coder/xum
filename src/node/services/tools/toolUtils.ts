import assert from "node:assert/strict";

import type { z } from "zod";

import { getErrorMessage } from "@/common/utils/errors";
import { WorkflowRunRecordSchema } from "@/common/orpc/schemas";
import type { WorkflowRunAttachedEvent } from "@/common/types/stream";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
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

// Bounded background retries for a transiently unreadable sidecar. The only natural re-record
// sites are a new dispatch and workflow_resume, which an untouched active run never hits, so
// giving up after one failed write would permanently supersede the run's terminal wake once
// storage recovers. Retries reuse the launch-time boundary snapshot: provenance describes the
// launch, not the retry moment.
const RECORD_REFERENCE_RETRY_DELAYS_MS: readonly number[] = [1_000, 10_000, 60_000];

function scheduleRecordReferenceRetry(input: {
  workspaceSessionDir: string;
  runId: string;
  createdAtMs: number;
  afterBoundaryMessageId: string | null | undefined;
  retryDelaysMs: readonly number[];
  attempt: number;
}): void {
  const delayMs = input.retryDelaysMs[input.attempt];
  if (delayMs == null) {
    log.error("Giving up on agent workflow run reference record after retries", {
      runId: input.runId,
      attempts: input.attempt,
    });
    return;
  }
  const timer = setTimeout(() => {
    // Detached by design: the launching tool already returned, so only this chain can finish
    // the write. Failures reschedule until the bounded delays are exhausted.
    void recordAgentWorkflowRunReference({
      workspaceSessionDir: input.workspaceSessionDir,
      runId: input.runId,
      createdAtMs: input.createdAtMs,
      ...(input.afterBoundaryMessageId !== undefined
        ? { afterBoundaryMessageId: input.afterBoundaryMessageId }
        : {}),
    }).catch((error: unknown) => {
      log.warn("Agent workflow run reference record retry failed", {
        runId: input.runId,
        attempt: input.attempt + 1,
        error: getErrorMessage(error),
      });
      scheduleRecordReferenceRetry({ ...input, attempt: input.attempt + 1 });
    });
  }, delayMs);
  timer.unref?.();
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
    scheduleRecordReferenceRetry({
      workspaceSessionDir,
      runId,
      createdAtMs,
      afterBoundaryMessageId,
      retryDelaysMs: retryDelaysMs ?? RECORD_REFERENCE_RETRY_DELAYS_MS,
      attempt: 0,
    });
  }
}
