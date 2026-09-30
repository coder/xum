import * as fsPromises from "fs/promises";
import * as path from "node:path";

import writeFileAtomic from "@/node/utils/writeFileAtomic";

import type {
  SubagentGitPatchArtifact,
  SubagentGitProjectPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { log } from "@/node/services/log";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

export interface SubagentGitPatchArtifactsFile {
  version: 2;
  artifactsByChildTaskId: Record<string, SubagentGitPatchArtifact>;
}

interface LegacySubagentGitPatchArtifactV1 {
  childTaskId: string;
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs?: number;
  status: SubagentGitPatchArtifact["status"];
  baseCommitSha?: string;
  headCommitSha?: string;
  commitCount?: number;
  mboxPath?: string;
  error?: string;
  appliedAtMs?: number;
}

const SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION = 2 as const;

const SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_NAME = "subagent-patches.json";
const SUBAGENT_GIT_PATCH_DIR_NAME = "subagent-patches";
const SUBAGENT_GIT_PATCH_MBOX_FILE_NAME = "series.mbox";
const LEGACY_SINGLE_PROJECT_NAME = "project";
const LEGACY_SINGLE_PROJECT_PATH = "";
const LEGACY_SINGLE_PROJECT_STORAGE_KEY = "legacy-single-project";

export function isLegacySingleProjectArtifact(
  artifact: Pick<SubagentGitProjectPatchArtifact, "projectPath" | "storageKey">
): boolean {
  return (
    artifact.projectPath.length === 0 && artifact.storageKey === LEGACY_SINGLE_PROJECT_STORAGE_KEY
  );
}

export function matchesProjectArtifactProjectPath(
  artifact: Pick<SubagentGitProjectPatchArtifact, "projectPath" | "storageKey">,
  projectPath: string
): boolean {
  return artifact.projectPath === projectPath;
}

export function matchesProjectArtifactProjectPathForUpdate(
  artifact: Pick<SubagentGitProjectPatchArtifact, "projectPath" | "storageKey">,
  projectPath: string
): boolean {
  return artifact.projectPath === projectPath || isLegacySingleProjectArtifact(artifact);
}

export function isSafeSubagentGitPatchPathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    value !== "." &&
    value !== ".." &&
    !path.isAbsolute(value) &&
    !value.includes(path.sep) &&
    !value.includes(path.posix.sep) &&
    !value.includes("\\")
  );
}

function assertSafeSubagentGitPatchPathComponent(value: string, label: string): void {
  if (!isSafeSubagentGitPatchPathComponent(value)) {
    throw new Error(`${label} must be a safe path component`);
  }
}

