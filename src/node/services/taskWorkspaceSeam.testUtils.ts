import type { AgentTaskIntegration } from "@/node/services/taskWorkspaceSeam";

interface AgentTaskIntegrationTestOverrides extends Partial<AgentTaskIntegration> {
  cleanupReportedDescendantsAfterArchive?: () => Promise<void>;
}

export function makeAgentTaskIntegrationFake(
  overrides: AgentTaskIntegrationTestOverrides = {}
): AgentTaskIntegration {
  return {
    withTaskTreeLifecycleLock: <T>(_workspaceId: string, operation: () => Promise<T>): Promise<T> =>
      operation(),
    hasDescendantAgentTasks: () => false,
    hasActiveDescendantAgentTasksForWorkspace: () => false,
    hasActiveTopLevelWorkflowRunsForWorkspace: () => Promise.resolve(false),
    getAgentTaskStatus: () => undefined,
    resetAutoResumeCount: () => undefined,
    backgroundForegroundWaitsForWorkspace: () => 0,
    markInterruptedTaskRunning: () => Promise.resolve(false),
    restoreInterruptedTaskAfterResumeFailure: () => Promise.resolve(),
    markParentWorkspaceInterrupted: () => undefined,
    latchHardInterruptCascade: () => undefined,
    terminateAllDescendantAgentTasks: () => Promise.resolve([]),
    ...overrides,
  };
}
