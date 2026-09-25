// Shared fixtures for the workspaceGoalService.*.test.ts suites (split from workspaceGoalService.test.ts).
import * as path from "path";
import { expect, mock } from "bun:test";
import * as fs from "fs/promises";
import type { Config } from "@/node/config";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { WorkspaceGoalService} from "./workspaceGoalService";
import { type GoalContinuationRuntimeBridge } from "./workspaceGoalService";
import type { HistoryService } from "./historyService";
import type { GoalRecordV1 } from "@/common/types/goal";
import { createMuxMessage } from "@/common/types/message";

export function captureGoalActivity(service: WorkspaceGoalService) {
  const snapshots: Array<
    NonNullable<Awaited<ReturnType<ExtensionMetadataService["getSnapshot"]>>>
  > = [];
  service.setOnActivityChange((_workspaceId, snapshot) => snapshots.push(snapshot));
  return snapshots;
}

export async function setGoalOk(
  service: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await service.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

export async function appendUserHistoryMessage(
  historyService: HistoryService,
  workspaceId: string,
  text: string,
  metadata: Parameters<typeof createMuxMessage>[3] = { timestamp: Date.now() }
): Promise<void> {
  const result = await historyService.appendToHistory(
    workspaceId,
    createMuxMessage(`goal-test-user-${crypto.randomUUID()}`, "user", text, metadata)
  );
  expect(result.success).toBe(true);
}

export async function appendAssistantHistoryMessage(
  historyService: HistoryService,
  workspaceId: string,
  text: string,
  metadata: Parameters<typeof createMuxMessage>[3] = { timestamp: Date.now() }
): Promise<void> {
  const result = await historyService.appendToHistory(
    workspaceId,
    createMuxMessage(`goal-test-assistant-${crypto.randomUUID()}`, "assistant", text, metadata)
  );
  expect(result.success).toBe(true);
}

export async function getLastUserHistoryMessage(
  historyService: HistoryService,
  workspaceId: string
) {
  const history = await historyService.getLastMessages(workspaceId, 20);
  expect(history.success).toBe(true);
  if (!history.success) {
    throw new Error(history.error);
  }
  return [...history.data].reverse().find((message) => message.role === "user");
}

export const PROJECT_PATH = "/tmp/mux-goal-service-test-project";

export async function goalFileExists(config: Config, workspaceId: string): Promise<boolean> {
  try {
    await fs.access(path.join(config.sessionsDir, workspaceId, "goal.json"));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function analyticsMock() {
  return { recordGoalLifecycleEvent: mock(() => undefined) };
}

export function continuationBridge(
  executeGoalContinuation: GoalContinuationRuntimeBridge["executeGoalContinuation"] = () =>
    Promise.resolve(true)
): GoalContinuationRuntimeBridge {
  return {
    hasActiveDescendantTasks: () => false,
    getRuntimeState: () => ({ isRuntimeCompatible: true }),
    executeGoalContinuation,
  };
}
