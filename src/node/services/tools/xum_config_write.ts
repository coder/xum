import { isDeepStrictEqual } from "node:util";

import { tool } from "ai";

import { CONFIG_FILE_REGISTRY } from "@/common/config/schemaRegistry";
import type { XumConfigWriteToolArgs, XumConfigWriteToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  withProjectRegistrationFileLock,
  type ProjectRegistrationLockHandle,
} from "@/node/config/projectRegistrationLock";
import { applyMutations } from "@/node/services/tools/shared/configMutationEngine";
import { REDACTED_SECRET_VALUE } from "@/node/services/tools/shared/configRedaction";
import {
  readConfigDocumentUnvalidated,
  writeConfigDocument,
} from "@/node/services/tools/shared/configReadWrite";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

/** Recursively check if any value in the tree is the redaction sentinel placeholder. */
function containsRedactedSentinel(value: unknown): boolean {
  if (value === REDACTED_SECRET_VALUE) return true;
  if (Array.isArray(value)) return value.some(containsRedactedSentinel);
  if (value != null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsRedactedSentinel);
  }
  return false;
}

function agentSandboxOf(value: unknown): unknown {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).agentSandbox
    : undefined;
}

/**
 * Each project's agentSandbox values, keyed the way Config loads project paths, so an alias of
 * a path ("/repo/") cannot replace the setting of "/repo". A key whose entries have no value
 * maps to [], so adding or removing a project without a setting changes nothing.
 */
function projectAgentSandboxes(document: unknown): Map<string, unknown[]> {
  const projects = (document as { projects?: unknown } | null)?.projects;
  const byProject = new Map<string, unknown[]>();
  if (!Array.isArray(projects)) return byProject;
  for (const entry of projects) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const key = stripTrailingSlashes(entry[0] === "" ? "/" : entry[0]);
    byProject.set(key, [...(byProject.get(key) ?? []), agentSandboxOf(entry[1])]);
  }
  for (const [key, values] of byProject) {
    if (values.every((value) => value === undefined)) byProject.set(key, []);
  }
  return byProject;
}

/** Whether `next` changes agentSandbox by value, globally or in any project (added, edited or removed). */
export function changesAgentSandbox(current: unknown, next: unknown): boolean {
  if (!isDeepStrictEqual(agentSandboxOf(current), agentSandboxOf(next))) return true;
  const before = projectAgentSandboxes(current);
  const after = projectAgentSandboxes(next);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (!isDeepStrictEqual(before.get(key) ?? [], after.get(key) ?? [])) return true;
  }
  return false;
}

export const createXumConfigWriteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.mux_config_write.description,
    inputSchema: TOOL_DEFINITIONS.mux_config_write.schema,
    execute: async (
      args: XumConfigWriteToolArgs,
      { abortSignal: _abortSignal }
    ): Promise<XumConfigWriteToolResult> => {
      try {
        if (!args.confirm) {
          return {
            success: false,
            error:
              "Refusing to write mux config without confirm: true. Ask the user for confirmation first.",
          };
        }

        if (args.operations.some((op) => op.op === "set" && containsRedactedSentinel(op.value))) {
          return {
            success: false,
            error:
              "Refusing to write redacted placeholder values ([REDACTED]). " +
              "Re-read the config to get current values or omit secret fields from your operations.",
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        const xumHome = config.xumScope!.xumHome;
        const registryEntry = CONFIG_FILE_REGISTRY[args.file];
        const rewrite = async (
          lock: ProjectRegistrationLockHandle | null
        ): Promise<XumConfigWriteToolResult> => {
          const currentDocument = await readConfigDocumentUnvalidated(xumHome, args.file);
          const mutationResult = applyMutations(
            currentDocument,
            args.operations,
            registryEntry.schema,
            { rootContainer: registryEntry.rootContainer }
          );

          if (!mutationResult.success) {
            return {
              success: false,
              error: mutationResult.error,
              validationIssues: mutationResult.validationIssues?.map((issue) => ({
                path: issue.path.filter(
                  (segment): segment is string | number => typeof segment !== "symbol"
                ),
                message: issue.message,
              })),
            };
          }

          // The sandbox confines the agent, so the agent must not be able to turn it off.
          if (changesAgentSandbox(currentDocument, mutationResult.document)) {
            return {
              success: false,
              error: "Refusing to change agentSandbox. Only the user can change it in Settings.",
            };
          }

          await lock?.assertStillOwned();
          await writeConfigDocument(xumHome, args.file, mutationResult.document);
          return {
            success: true,
            file: args.file,
            appliedOps: mutationResult.appliedOps,
            summary: `Applied ${mutationResult.appliedOps} operation(s) to ${args.file}`,
          };
        };
        // config.json carries the project set, and this rewrites the whole document from the
        // bytes it read: like every Config.editConfig save it has to happen under the project
        // registration lock, or a value-only edit here would drop a project a settings-backup
        // import registered meanwhile, or change registrations while the import writes that
        // project's memory (see projectRegistrationLock.ts). Read and written under one hold,
        // verified immediately before the write.
        const result =
          args.file === "config"
            ? await withProjectRegistrationFileLock(xumHome, rewrite)
            : await rewrite(null);
        if (result.success) {
          // Notify services that config has changed (triggers hot-reload for providers)
          config.onConfigChanged?.();
        }
        return result;
      } catch (error) {
        const message = getErrorMessage(error);
        return {
          success: false,
          error: `Failed to write mux config (${args.file}): ${message}`,
        };
      }
    },
  });
};
