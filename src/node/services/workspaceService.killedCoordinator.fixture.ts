/**
 * Coordinator process for workspaceService.killedCoordinator.test.ts (run with `bun <this file>`,
 * never by the test runner): a real WorkspaceService creates an ordinary worktree workspace whose
 * registration-time plugin-override sanitization is forced to fail, so create() takes the real
 * rollback path — abortUnsanitizedCreation → WorktreeRuntime.deleteWorkspace → git — while it
 * holds the cross-process registration lock. The test holds that git child at a PATH-shim barrier
 * and SIGKILLs this process, orphaning the git child.
 *
 * argv: <rootDir> <projectPath> <mode>
 *   remove  — the checkout exists: the rollback runs `git worktree remove <checkout>`.
 *   prune   — the forced sanitize failure also deletes the checkout directory first, so the
 *             rollback's delete finds it missing and runs `git worktree prune`.
 */
import assert from "node:assert";
import { EventEmitter } from "node:events";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { Err, Ok } from "@/common/types/result";
import { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { HistoryService } from "@/node/services/historyService";
import { InitStateManager } from "@/node/services/initStateManager";
import { WorkspaceService } from "@/node/services/workspaceService";

export const KILLED_COORDINATOR_BRANCH = "ordinary";

async function main(): Promise<void> {
  const [rootDir, projectPath, mode] = process.argv.slice(2);
  assert(rootDir && projectPath, "usage: <rootDir> <projectPath> <remove|prune>");
  assert(mode === "remove" || mode === "prune", `unknown mode ${String(mode)}`);
  const config = new Config(rootDir);
  const historyService = new HistoryService(config);
  const aiService = Object.assign(new EventEmitter(), {
    isStreaming: () => false,
    stopStream: () => Promise.resolve(Ok(undefined)),
    getStreamInfo: () => undefined,
    replayStream: () => Promise.resolve(),
    getWorkspaceMetadata: async (workspaceId: string) => {
      const metadata = await config.getWorkspaceMetadataById(workspaceId);
      return metadata ? Ok(metadata) : Err(`Workspace not found: ${workspaceId}`);
    },
  }) as unknown as AIService;
  const service = new WorkspaceService(
    config,
    historyService,
    aiService,
    new ContextManagementService({ config, historyService, aiService }),
    new InitStateManager(config),
    new ExtensionMetadataService(path.join(rootDir, "extension-metadata.json")),
    new BackgroundProcessManager(path.join(rootDir, "bg"))
  );
  // Fault injection: the registration-time sanitization refuses, so create() rolls back.
  (
    service as unknown as {
      sanitizeStalePluginOverridesForNewWorkspace: (
        workspaceId: string,
        workspacePath: string
      ) => Promise<string | undefined>;
    }
  ).sanitizeStalePluginOverridesForNewWorkspace = async (_workspaceId, workspacePath) => {
    if (mode === "prune") await fsPromises.rm(workspacePath, { recursive: true, force: true });
    return "killed-coordinator fixture: sanitization refused";
  };
  const result = await service.create(
    projectPath,
    KILLED_COORDINATOR_BRANCH,
    "main",
    undefined,
    { type: "worktree", srcBaseDir: config.srcDir },
    undefined,
    undefined,
    undefined,
    { awaitMaterialization: true }
  );
  // Reached only when the test lets the coordinator finish (it normally SIGKILLs it first).
  process.stdout.write(`${JSON.stringify({ success: result.success })}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
