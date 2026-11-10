import { describe, expect, test } from "bun:test";
import * as path from "path";
import { getWorkspaceScratchDir } from "./workspaceScratchDir";

describe("getWorkspaceScratchDir", () => {
  test("puts the dir inside the workspace session dir, so removal deletes it", () => {
    const sessionsDir = path.join(path.sep, "xum", "sessions");

    expect(path.dirname(getWorkspaceScratchDir(sessionsDir, "ws1"))).toBe(
      path.join(sessionsDir, "ws1")
    );
  });

  test("exports an absolute path even when the Xum root is relative", () => {
    const scratchDir = getWorkspaceScratchDir(path.join(".xum-test", "sessions"), "ws1");

    expect(path.isAbsolute(scratchDir)).toBe(true);
    expect(scratchDir).toBe(path.resolve(".xum-test", "sessions", "ws1", "scratch"));
  });
});
