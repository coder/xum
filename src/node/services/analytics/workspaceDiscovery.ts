import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { CHAT_FILE_NAME } from "./etl";

const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.trim().length === 0) {
    return null;
  }

  return value;
}

export interface DiscoveredWorkspace {
  workspaceId: string;
  sessionDir: string;
  /** Set for archived subagent workspaces — the parent workspace's ID. */
  parentWorkspaceId?: string;
}

export async function discoverAllWorkspaces(
  sessionsDir: string
): Promise<Map<string, DiscoveredWorkspace>> {
  assert(sessionsDir.trim().length > 0, "discoverAllWorkspaces requires a non-empty sessionsDir");

  const discoveredWorkspaces = new Map<string, DiscoveredWorkspace>();
  const workspaceChatFileMtimes = new Map<string, number>();
  const topLevelWorkspaceIds: string[] = [];

  const addIfNewer = async (
    workspaceId: string,
    sessionDir: string,
    parentWorkspaceId?: string
  ): Promise<void> => {
    const normalizedWorkspaceId = parseNonEmptyString(workspaceId);
    assert(
      normalizedWorkspaceId !== null,
      "discoverAllWorkspaces expected workspace IDs to be non-empty"
    );

    let normalizedParentWorkspaceId: string | undefined;
    if (parentWorkspaceId !== undefined) {
      const parsedParentWorkspaceId = parseNonEmptyString(parentWorkspaceId);
      assert(
        parsedParentWorkspaceId !== null,
        "discoverAllWorkspaces expected parent workspace IDs to be non-empty"
      );
      normalizedParentWorkspaceId = parsedParentWorkspaceId;
    }

    const chatPath = path.join(sessionDir, CHAT_FILE_NAME);

    let chatStat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      chatStat = await fs.stat(chatPath);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    if (!chatStat.isFile()) {
      return;
    }

    const existingMtimeMs = workspaceChatFileMtimes.get(normalizedWorkspaceId);
    if (existingMtimeMs !== undefined && existingMtimeMs >= chatStat.mtimeMs) {
      return;
    }

    workspaceChatFileMtimes.set(normalizedWorkspaceId, chatStat.mtimeMs);
    discoveredWorkspaces.set(normalizedWorkspaceId, {
      workspaceId: normalizedWorkspaceId,
      sessionDir,
      parentWorkspaceId: normalizedParentWorkspaceId,
    });
  };

  let topLevelEntries: Dirent[];

  try {
    topLevelEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return discoveredWorkspaces;
    }

    throw error;
  }

  for (const entry of topLevelEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const workspaceId = parseNonEmptyString(entry.name);
    assert(
      workspaceId !== null,
      "discoverAllWorkspaces expected top-level workspace IDs to be non-empty"
    );

    const sessionDirPath = path.join(sessionsDir, workspaceId);
    await addIfNewer(workspaceId, sessionDirPath);

    if (discoveredWorkspaces.get(workspaceId)?.sessionDir === sessionDirPath) {
      topLevelWorkspaceIds.push(workspaceId);
    }
  }

  for (const parentWorkspaceId of topLevelWorkspaceIds) {
    const transcriptsDir = path.join(sessionsDir, parentWorkspaceId, SUBAGENT_TRANSCRIPTS_DIR_NAME);

    let childEntries: Dirent[];
    try {
      childEntries = await fs.readdir(transcriptsDir, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        continue;
      }

      log.warn("[analytics-worker] Failed to read archived sub-agent transcript directory", {
        transcriptsDir,
        parentWorkspaceId,
        error: getErrorMessage(error),
      });
      continue;
    }

    for (const childEntry of childEntries) {
      if (!childEntry.isDirectory()) {
        continue;
      }

      const childWorkspaceId = parseNonEmptyString(childEntry.name);
      assert(
        childWorkspaceId !== null,
        "discoverAllWorkspaces expected archived workspace IDs to be non-empty"
      );

      const childSessionDir = path.join(transcriptsDir, childWorkspaceId);
      try {
        await addIfNewer(childWorkspaceId, childSessionDir, parentWorkspaceId);
      } catch (error) {
        log.warn("[analytics-worker] Failed to stat archived sub-agent transcript chat file", {
          chatPath: path.join(childSessionDir, CHAT_FILE_NAME),
          archivedWorkspaceId: childWorkspaceId,
          parentWorkspaceId,
          error: getErrorMessage(error),
        });
      }
    }
  }

  return discoveredWorkspaces;
}
