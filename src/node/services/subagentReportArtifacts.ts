import * as fsPromises from "fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";

import { log } from "@/node/services/log";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

export interface SubagentReportArtifactsFile {
  version: 1;
  artifactsByChildTaskId: Record<string, SubagentReportArtifactIndexEntry>;
}

export interface SubagentReportArtifactIndexEntry {
  childTaskId: string;
  /** Immediate parent in the agent-task tree (matches WorkspaceConfigEntry.parentWorkspaceId). */
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Task-level model string used when running the sub-agent (optional for legacy entries). */
  model?: string;
  /** Task-level thinking/reasoning level used when running the sub-agent (optional for legacy entries). */
  thinkingLevel?: ThinkingLevel;
  title?: string;
  /** Full ancestor chain (parent first). Used for descendant scope checks after cleanup. */
  ancestorWorkspaceIds: string[];
  /** Ancestors for which this child is owned by a workflow step. */
  workflowOwnedAncestorWorkspaceIds?: string[];
  structuredOutput?: unknown;
  planFilePath?: string;
  /** Estimated token count of delivered report markdown (~4 chars/token). */
  reportTokenEstimate?: number;
  /**
   * The child's context carried project skill content when it reported
   * (classified at finalize, while its history still existed). Absent on
   * legacy entries: unknown, treated as carrying by readers.
   */
  carriesProjectSkillContent?: boolean;
}

export interface SubagentReportArtifact extends SubagentReportArtifactIndexEntry {
  reportMarkdown: string;
}

const SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION = 1 as const;

const SUBAGENT_REPORT_ARTIFACTS_FILE_NAME = "subagent-reports.json";
const SUBAGENT_REPORT_DIR_NAME = "subagent-reports";
const SUBAGENT_REPORT_FILE_NAME = "report.json";
export const CHARS_PER_TOKEN_ESTIMATE = 4;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function getSubagentReportArtifactsFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_REPORT_ARTIFACTS_FILE_NAME);
}

export function getSubagentReportArtifactPath(
  workspaceSessionDir: string,
  childTaskId: string
): string {
  return path.join(
    workspaceSessionDir,
    SUBAGENT_REPORT_DIR_NAME,
    childTaskId,
    SUBAGENT_REPORT_FILE_NAME
  );
}

