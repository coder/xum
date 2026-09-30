import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ensureWorkspaceScratchDir, getWorkspaceScratchDir } from "./workspaceScratchDir";

describe("ensureWorkspaceScratchDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-scratch-dir-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("creates the dir inside the workspace session dir, so removal deletes it", async () => {
    const sessionsDir = path.join(tempDir, "sessions");

    const scratchDir = await ensureWorkspaceScratchDir(sessionsDir, "ws1");

    expect(scratchDir).toBe(getWorkspaceScratchDir(sessionsDir, "ws1"));
    expect(path.dirname(scratchDir)).toBe(path.join(sessionsDir, "ws1"));
    expect((await fs.stat(scratchDir)).isDirectory()).toBe(true);
  });

  test("exports an absolute path even when the Xum root is relative", () => {
    const scratchDir = getWorkspaceScratchDir(path.join(".xum-test", "sessions"), "ws1");

    expect(path.isAbsolute(scratchDir)).toBe(true);
    expect(scratchDir).toBe(path.resolve(".xum-test", "sessions", "ws1", "scratch"));
  });

  test("still returns the path when creation fails, so the prompt never names an unset variable", async () => {
    // A regular file where the session dir should be makes mkdir fail.
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir);
    await fs.writeFile(path.join(sessionsDir, "ws1"), "not a dir");

    expect(await ensureWorkspaceScratchDir(sessionsDir, "ws1")).toBe(
      getWorkspaceScratchDir(sessionsDir, "ws1")
    );
  });
});
