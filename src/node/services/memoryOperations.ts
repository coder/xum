import { ORPCError } from "@orpc/server";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type * as schemas from "@/common/orpc/schemas";
import { getErrorMessage } from "@/common/utils/errors";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import type { ORPCContext } from "@/node/orpc/context";
import {
  parseMemoryPath,
  resolveMemoryProjectIdentity,
  type MemoryScopeContext,
} from "./memoryService";
import { memoryLogicalKey } from "./memoryMeta";

type MemoryContext = Pick<
  ORPCContext,
  | "experimentsService"
  | "workspaceService"
  | "memoryService"
  | "memoryMetaService"
  | "memoryConsolidationService"
>;
type Input<T extends { input: unknown }> = T["input"] extends { _input: infer I } ? I : never;

export function assertMemoryEnabled(context: MemoryContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MEMORY)) {
    throw new ORPCError("BAD_REQUEST", { message: "Agent memory is disabled" });
  }
}

async function resolveMemoryScopeContext(
  context: MemoryContext,
  workspaceId: string | null | undefined
): Promise<{ projectPath: string; scopeCtx: MemoryScopeContext } | null> {
  if (workspaceId == null)
    return {
      projectPath: "",
      scopeCtx: { runtime: null, checkoutCwd: "", workspaceId: "", projectPath: "" },
    };
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata) return null;
  const projectPath = resolveMemoryProjectIdentity(metadata);
  return {
    projectPath,
    scopeCtx: {
      runtime: createRuntimeForWorkspace(metadata),
      checkoutCwd: "",
      workspaceId,
      projectPath,
    },
  };
}

function workspaceNotFound(workspaceId: string | null | undefined): string {
  return "Workspace not found: " + (workspaceId ?? "<none>");
}

export async function listMemory(context: MemoryContext, input: Input<typeof schemas.memory.list>) {
  assertMemoryEnabled(context);
  const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
  if (!resolved) return { success: false as const, error: workspaceNotFound(input.workspaceId) };
  const entries = await context.memoryService.listIndexEntries(resolved.scopeCtx);
  const meta = await context.memoryMetaService.getEntries();
  const ids = { projectPath: resolved.projectPath, workspaceId: input.workspaceId ?? "" };
  return {
    success: true as const,
    data: {
      files: entries.map((entry) => {
        const stats = meta.get(memoryLogicalKey(entry.scope, entry.relPath, ids));
        return {
          path: entry.path,
          scope: entry.scope,
          description: entry.description,
          pinned: stats?.pinned ?? false,
          accessCount: stats?.accessCount ?? 0,
          lastAccessedAt: stats?.lastAccessedAt ?? null,
        };
      }),
    },
  };
}

export async function readMemory(context: MemoryContext, input: Input<typeof schemas.memory.read>) {
  assertMemoryEnabled(context);
  const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
  if (!resolved) return { success: false as const, error: workspaceNotFound(input.workspaceId) };
  return context.memoryService.readFileWithSha(resolved.scopeCtx, input.path);
}

export async function saveMemory(context: MemoryContext, input: Input<typeof schemas.memory.save>) {
  assertMemoryEnabled(context);
  const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
  if (!resolved)
    return {
      success: false as const,
      error: { kind: "error" as const, message: workspaceNotFound(input.workspaceId) },
    };
  return context.memoryService.saveFile(
    resolved.scopeCtx,
    input.path,
    input.content,
    input.expectedSha256,
    "user"
  );
}

export async function deleteMemory(
  context: MemoryContext,
  input: Input<typeof schemas.memory.delete>
) {
  assertMemoryEnabled(context);
  const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
  if (!resolved) return { success: false as const, error: workspaceNotFound(input.workspaceId) };
  const result = await context.memoryService.deletePath(resolved.scopeCtx, input.path, "user");
  return result.success
    ? { success: true as const, data: undefined }
    : { success: false as const, error: result.error };
}

export async function setMemoryPinned(
  context: MemoryContext,
  input: Input<typeof schemas.memory.setPinned>
) {
  assertMemoryEnabled(context);
  const resolved = await resolveMemoryScopeContext(context, input.workspaceId);
  if (!resolved) return { success: false as const, error: workspaceNotFound(input.workspaceId) };
  let parsed: ReturnType<typeof parseMemoryPath>;
  try {
    parsed = parseMemoryPath(input.path);
  } catch (error) {
    return { success: false as const, error: getErrorMessage(error) };
  }
  const { scope, relPath } = parsed;
  if (scope === null || relPath === "")
    return { success: false as const, error: "Cannot pin a directory: " + input.path };
  if (input.workspaceId == null && scope !== "global")
    return {
      success: false as const,
      error:
        (scope === "project" ? "Project" : "Workspace") +
        " memory is unavailable: no workspace is associated with this request",
    };
  if (scope === "project" && resolved.projectPath === "")
    return {
      success: false as const,
      error: "Project memory is unavailable: no project is associated with this session",
    };
  await context.memoryMetaService.setPinned(
    memoryLogicalKey(scope, relPath, {
      projectPath: resolved.projectPath,
      workspaceId: input.workspaceId ?? "",
    }),
    input.pinned
  );
  return { success: true as const, data: undefined };
}

export async function getMemoryConsolidationStatus(
  context: MemoryContext,
  input: Input<typeof schemas.memory.consolidationStatus>
) {
  assertMemoryEnabled(context);
  return {
    success: true as const,
    data: await context.memoryConsolidationService.getStatus(input.workspaceId),
  };
}

export async function consolidateMemory(
  context: MemoryContext,
  input: Input<typeof schemas.memory.consolidate>
) {
  assertMemoryEnabled(context);
  const result = await context.memoryConsolidationService.maybeRun(input.workspaceId, "manual");
  return result.success
    ? { success: true as const, data: result.data }
    : { success: false as const, error: result.error };
}
