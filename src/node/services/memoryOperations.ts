import { ORPCError } from "@orpc/server";
import { Effect, Result } from "effect";
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

/**
 * Effect-migration spike: `setMemoryPinned` converted to `Effect.gen`. The
 * wire contract (ResultSchema(z.void(), z.string())) is unchanged; the router
 * runs this via `handlerGen`, and the Promise wrapper below keeps pre-Effect
 * callers (tests) working. Sidecar write failures arrive as the typed
 * `MemoryMetaWriteError` and are mapped to the legacy string error channel
 * instead of escaping as an untyped INTERNAL_SERVER_ERROR rejection.
 */
export function setMemoryPinnedEffect(
  context: MemoryContext,
  input: Input<typeof schemas.memory.setPinned>
): Effect.Effect<{ success: true; data: undefined } | { success: false; error: string }> {
  return Effect.gen(function* () {
    // Sync ORPCError throw stays a runtime defect and reaches the client as
    // the same BAD_REQUEST it does today from async handlers.
    assertMemoryEnabled(context);
    const resolved = yield* Effect.promise(() =>
      resolveMemoryScopeContext(context, input.workspaceId)
    );
    if (!resolved) return { success: false as const, error: workspaceNotFound(input.workspaceId) };
    const parsedResult = yield* Effect.result(
      Effect.try({
        try: () => parseMemoryPath(input.path),
        catch: (error) => getErrorMessage(error),
      })
    );
    if (Result.isFailure(parsedResult))
      return { success: false as const, error: parsedResult.failure };
    const { scope, relPath } = parsedResult.success;
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
    return yield* context.memoryMetaService.effects
      .setPinned(
        memoryLogicalKey(scope, relPath, {
          projectPath: resolved.projectPath,
          workspaceId: input.workspaceId ?? "",
        }),
        input.pinned
      )
      .pipe(
        Effect.map(() => ({ success: true as const, data: undefined })),
        Effect.catchTag("MemoryMetaWriteError", (error) =>
          Effect.succeed({
            success: false as const,
            error: `Failed to persist pin state: ${error.reason}`,
          })
        )
      );
  });
}

/** Promise facade over {@link setMemoryPinnedEffect} for pre-Effect callers. */
export async function setMemoryPinned(
  context: MemoryContext,
  input: Input<typeof schemas.memory.setPinned>
) {
  return Effect.runPromise(setMemoryPinnedEffect(context, input));
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
