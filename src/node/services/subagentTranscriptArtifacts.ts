import * as fsPromises from "fs/promises";
import * as path from "node:path";

import writeFileAtomic from "@/node/utils/writeFileAtomic";

import type { ThinkingLevel } from "@/common/types/thinking";

import { log } from "@/node/services/log";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";

export interface SubagentTranscriptArtifactsFile {
  version: 1;
  artifactsByChildTaskId: Record<string, SubagentTranscriptArtifactIndexEntry>;
}

export interface SubagentTranscriptArtifactIndexEntry {
  childTaskId: string;
  /** Immediate parent in the agent-task tree (matches WorkspaceConfigEntry.parentWorkspaceId). */
  parentWorkspaceId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Task-level model string used when running the sub-agent (optional for legacy entries). */
  model?: string;
  /** Task-level thinking/reasoning level used when running the sub-agent (optional for legacy entries). */
  thinkingLevel?: ThinkingLevel;
  /** Absolute path to the archived chat.jsonl file on disk (if present). */
  chatPath?: string;
  /** Absolute path to the archived partial.json file on disk (if present). */
  partialPath?: string;
}

const SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION = 1 as const;

const SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_NAME = "subagent-transcripts.json";
const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";
const SUBAGENT_TRANSCRIPT_CHAT_FILE_NAME = "chat.jsonl";
const SUBAGENT_TRANSCRIPT_PARTIAL_FILE_NAME = "partial.json";

export function getSubagentTranscriptArtifactsFilePath(workspaceSessionDir: string): string {
  return path.join(workspaceSessionDir, SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_NAME);
}

export function getSubagentTranscriptChatPath(
  workspaceSessionDir: string,
  childTaskId: string
): string {
  return path.join(
    workspaceSessionDir,
    SUBAGENT_TRANSCRIPTS_DIR_NAME,
    childTaskId,
    SUBAGENT_TRANSCRIPT_CHAT_FILE_NAME
  );
}

export function getSubagentTranscriptPartialPath(
  workspaceSessionDir: string,
  childTaskId: string
): string {
  return path.join(
    workspaceSessionDir,
    SUBAGENT_TRANSCRIPTS_DIR_NAME,
    childTaskId,
    SUBAGENT_TRANSCRIPT_PARTIAL_FILE_NAME
  );
}

export async function readSubagentTranscriptArtifactsFile(
  workspaceSessionDir: string
): Promise<SubagentTranscriptArtifactsFile> {
  try {
    const filePath = getSubagentTranscriptArtifactsFilePath(workspaceSessionDir);
    const raw = await fsPromises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return { version: SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    const obj = parsed as {
      version?: unknown;
      artifactsByChildTaskId?: unknown;
    };

    if (obj.version !== SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION) {
      // Unknown version; treat as empty.
      return { version: SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    if (!obj.artifactsByChildTaskId || typeof obj.artifactsByChildTaskId !== "object") {
      return { version: SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    return {
      version: SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION,
      artifactsByChildTaskId: obj.artifactsByChildTaskId as Record<
        string,
        SubagentTranscriptArtifactIndexEntry
      >,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
    }

    log.error("Failed to read subagent transcript artifacts file", { error });
    return { version: SUBAGENT_TRANSCRIPT_ARTIFACTS_FILE_VERSION, artifactsByChildTaskId: {} };
  }
}

export async function updateSubagentTranscriptArtifactsFile(params: {
  /** Workspace id that owns the session dir we're writing into (used for file locking). */
  workspaceId: string;
  workspaceSessionDir: string;
  update: (file: SubagentTranscriptArtifactsFile) => void;
}): Promise<SubagentTranscriptArtifactsFile> {
  return workspaceFileLocks.withLock(params.workspaceId, async () => {
    const file = await readSubagentTranscriptArtifactsFile(params.workspaceSessionDir);
    params.update(file);

    try {
      await fsPromises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentTranscriptArtifactsFilePath(params.workspaceSessionDir);
      await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
    } catch (error) {
      log.error("Failed to write subagent transcript artifacts file", { error });
    }

    return file;
  });
}

export async function upsertSubagentTranscriptArtifactIndexEntry(params: {
  /** Workspace id that owns the session dir we're writing into (used for file locking). */
  workspaceId: string;
  workspaceSessionDir: string;
  childTaskId: string;
  updater: (
    existing: SubagentTranscriptArtifactIndexEntry | null
  ) => SubagentTranscriptArtifactIndexEntry;
}): Promise<SubagentTranscriptArtifactIndexEntry> {
  let updated: SubagentTranscriptArtifactIndexEntry | null = null;

  await updateSubagentTranscriptArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    update: (file) => {
      const existing = file.artifactsByChildTaskId[params.childTaskId] ?? null;
      updated = params.updater(existing);
      file.artifactsByChildTaskId[params.childTaskId] = updated;
    },
  });

  if (!updated) {
    throw new Error("upsertSubagentTranscriptArtifactIndexEntry: updater returned no entry");
  }

  return updated;
}
