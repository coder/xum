import assert from "node:assert/strict";
import * as path from "node:path";

import type { ProjectRef } from "@/common/types/workspace";
import { isSSHRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { PlatformPaths } from "@/common/utils/paths";
import {
  buildLegacyRemoteProjectLayout,
  buildRemoteProjectLayout,
  getRemoteWorkspacePath,
} from "@/node/runtime/remoteProjectLayout";
import type { RuntimeFactory } from "@/node/services/runtimeFactory/runtimeFactoryService";

export interface WorkspaceProjectRepo {
  projectPath: string;
  projectName: string;
  storageKey: string;
  repoCwd: string;
}

interface WorkspaceProjectRepoParams {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  projectPath: string;
  projectName?: string;
  projects?: ProjectRef[];
}

interface WorkspaceProjectStorageKeyParams {
  projectPath: string;
  projectName?: string;
  projects?: ProjectRef[];
}

export interface WorkspaceProjectStorageKey {
  projectPath: string;
  projectName: string;
  storageKey: string;
}

function sanitizeStorageKey(projectName: string, projectPath: string): string {
  const sanitize = (value: string) =>
    value
      .split("")
      .map((char) => {
        const isForbiddenPathChar = '<>:"/\\|?*'.includes(char);
        return isForbiddenPathChar || char.charCodeAt(0) < 32 ? "-" : char;
      })
      .join("")
      .trim();

  const sanitizedProjectName = sanitize(projectName);
  const fallbackProjectName =
    sanitize(PlatformPaths.getProjectName(projectPath).trim()) || "project";
  const storageKey =
    sanitizedProjectName.length > 0 && sanitizedProjectName !== "." && sanitizedProjectName !== ".."
      ? sanitizedProjectName
      : fallbackProjectName;

  assert(!path.isAbsolute(storageKey), "getWorkspaceProjectRepos: storageKey must stay relative");
  assert(
    !storageKey.includes(path.sep) && !storageKey.includes(path.posix.sep),
    "getWorkspaceProjectRepos: storageKey must not contain path separators"
  );
  assert(storageKey !== "." && storageKey !== "..", "getWorkspaceProjectRepos: invalid storageKey");

  return storageKey;
}

function appendStorageKeySuffix(storageKey: string, suffix: number): string {
  assert(Number.isInteger(suffix) && suffix >= 2, "appendStorageKeySuffix: suffix must be >= 2");
  return `${storageKey}-${suffix}`;
}

export function getWorkspaceProjectStorageKeys(
  params: WorkspaceProjectStorageKeyParams
): WorkspaceProjectStorageKey[] {
  assert(
    params.projectPath.trim().length > 0,
    "getWorkspaceProjectStorageKeys: projectPath must be non-empty"
  );

  const trimmedProjectName = params.projectName?.trim();
  const primaryProjectName =
    trimmedProjectName && trimmedProjectName.length > 0
      ? trimmedProjectName
      : PlatformPaths.getProjectName(params.projectPath).trim();
  assert(
    primaryProjectName.length > 0,
    "getWorkspaceProjectStorageKeys: primaryProjectName must be non-empty"
  );

  const orderedProjects =
    params.projects && params.projects.length > 0
      ? params.projects
      : ([
          {
            projectPath: params.projectPath,
            projectName: primaryProjectName,
          },
        ] satisfies ProjectRef[]);

  const expectedProjectCount =
    params.projects && params.projects.length > 0 ? params.projects.length : 1;
  assert(
    orderedProjects.length === expectedProjectCount,
    `getWorkspaceProjectStorageKeys: expected ${expectedProjectCount} projects, got ${orderedProjects.length}`
  );

  const usedStorageKeys = new Set<string>();
  const storageKeys = orderedProjects.map((project) => {
    const projectName = project.projectName.trim();
    assert(projectName.length > 0, "getWorkspaceProjectStorageKeys: projectName must be non-empty");

    const baseStorageKey = sanitizeStorageKey(projectName, project.projectPath);
    let storageKey = baseStorageKey;
    let suffix = 2;
    while (usedStorageKeys.has(storageKey)) {
      storageKey = appendStorageKeySuffix(baseStorageKey, suffix);
      suffix += 1;
    }
    usedStorageKeys.add(storageKey);

    return {
      projectPath: project.projectPath,
      projectName,
      storageKey,
    } satisfies WorkspaceProjectStorageKey;
  });

  assert(
    new Set(storageKeys.map((project) => project.storageKey)).size === storageKeys.length,
    "getWorkspaceProjectStorageKeys: storage keys must be unique after disambiguation"
  );

  return storageKeys;
}

export function getWorkspacePathHintForProject(
  params: WorkspaceProjectRepoParams,
  targetProjectPath: string
): string | undefined {
  if (!isSSHRuntime(params.runtimeConfig)) {
    return undefined;
  }

  const currentProjectRoot = path.posix.dirname(path.posix.normalize(params.workspacePath));
  const primaryLegacyLayout = buildLegacyRemoteProjectLayout(
    params.runtimeConfig.srcBaseDir,
    params.projectPath
  );
  if (currentProjectRoot === primaryLegacyLayout.projectRoot) {
    return getRemoteWorkspacePath(
      buildLegacyRemoteProjectLayout(params.runtimeConfig.srcBaseDir, targetProjectPath),
      params.workspaceName
    );
  }

  const primaryPreferredLayout = buildRemoteProjectLayout(
    params.runtimeConfig.srcBaseDir,
    params.projectPath
  );
  if (currentProjectRoot === primaryPreferredLayout.projectRoot) {
    return getRemoteWorkspacePath(
      buildRemoteProjectLayout(params.runtimeConfig.srcBaseDir, targetProjectPath),
      params.workspaceName
    );
  }

  return undefined;
}

export function getWorkspaceProjectRepos(
  params: WorkspaceProjectRepoParams & {
    /** Builds a multi-project checkout's runtime to find its path. Outside the loop: nodeRuntimeFactory. */
    runtimeFactory: RuntimeFactory;
  }
): WorkspaceProjectRepo[] {
  assert(
    params.workspaceId.trim().length > 0,
    "getWorkspaceProjectRepos: workspaceId must be non-empty"
  );
  assert(
    params.workspaceName.trim().length > 0,
    "getWorkspaceProjectRepos: workspaceName must be non-empty"
  );
  assert(
    params.workspacePath.trim().length > 0,
    "getWorkspaceProjectRepos: workspacePath must be non-empty"
  );
  assert(
    params.projectPath.trim().length > 0,
    "getWorkspaceProjectRepos: projectPath must be non-empty"
  );

  const projectStorageKeys = getWorkspaceProjectStorageKeys({
    projectPath: params.projectPath,
    projectName: params.projectName,
    projects: params.projects,
  });
  const isMultiProject = projectStorageKeys.length > 1;

  const repos = projectStorageKeys.map((project) => {
    const sshWorkspacePathHint = isMultiProject
      ? getWorkspacePathHintForProject(params, project.projectPath)
      : undefined;

    const repoCwd = !isMultiProject
      ? params.workspacePath
      : (sshWorkspacePathHint ??
        params.runtimeFactory
          .createRuntime(params.runtimeConfig, {
            projectPath: project.projectPath,
            workspaceName: params.workspaceName,
          })
          .getWorkspacePath(project.projectPath, params.workspaceName));

    assert(
      repoCwd.trim().length > 0,
      `getWorkspaceProjectRepos: repoCwd missing for ${project.projectName}`
    );

    return {
      projectPath: project.projectPath,
      projectName: project.projectName,
      storageKey: project.storageKey,
      repoCwd,
    } satisfies WorkspaceProjectRepo;
  });

  assert(
    new Set(repos.map((repo) => repo.storageKey)).size === repos.length,
    "getWorkspaceProjectRepos: storage keys must be unique after disambiguation"
  );

  return repos;
}
