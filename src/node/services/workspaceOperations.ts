import { ORPCError } from "@orpc/server";
import type { ORPCContext } from "@/node/orpc/context";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { ProjectRef } from "@/common/types/workspace";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  WorkspaceGoalChildWorkspaceError,
  WorkspaceGoalTransitionError,
} from "./workspaceGoalService";

export async function createMultiProjectWorkspace(
  context: ORPCContext,
  input: {
    projects: ProjectRef[];
    branchName: string;
    trunkBranch?: string;
    title?: string;
    runtimeConfig?: RuntimeConfig;
  }
) {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Multi-project workspaces experiment is disabled",
    });
  }
  const result = await context.workspaceService.createMultiProject(
    input.projects,
    input.branchName,
    input.trunkBranch,
    input.title,
    input.runtimeConfig
  );
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

export async function getWorkspacePlanContent(context: ORPCContext, workspaceId: string) {
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata)
    return { success: false as const, error: "Workspace not found: " + (workspaceId ?? "<none>") };
  const result = await readPlanFile(
    createRuntimeForWorkspace(metadata),
    metadata.name,
    metadata.projectName,
    workspaceId
  );
  return result.exists
    ? { success: true as const, data: { content: result.content, path: result.path } }
    : { success: false as const, error: "Plan file not found at " + result.path };
}

export async function getBackgroundBashOutput(
  context: ORPCContext,
  input: {
    workspaceId: string;
    processId: string;
    fromOffset?: number | null;
    tailBytes?: number | null;
  }
) {
  const result = await context.workspaceService.getBackgroundProcessOutput(
    input.workspaceId,
    input.processId,
    { fromOffset: input.fromOffset ?? undefined, tailBytes: input.tailBytes ?? undefined }
  );
  return result.success
    ? { success: true as const, data: result.data }
    : { success: false as const, error: result.error };
}

async function withGoalErrorTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof WorkspaceGoalTransitionError ||
      error instanceof WorkspaceGoalChildWorkspaceError
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: error.message,
        cause: error,
        data: { code: error.code },
      });
    }
    throw error;
  }
}

export async function getWorkspaceGoal(context: ORPCContext, workspaceId: string) {
  return {
    goal: (await context.workspaceService.getInfo(workspaceId))
      ? await context.workspaceGoalService.getGoal(workspaceId)
      : null,
  };
}
export async function setWorkspaceGoal(
  context: ORPCContext,
  input: Parameters<ORPCContext["workspaceGoalService"]["setGoal"]>[0]
) {
  if (!(await context.workspaceService.getInfo(input.workspaceId)))
    return {
      success: false as const,
      error: { type: "invalid_transition" as const, message: "Workspace not found." },
    };
  return context.workspaceGoalService.setGoal(input);
}
export async function clearWorkspaceGoal(context: ORPCContext, workspaceId: string) {
  if (!(await context.workspaceService.getInfo(workspaceId))) return { cleared: false };
  return { cleared: (await context.workspaceGoalService.clearGoal(workspaceId)) !== null };
}
export async function getWorkspaceGoalBoard(context: ORPCContext, workspaceId: string) {
  if (!(await context.workspaceService.getInfo(workspaceId))) return { entries: [] };
  return context.workspaceGoalService.getGoalBoard(workspaceId);
}
export function addUpcomingWorkspaceGoal(
  context: ORPCContext,
  input: {
    workspaceId: string;
    objective: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }
) {
  return withGoalErrorTranslation(() => context.workspaceGoalService.addUpcomingGoal(input));
}
export function archiveWorkspaceGoal(context: ORPCContext, workspaceId: string, goalId: string) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.archiveGoal(workspaceId, goalId)
  );
}
export function reviveArchivedWorkspaceGoal(
  context: ORPCContext,
  workspaceId: string,
  goalId: string
) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.reviveArchivedGoal(workspaceId, goalId)
  );
}
export function reorderUpcomingWorkspaceGoals(
  context: ORPCContext,
  workspaceId: string,
  upcomingIds: string[]
) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.reorderUpcomingGoals(workspaceId, upcomingIds)
  );
}
export function promoteUpcomingWorkspaceGoal(
  context: ORPCContext,
  workspaceId: string,
  goalId: string
) {
  return withGoalErrorTranslation(() =>
    context.workspaceGoalService.promoteUpcomingGoal(workspaceId, goalId)
  );
}
export function updateUpcomingWorkspaceGoal(
  context: ORPCContext,
  input: {
    workspaceId: string;
    goalId: string;
    objective?: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }
) {
  return withGoalErrorTranslation(() => context.workspaceGoalService.updateUpcomingGoal(input));
}
