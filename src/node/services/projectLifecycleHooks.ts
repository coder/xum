import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import { secretsToRecord } from "@/common/types/secrets";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import { shellQuote } from "@/common/utils/shell";
import {
  WORKSPACE_LIFECYCLE_HOOK_MAX_OUTPUT_BYTES,
  WORKSPACE_LIFECYCLE_HOOK_TIMEOUT_SECS,
} from "@/constants/workspaceHooks";
import type { Config, SecretsStore } from "@/node/config";
import { getRuntimeType, getXumEnv } from "@/node/runtime/initHook";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";
import { log } from "@/node/services/log";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import { getWorkspacePathHintForProject } from "@/node/services/workspaceProjectRepos";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { execBuffered } from "@/node/utils/runtime/helpers";

interface ProjectLifecycleHookOptions {
  hook: "archive" | "delete";
  workspaceId: string;
  workspacePath?: string;
  metadata?: WorkspaceMetadata & Partial<Pick<FrontendWorkspaceMetadata, "namedWorkspacePath">>;
  config: Config;
  secretsStore: Pick<SecretsStore, "getEffectiveSecrets">;
}

/** Run project cleanup before the lifecycle operation removes its checkout or stops its runtime. */
export async function runProjectLifecycleHook(options: ProjectLifecycleHookOptions): Promise<void> {
  if (projectAutomationDisabled()) return;

  try {
    const metadata =
      options.metadata ?? (await options.config.getWorkspaceMetadataById(options.workspaceId));
    if (!metadata || metadata.kind === "scratch" || metadata.taskIsolation === "none") return;
    if (
      options.hook === "archive" &&
      isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)
    ) {
      return;
    }
    const config = options.config.loadConfigOrDefault();
    if (!isWorkspaceTrustedForSharedExecution(metadata, config.projects)) return;

    const workspacePath = metadata.namedWorkspacePath ?? options.workspacePath;
    for (const project of getProjects(metadata)) {
      try {
        const runtime = createRuntime(metadata.runtimeConfig, {
          projectPath: project.projectPath,
          workspaceName: metadata.name,
          workspacePath:
            isMultiProject(metadata) && workspacePath != null
              ? getWorkspacePathHintForProject(
                  {
                    workspaceId: metadata.id,
                    workspaceName: metadata.name,
                    workspacePath,
                    runtimeConfig: metadata.runtimeConfig,
                    projectPath: metadata.projectPath,
                    projectName: metadata.projectName,
                    projects: metadata.projects,
                  },
                  project.projectPath
                )
              : workspacePath,
        });
        const abortSignal = AbortSignal.timeout(WORKSPACE_LIFECYCLE_HOOK_TIMEOUT_SECS * 1000);
        // A cleanup hook must not restart a stopped Coder workspace through an SSH connection.
        if (runtime.isRunningWithoutStart && !(await runtime.isRunningWithoutStart(abortSignal))) {
          continue;
        }
        const env = await secretsToRecord(
          options.secretsStore.getEffectiveSecrets(project.projectPath)
        );
        const candidates = listProjectMetadataRelativePaths(options.hook);
        // Execute only the preferred executable file. Missing hooks need no separate remote probe.
        const command =
          candidates
            .map((candidate, index) => {
              const hookPath = shellQuote(candidate);
              return `${index === 0 ? "if" : "elif"} [ -f ${hookPath} ] && [ -x ${hookPath} ]; then exec ${hookPath}`;
            })
            .join("; ") + "; fi";
        const result = await execBuffered(runtime, command, {
          cwd: isMultiProject(metadata)
            ? runtime.getWorkspacePath(project.projectPath, metadata.name)
            : resolveWorkspaceRootPath({ ...metadata, namedWorkspacePath: workspacePath }, runtime),
          env: {
            ...env,
            ...getXumEnv(
              project.projectPath,
              getRuntimeType(metadata.runtimeConfig),
              metadata.name,
              {
                workspaceId: metadata.id,
              }
            ),
          },
          timeout: WORKSPACE_LIFECYCLE_HOOK_TIMEOUT_SECS,
          abortSignal,
          forcePTY: true,
          maxOutputBytes: WORKSPACE_LIFECYCLE_HOOK_MAX_OUTPUT_BYTES,
        });
        if (result.exitCode !== 0) {
          log.warn("Project lifecycle hook failed", {
            workspaceId: metadata.id,
            projectPath: project.projectPath,
            hook: options.hook,
            exitCode: result.exitCode,
            stderr: result.stderr,
          });
        }
      } catch (error) {
        // Cleanup remains available when a hook fails or its checkout no longer exists.
        log.warn("Project lifecycle hook could not run", {
          workspaceId: metadata.id,
          projectPath: project.projectPath,
          hook: options.hook,
          error: getErrorMessage(error),
        });
      }
    }
  } catch (error) {
    log.warn("Project lifecycle hook setup failed", {
      workspaceId: options.workspaceId,
      hook: options.hook,
      error: getErrorMessage(error),
    });
  }
}
