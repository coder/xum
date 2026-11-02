/**
 * Shared test helper: creates a real HistoryService backed by a temp directory.
 *
 * HistoryService is pure filesystem I/O with a single dependency (getSessionDir).
 * Prefer this over mocks in tests — it's fast (sub-millisecond on temp dirs),
 * requires no initialization, and exercises real read/write paths.
 *
 * For error injection, use the real instance + spyOn:
 *   spyOn(historyService, "appendToHistory").mockRejectedValueOnce(...)
 *
 * `files` picks the SessionFiles layer of the history files (default: the Node layer). With
 * SessionFilesMemory the session files stay in memory; config and tempDir stay on disk.
 * `locks` picks the SessionLocks layer (default: the Node layer). With SessionLocksMemory the
 * history locks stay in memory too; withForeignHolders plays other backends' lock holders.
 *
 * Test-only: tsconfig.main.json excludes this file by path so it stays out of the
 * app build (AGENTS.md documents this path, so it keeps its name).
 */
import { HistoryService } from "@/node/services/historyService";
import { Config } from "@/node/config";
import type { SessionFilesTag, SessionLocksTag } from "@/node/services/di/tags";
import { SessionFilesNode } from "@/node/services/sessionFiles/nodeSessionFiles";
import { buildSessionFiles } from "@/node/services/sessionFiles/buildSessionFiles.testHarness";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";
import { buildSessionLocks } from "@/node/services/sessionLocks/buildSessionLocks.testHarness";
import { SessionLocksNode } from "@/node/services/sessionLocks/nodeSessionLocks";
import type { Layer } from "effect";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export async function createTestHistoryService(options?: {
  files?: Layer.Layer<SessionFilesTag>;
  locks?: Layer.Layer<SessionLocksTag>;
}): Promise<{
  historyService: HistoryService;
  /** The SessionFiles that historyService uses, for reads in assertions. */
  files: SessionFiles;
  config: Config;
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = path.join(
    os.tmpdir(),
    `xum-test-history-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(tempDir, { recursive: true });
  const config = new Config(tempDir);
  const files = buildSessionFiles(options?.files ?? SessionFilesNode);
  const locks = buildSessionLocks(options?.locks ?? SessionLocksNode);
  const historyService = new HistoryService(config, files, locks);
  return {
    historyService,
    files,
    config,
    tempDir,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
}

/**
 * A HistoryService on an existing Config's root (no temp dir) whose locks come from `locks`: a
 * test that runs several backends on one root gives one of them withForeignHolders.
 */
export function historyServiceWithLocks(
  config: Config,
  locks: Layer.Layer<SessionLocksTag>
): HistoryService {
  return new HistoryService(config, buildSessionFiles(SessionFilesNode), buildSessionLocks(locks));
}
