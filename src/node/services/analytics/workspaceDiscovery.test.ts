import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { log } from "@/node/services/log";
import { CHAT_FILE_NAME } from "./etl";
import { discoverAllWorkspaces } from "./workspaceDiscovery";

const SUBAGENT_TRANSCRIPTS_DIR_NAME = "subagent-transcripts";
const tempDirsToClean: string[] = [];

async function createTempSessionsDir(): Promise<string> {
  const sessionsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mux-analytics-workspace-discovery-")
  );
  tempDirsToClean.push(sessionsDir);
  return sessionsDir;
}

async function writeChatJsonl(sessionDir: string): Promise<void> {
  await fs.writeFile(path.join(sessionDir, CHAT_FILE_NAME), "{}\n");
}

afterEach(async () => {
  await Promise.all(
    tempDirsToClean.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("discoverAllWorkspaces", () => {
  test("skips unreadable archived transcript directories instead of throwing", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const transcriptsDir = path.join(parentSessionDir, SUBAGENT_TRANSCRIPTS_DIR_NAME);
    await fs.mkdir(transcriptsDir, { recursive: true });

    const originalReaddir = fs.readdir;
    const readdirSpy = spyOn(fs, "readdir").mockImplementation(((...args: unknown[]) => {
      const [targetPath] = args;
      if (String(targetPath) === transcriptsDir) {
        const permissionError = Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
        return Promise.reject(permissionError);
      }

      return (originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof fs.readdir);
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);

    try {
      const discovered = await discoverAllWorkspaces(sessionsDir);
      expect([...discovered.keys()]).toEqual([parentWorkspaceId]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  test("ignores archived sub-agent directories without chat.jsonl", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const archivedWithoutHistoryDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      "child-without-history"
    );
    await fs.mkdir(archivedWithoutHistoryDir, { recursive: true });

    const discovered = await discoverAllWorkspaces(sessionsDir);
    expect([...discovered.keys()]).toEqual([parentWorkspaceId]);
  });

  test("returns top-level workspaces with correct sessionDir", async () => {
    const sessionsDir = await createTempSessionsDir();
    const workspaceId = "ws-a";

    const workspaceSessionDir = path.join(sessionsDir, workspaceId);
    await fs.mkdir(workspaceSessionDir, { recursive: true });
    await writeChatJsonl(workspaceSessionDir);

    const discovered = await discoverAllWorkspaces(sessionsDir);

    expect(discovered.size).toBe(1);
    expect(discovered.get(workspaceId)).toEqual({
      workspaceId,
      sessionDir: workspaceSessionDir,
      parentWorkspaceId: undefined,
    });
  });

  test("includes archived subagents with correct sessionDir under parent", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";
    const childWorkspaceId = "child-a";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const childSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      childWorkspaceId
    );
    await fs.mkdir(childSessionDir, { recursive: true });
    await writeChatJsonl(childSessionDir);

    const discovered = await discoverAllWorkspaces(sessionsDir);

    expect(discovered.get(parentWorkspaceId)).toEqual({
      workspaceId: parentWorkspaceId,
      sessionDir: parentSessionDir,
      parentWorkspaceId: undefined,
    });
    expect(discovered.get(childWorkspaceId)).toEqual({
      workspaceId: childWorkspaceId,
      sessionDir: childSessionDir,
      parentWorkspaceId,
    });
  });

  test("deduplicates workspace IDs, preferring newer mtime", async () => {
    const sessionsDir = await createTempSessionsDir();
    const parentWorkspaceId = "parent-a";
    const duplicateWorkspaceId = "shared-workspace";

    const parentSessionDir = path.join(sessionsDir, parentWorkspaceId);
    await fs.mkdir(parentSessionDir, { recursive: true });
    await writeChatJsonl(parentSessionDir);

    const topLevelDuplicateSessionDir = path.join(sessionsDir, duplicateWorkspaceId);
    await fs.mkdir(topLevelDuplicateSessionDir, { recursive: true });
    await writeChatJsonl(topLevelDuplicateSessionDir);

    const archivedDuplicateSessionDir = path.join(
      parentSessionDir,
      SUBAGENT_TRANSCRIPTS_DIR_NAME,
      duplicateWorkspaceId
    );
    await fs.mkdir(archivedDuplicateSessionDir, { recursive: true });
    await writeChatJsonl(archivedDuplicateSessionDir);

    const topLevelDuplicateChatPath = path.join(topLevelDuplicateSessionDir, CHAT_FILE_NAME);
    const archivedDuplicateChatPath = path.join(archivedDuplicateSessionDir, CHAT_FILE_NAME);
    const topLevelDuplicateStat = await fs.stat(topLevelDuplicateChatPath);
    const newerAtime = new Date(topLevelDuplicateStat.atimeMs + 5_000);
    const newerMtime = new Date(topLevelDuplicateStat.mtimeMs + 5_000);
    await fs.utimes(archivedDuplicateChatPath, newerAtime, newerMtime);

    const discovered = await discoverAllWorkspaces(sessionsDir);

    expect(discovered.get(duplicateWorkspaceId)).toEqual({
      workspaceId: duplicateWorkspaceId,
      sessionDir: archivedDuplicateSessionDir,
      parentWorkspaceId,
    });
  });

  test("returns empty map for missing sessionsDir", async () => {
    const missingSessionsDir = path.join(
      os.tmpdir(),
      `mux-analytics-workspace-discovery-missing-${process.pid}-${randomUUID()}`
    );

    const discovered = await discoverAllWorkspaces(missingSessionsDir);
    expect(discovered.size).toBe(0);
  });
});
