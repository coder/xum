import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { DisposableTempDir } from "@/node/services/tempDir";
import { SessionTapeFolderService } from "./sessionTapeFolderService";
import { maybeRecordWorkspaceChat, stopSessionTapeCaptures } from "./sessionTapeRecorder";
import { syntheticChatEvents } from "./sessionTapes.testFixtures";

/** A full-replay subscription that never ends by itself, recorded with the experiment on. */
function openCapture(rootDir: string): AsyncGenerator<WorkspaceChatMessage> {
  const [first] = syntheticChatEvents();
  async function* endless() {
    for (;;) {
      await Promise.resolve();
      yield first;
    }
  }
  return maybeRecordWorkspaceChat(
    {
      aiService: { isExperimentEnabled: (id) => id === EXPERIMENT_IDS.SESSION_TAPES },
      config: { rootDir },
    },
    { workspaceId: "ws-tape-folder", validateOutput: true },
    endless()
  );
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false
  );
}

describe("SessionTapeFolderService", () => {
  afterEach(async () => {
    // Captures are process-wide: never leak one into another test.
    await stopSessionTapeCaptures();
  });

  test("saveOpen counts the open tapes it wrote, once", async () => {
    using root = new DisposableTempDir("session-tape-save");
    const dir = getXumPerfTapesDir(root.path);
    const service = new SessionTapeFolderService({ dir });
    const iterator = openCapture(root.path);
    await iterator.next();

    expect(await service.saveOpen()).toEqual({ written: 1, dir });
    const [name] = await fs.readdir(dir);
    const lastLine = (await fs.readFile(path.join(dir, name), "utf-8"))
      .trimEnd()
      .split("\n")
      .at(-1);
    expect((JSON.parse(lastLine ?? "") as { end: { reason: string } }).end.reason).toBe("stopped");
    // Already saved: the subscription keeps flowing, but there is nothing open to save.
    expect(await service.saveOpen()).toEqual({ written: 0, dir });
    await iterator.return(undefined);
  });

  test("saveOpen does not count a tape whose write failed", async () => {
    using root = new DisposableTempDir("session-tape-save-fail");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, "not a directory");
    const iterator = openCapture(root.path);
    await iterator.next();

    expect(await new SessionTapeFolderService({ dir }).saveOpen()).toEqual({ written: 0, dir });
    await iterator.return(undefined);
  });

  test("revealFolder without a revealer reports the path and creates nothing", async () => {
    using root = new DisposableTempDir("session-tape-reveal-server");
    const dir = getXumPerfTapesDir(root.path);

    expect(await new SessionTapeFolderService({ dir }).revealFolder()).toEqual({
      dir,
      revealed: false,
    });
    expect(await exists(dir)).toBe(false);
  });

  test("revealFolder opens an owner-only folder, and a revealer failure rejects", async () => {
    using root = new DisposableTempDir("session-tape-reveal");
    const dir = getXumPerfTapesDir(root.path);
    const revealPath = mock((_dir: string) => Promise.resolve());
    const service = new SessionTapeFolderService({ dir });
    service.setRevealer(revealPath);

    expect(await service.revealFolder()).toEqual({ dir, revealed: true });
    expect(revealPath).toHaveBeenCalledWith(dir);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);

    service.setRevealer(() => Promise.reject(new Error("no file manager")));
    let rejection: unknown;
    try {
      await service.revealFolder();
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
  });
});
