import * as path from "node:path";

import type { ThinkingLevel } from "@/common/types/thinking";

import { log } from "@/node/services/log";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";

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
  workspaceSessionDir: string,
  /** The session files of the workspace (phase 5). Absent: the Node layer. */
  files: SessionFiles = nodeSessionFiles
): Promise<SubagentTranscriptArtifactsFile> {
  try {
    const filePath = getSubagentTranscriptArtifactsFilePath(workspaceSessionDir);
    const raw = await files.promises.readFile(filePath, "utf-8");
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
  /** The workspace FIFO (phase 4: SessionLocks). Absent: the Node layer. */
  locks?: SessionLocks;
  /** The session files of the workspace (phase 5). Absent: the Node layer. */
  files?: SessionFiles;
}): Promise<SubagentTranscriptArtifactsFile> {
  // mutation-equivalent: locks is a SessionLocks object or undefined, so ?? and || agree
  const fileLocks = (params.locks ?? nodeSessionLocks).workspaceFiles;
  return fileLocks.withLock(params.workspaceId, async () => {
    // mutation-equivalent: files is a SessionFiles object or undefined, so ?? and || agree
    const files = params.files ?? nodeSessionFiles;
    const file = await readSubagentTranscriptArtifactsFile(params.workspaceSessionDir, files);
    params.update(file);

    try {
      await files.promises.mkdir(params.workspaceSessionDir, { recursive: true });
      const filePath = getSubagentTranscriptArtifactsFilePath(params.workspaceSessionDir);
      await files.writeFileAtomic(filePath, JSON.stringify(file, null, 2));
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
  /** The workspace FIFO (phase 4: SessionLocks). Absent: the Node layer. */
  locks?: SessionLocks;
  /** The session files of the workspace (phase 5). Absent: the Node layer. */
  files?: SessionFiles;
}): Promise<SubagentTranscriptArtifactIndexEntry> {
  let updated: SubagentTranscriptArtifactIndexEntry | null = null;

  await updateSubagentTranscriptArtifactsFile({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.workspaceSessionDir,
    locks: params.locks,
    files: params.files,
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