export async function readSubagentReportArtifactsFile(
  workspaceSessionDir: string
): Promise<SubagentReportArtifactsFile> {
  try {
    const filePath = getSubagentReportArtifactsFilePath(workspaceSessionDir);
    const raw = await fsPromises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return { version: SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    const obj = parsed as {
      version?: unknown;
      artifactsByChildTaskId?: unknown;
    };

    if (obj.version !== SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION) {
      // Unknown version; treat as empty.
      return { version: SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    if (!obj.artifactsByChildTaskId || typeof obj.artifactsByChildTaskId !== "object") {
      return { version: SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    return {
      version: SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION,
      artifactsByChildTaskId: obj.artifactsByChildTaskId as Record<
        string,
        SubagentReportArtifactIndexEntry
      >,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    log.error("Failed to read subagent report artifacts file", { error });
    return { version: SUBAGENT_REPORT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
  }
}

export async function readSubagentReportArtifactIndexEntry(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<SubagentReportArtifactIndexEntry | null> {
  const file = await readSubagentReportArtifactsFile(workspaceSessionDir);
  return file.artifactsByChildTaskId[childTaskId] ?? null;
}

export async function readSubagentReportArtifact(
  workspaceSessionDir: string,
  childTaskId: string
): Promise<SubagentReportArtifact | null> {
  const meta = await readSubagentReportArtifactIndexEntry(workspaceSessionDir, childTaskId);

  const reportPath = getSubagentReportArtifactPath(workspaceSessionDir, childTaskId);
  try {
    const raw = await fsPromises.readFile(reportPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const obj = parsed as {
      childTaskId?: unknown;
      parentWorkspaceId?: unknown;
      createdAtMs?: unknown;
      updatedAtMs?: unknown;
      model?: unknown;
      thinkingLevel?: unknown;
      title?: unknown;
      ancestorWorkspaceIds?: unknown;
      workflowOwnedAncestorWorkspaceIds?: unknown;
      structuredOutput?: unknown;
      planFilePath?: unknown;
      carriesProjectSkillContent?: unknown;
      reportMarkdown?: unknown;
    };
    const carriesProjectSkillContent =
      typeof obj.carriesProjectSkillContent === "boolean"
        ? obj.carriesProjectSkillContent
        : undefined;

    const reportMarkdown = typeof obj.reportMarkdown === "string" ? obj.reportMarkdown : null;
    if (!reportMarkdown || reportMarkdown.length === 0) {
      return null;
    }

    const title = typeof obj.title === "string" ? obj.title : undefined;

    const planFilePath =
      typeof obj.planFilePath === "string" && obj.planFilePath.trim().length > 0
        ? obj.planFilePath.trim()
        : undefined;

    const model =
      typeof obj.model === "string" && obj.model.trim().length > 0 ? obj.model.trim() : undefined;
    const thinkingLevel = coerceThinkingLevel(obj.thinkingLevel);

    const workflowOwnedAncestorWorkspaceIds = isStringArray(obj.workflowOwnedAncestorWorkspaceIds)
      ? obj.workflowOwnedAncestorWorkspaceIds
      : undefined;

    if (meta) {
      // Trust the index file for metadata (versioned), but allow per-task file to override title.
      return {
        ...meta,
        model:
          typeof meta.model === "string" && meta.model.trim().length > 0
            ? meta.model.trim()
            : undefined,
        thinkingLevel: coerceThinkingLevel(meta.thinkingLevel),
        title: title ?? meta.title,
        structuredOutput: obj.structuredOutput,
        planFilePath: planFilePath ?? meta.planFilePath,
        ...((carriesProjectSkillContent ?? meta.carriesProjectSkillContent) !== undefined
          ? {
              carriesProjectSkillContent:
                carriesProjectSkillContent ?? meta.carriesProjectSkillContent,
            }
          : {}),
        reportMarkdown,
      };
    }

    // Self-healing: if the index entry is missing/corrupted, fall back to the per-task artifact.
    const parentWorkspaceId =
      typeof obj.parentWorkspaceId === "string" ? obj.parentWorkspaceId : null;
    const createdAtMs = typeof obj.createdAtMs === "number" ? obj.createdAtMs : null;
    const updatedAtMs = typeof obj.updatedAtMs === "number" ? obj.updatedAtMs : null;
    const ancestorWorkspaceIds = isStringArray(obj.ancestorWorkspaceIds)
      ? obj.ancestorWorkspaceIds
      : null;

    if (!parentWorkspaceId || !createdAtMs || !updatedAtMs || !ancestorWorkspaceIds) {
      return null;
    }

    return {
      childTaskId,
      parentWorkspaceId,
      createdAtMs,
      ...(carriesProjectSkillContent !== undefined ? { carriesProjectSkillContent } : {}),
      updatedAtMs,
      model,
      thinkingLevel,
      title,
      ancestorWorkspaceIds,
      workflowOwnedAncestorWorkspaceIds,
      structuredOutput: obj.structuredOutput,
      planFilePath,
      reportMarkdown,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    log.error("Failed to read subagent report artifact", { childTaskId, error });
    return null;
  }
}

export async function updateSubagentReportArtifactsFile(params: {
  workspaceId: string;
  workspaceSessionDir: string;
  update: (file: SubagentReportArtifactsFile) => void;
}): Promise<SubagentReportArtifactsFile> {
  return workspaceFileLocks.withLock(params.workspaceId, async () => {
    const file = await readSubagentReportArtifactsFile(params.workspaceSessionDir);
    params.update(file);

    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentReportArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent report artifacts file", { error });
    }

    return file;
  });
}

export async function upsertSubagentReportArtifact(params: {
  /** Workspace id that owns the session dir we're writing into (used for file locking). */
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  parentWorkspaceId: string;
  ancestorWorkspaceIds: string[];
  reportMarkdown: string;
  /** Task-level model string used when running the sub-agent (optional for legacy entries). */
  model?: string;
  /** Task-level thinking/reasoning level used when running the sub-agent (optional for legacy entries). */
  thinkingLevel?: ThinkingLevel;
  workflowOwnedAncestorWorkspaceIds?: string[];
  planFilePath?: string;
  structuredOutput?: unknown;
  title?: string;
  carriesProjectSkillContent?: boolean;
  nowMs?: number;
}): Promise<SubagentReportArtifactIndexEntry> {
  let updated: SubagentReportArtifactIndexEntry | null = null;

  await workspaceFileLocks.withLock(params.workspaceId, async () => {
    const nowMs = params.nowMs ?? Date.now();

    const model =
      typeof params.model === "string" && params.model.trim().length > 0
        ? params.model.trim()
        : undefined;
    const thinkingLevel = coerceThinkingLevel(params.thinkingLevel);

    const planFilePath =
      typeof params.planFilePath === "string" && params.planFilePath.trim().length > 0
        ? params.planFilePath.trim()
        : undefined;

    const file = await readSubagentReportArtifactsFile(params.workspaceSessionDir);
    const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
    const createdAtMs = existing?.createdAtMs ?? nowMs;

    // Write the report payload first so we never publish an index entry without a report body.
    const reportPath = getSubagentReportArtifactPath(
      params.workspaceSessionDir,
      params.childTaskId
    );
    try {
      await fsPromises.mkdir(path.dirname(reportPath), { recursive: true });
      await writeFileAtomic(
        reportPath,
        JSON.stringify(
          {
            childTaskId: params.childTaskId,
            parentWorkspaceId: params.parentWorkspaceId,
            createdAtMs,
            updatedAtMs: nowMs,
            model,
            thinkingLevel,
            title: params.title,
            ancestorWorkspaceIds: params.ancestorWorkspaceIds,
            workflowOwnedAncestorWorkspaceIds: params.workflowOwnedAncestorWorkspaceIds,
            planFilePath,
            structuredOutput: params.structuredOutput,
            carriesProjectSkillContent: params.carriesProjectSkillContent,
            reportMarkdown: params.reportMarkdown,
          },
          null,
          2
        )
      );
    } catch (error) {
      log.error("Failed to write subagent report artifact", {
        workspaceId: params.workspaceId,
        childTaskId: params.childTaskId,
        error,
      });
      return;
    }

    updated = {
      childTaskId: params.childTaskId,
      parentWorkspaceId: params.parentWorkspaceId,
      createdAtMs,
      updatedAtMs: nowMs,
      model,
      thinkingLevel,
      title: params.title,
      workflowOwnedAncestorWorkspaceIds: params.workflowOwnedAncestorWorkspaceIds,
      planFilePath,
      structuredOutput: params.structuredOutput,
      ancestorWorkspaceIds: params.ancestorWorkspaceIds,
      ...(params.carriesProjectSkillContent !== undefined
        ? { carriesProjectSkillContent: params.carriesProjectSkillContent }
        : {}),
    };
    updated.reportTokenEstimate = Math.ceil(
      params.reportMarkdown.length / CHARS_PER_TOKEN_ESTIMATE
    );
    file.artifactsByChildTaskId[params.childTaskId] = updated;

    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentReportArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent report artifacts file", { error });
    }
  });

  if (!updated) {
    throw new Error("upsertSubagentReportArtifact: failed to write report artifact");
  }

  return updated;
}