function createEmptyArtifactsFile(): SubagentGitPatchArtifactsFile {
  return { version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
}

function summarizeProjectArtifacts(
  projectArtifacts: SubagentGitProjectPatchArtifact[]
): Pick<
  SubagentGitPatchArtifact,
  "status" | "readyProjectCount" | "failedProjectCount" | "skippedProjectCount" | "totalCommitCount"
> {
  const readyProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "ready"
  ).length;
  const failedProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "failed"
  ).length;
  const skippedProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "skipped"
  ).length;
  const pendingProjectCount = projectArtifacts.filter(
    (artifact) => artifact.status === "pending"
  ).length;
  const totalCommitCount = projectArtifacts.reduce(
    (sum, artifact) => sum + (artifact.commitCount ?? 0),
    0
  );

  if (projectArtifacts.length === 0) {
    return {
      status: "failed",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  if (pendingProjectCount > 0) {
    return {
      status: "pending",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  if (readyProjectCount > 0) {
    return {
      status: "ready",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  if (projectArtifacts.length > 0 && skippedProjectCount === projectArtifacts.length) {
    return {
      status: "skipped",
      readyProjectCount,
      failedProjectCount,
      skippedProjectCount,
      totalCommitCount,
    };
  }

  return {
    status: failedProjectCount > 0 ? "failed" : "skipped",
    readyProjectCount,
    failedProjectCount,
    skippedProjectCount,
    totalCommitCount,
  };
}

function normalizeProjectArtifacts(
  projectArtifacts: SubagentGitProjectPatchArtifact[]
): SubagentGitProjectPatchArtifact[] {
  const normalizedProjectArtifacts = projectArtifacts.map((artifact) => {
    const storageKey = (artifact.storageKey || artifact.projectName).trim();
    assertSafeSubagentGitPatchPathComponent(storageKey, "storageKey");
    return {
      ...artifact,
      projectName: artifact.projectName.trim(),
      storageKey,
    };
  });

  const storageKeys = normalizedProjectArtifacts.map((artifact) => artifact.storageKey);
  if (new Set(storageKeys).size !== storageKeys.length) {
    throw new Error(`normalizeProjectArtifacts: duplicate storage keys ${storageKeys.join(", ")}`);
  }

  return normalizedProjectArtifacts;
}

function normalizeLegacyArtifact(
  legacyArtifact: LegacySubagentGitPatchArtifactV1
): SubagentGitPatchArtifact {
  return normalizeSubagentGitPatchArtifact({
    childTaskId: legacyArtifact.childTaskId,
    parentWorkspaceId: legacyArtifact.parentWorkspaceId,
    createdAtMs: legacyArtifact.createdAtMs,
    updatedAtMs: legacyArtifact.updatedAtMs,
    status: legacyArtifact.status,
    projectArtifacts: [
      {
        projectPath: LEGACY_SINGLE_PROJECT_PATH,
        projectName: LEGACY_SINGLE_PROJECT_NAME,
        storageKey: LEGACY_SINGLE_PROJECT_STORAGE_KEY,
        status: legacyArtifact.status,
        baseCommitSha: legacyArtifact.baseCommitSha,
        headCommitSha: legacyArtifact.headCommitSha,
        commitCount: legacyArtifact.commitCount,
        mboxPath: legacyArtifact.mboxPath,
        error: legacyArtifact.error,
        appliedAtMs: legacyArtifact.appliedAtMs,
      },
    ],
    readyProjectCount: 0,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 0,
  });
}

export function normalizeSubagentGitPatchArtifact(
  artifact: SubagentGitPatchArtifact
): SubagentGitPatchArtifact {
  assertSafeSubagentGitPatchPathComponent(artifact.childTaskId, "childTaskId");
  const normalizedProjectArtifacts = normalizeProjectArtifacts(artifact.projectArtifacts);
  const summary = summarizeProjectArtifacts(normalizedProjectArtifacts);

  return {
    childTaskId: artifact.childTaskId,
    parentWorkspaceId: artifact.parentWorkspaceId,
    createdAtMs: artifact.createdAtMs,
    updatedAtMs: artifact.updatedAtMs,
    status: summary.status,
    projectArtifacts: normalizedProjectArtifacts,
    readyProjectCount: summary.readyProjectCount,
    failedProjectCount: summary.failedProjectCount,
    skippedProjectCount: summary.skippedProjectCount,
    totalCommitCount: summary.totalCommitCount,
  };
}

function normalizeArtifactsByChildTaskId(
  artifactsByChildTaskId: Record<string, unknown>,
  version: number | undefined
): Record<string, SubagentGitPatchArtifact> {
  const normalizedEntries: Array<readonly [string, SubagentGitPatchArtifact]> = [];

  for (const [childTaskId, artifact] of Object.entries(artifactsByChildTaskId)) {
    try {
      if (!artifact || typeof artifact !== "object") {
        throw new Error(`Invalid subagent git patch artifact for task ${childTaskId}`);
      }

      const normalizedArtifact =
        version === 1
          ? normalizeLegacyArtifact(artifact as LegacySubagentGitPatchArtifactV1)
          : normalizeSubagentGitPatchArtifact(artifact as SubagentGitPatchArtifact);

      normalizedEntries.push([childTaskId, { ...normalizedArtifact, childTaskId }] as const);
    } catch (error) {
      log.error("Skipping invalid subagent git patch artifact entry", {
        childTaskId,
        error,
      });
    }
  }

  return Object.fromEntries(normalizedEntries);
}

export function getSubagentGitPatchArtifactsFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_NAME);
}

export function getSubagentGitPatchTaskDir(
  workspaceSessionDir: string,
  childTaskId: string
): string {
  return path.join(workspaceSessionDir, SUBAGENT_GIT_PATCH_DIR_NAME, childTaskId);
}

export function getSubagentGitPatchProjectDir(
  workspaceSessionDir: string,
  childTaskId: string,
  storageKey: string
): string {
  return path.join(getSubagentGitPatchTaskDir(workspaceSessionDir, childTaskId), storageKey);
}

export function getSubagentGitPatchMboxPath(
  workspaceSessionDir: string,
  childTaskId: string,
  storageKey = LEGACY_SINGLE_PROJECT_STORAGE_KEY
): string {
  return path.join(
    getSubagentGitPatchProjectDir(workspaceSessionDir, childTaskId, storageKey),
    SUBAGENT_GIT_PATCH_MBOX_FILE_NAME
  );
}

export async function readSubagentGitPatchArtifactsFile(
  workspaceSessionDir: string
): Promise<SubagentGitPatchArtifactsFile> {
  try {
    const filePath = getSubagentGitPatchArtifactsFilePath(workspaceSessionDir);
    const raw = await fsPromises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return createEmptyArtifactsFile();
    }

    const obj = parsed as {
      version?: unknown;
      artifactsByChildTaskId?: unknown;
    };

    const version = typeof obj.version === "number" ? obj.version : undefined;
    const artifactsByChildTaskId = obj.artifactsByChildTaskId;

    if (version !== 1 && version !== SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION) {
      return createEmptyArtifactsFile();
    }

    if (!artifactsByChildTaskId || typeof artifactsByChildTaskId !== "object") {
      return createEmptyArtifactsFile();
    }

    return {
      version: SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION,
      artifactsByChildTaskId: normalizeArtifactsByChildTaskId(
        artifactsByChildTaskId as Record<string, unknown>,
        version
      ),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return createEmptyArtifactsFile();
    }

    log.error("Failed to read subagent git patch artifacts file", { error });
    return createEmptyArtifactsFile();
  }
}

export async function readSubagentGitPatchArtifact(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<SubagentGitPatchArtifact | null> {
  const file = await readSubagentGitPatchArtifactsFile(workspaceSessionDir);
  return file.artifactsByChildTaskId[childTaskId] ?? null;
}

export async function updateSubagentGitPatchArtifactsFile(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  update: (file: SubagentGitPatchArtifactsFile) => void;
}): Promise<SubagentGitPatchArtifactsFile> {
  return workspaceFileLocks.withLock(params.workspaceId, async () => {
    const file = await readSubagentGitPatchArtifactsFile(params.workspaceSessionDir);
    params.update(file);
    file.version = SUBAGENT_GIT_PATCH_ARTIFACTS_FILE_VERSION;
    file.artifactsByChildTaskId = Object.fromEntries(
      Object.entries(file.artifactsByChildTaskId).map(([childTaskId, artifact]) => [
        childTaskId,
        normalizeSubagentGitPatchArtifact({ ...artifact, childTaskId }),
      ])
    );
    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentGitPatchArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent git patch artifacts file", { error });
    }
    return file;
  });
}

export async function upsertSubagentGitPatchArtifact(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  updater: (existing: SubagentGitPatchArtifact | null) => SubagentGitPatchArtifact;
}): Promise<SubagentGitPatchArtifact> {
  let updated: SubagentGitPatchArtifact | null = null;

  await updateSubagentGitPatchArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      updated = normalizeSubagentGitPatchArtifact(params.updater(existing));
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  if (!updated) {
    throw new Error("upsertSubagentGitPatchArtifact: updater returned no artifact");
  }

  return updated;
}

export async function markSubagentGitPatchArtifactApplied(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  projectPath: string;
  appliedAtMs: number;
}): Promise<SubagentGitPatchArtifact | null> {
  let updated: SubagentGitPatchArtifact | null = null;

  await updateSubagentGitPatchArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      if (!existing) {
        updated = null;
        return;
      }

      updated = normalizeSubagentGitPatchArtifact({
        ...existing,
        updatedAtMs: params.appliedAtMs,
        projectArtifacts: existing.projectArtifacts.map((artifact) =>
          matchesProjectArtifactProjectPathForUpdate(artifact, params.projectPath)
            ? {
                ...artifact,
                appliedAtMs: params.appliedAtMs,
              }
            : artifact
        ),
      });
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  return updated;
}
