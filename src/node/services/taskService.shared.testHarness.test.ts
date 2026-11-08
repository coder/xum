import { describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import {
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

// About 46 test files share this helper, and each of their agent-task reservations scans the
// runtime user's plugin folders. The helper must hold the host home away for the life of a root
// and give it back exactly, so that no file reads the machine's plugins or leaks a spy.
describe("createTaskServiceTestRoot", () => {
  const hostHomedir = os.homedir();
  const hostEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XUM_ROOT: process.env.XUM_ROOT,
  };

  function expectHostHome(): void {
    expect(os.homedir()).toBe(hostHomedir);
    expect({
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      XUM_ROOT: process.env.XUM_ROOT,
    }).toEqual(hostEnv);
  }

  test("points every home lookup at an empty folder until the root is removed", async () => {
    const root = await createTaskServiceTestRoot();
    try {
      const isolated = os.homedir();
      expect(isolated).not.toBe(hostHomedir);
      expect(process.env.HOME).toBe(isolated);
      expect(process.env.XUM_ROOT?.startsWith(isolated)).toBe(true);
      expect(await fsPromises.readdir(isolated)).toEqual([]);
    } finally {
      await removeTaskServiceTestRoot(root);
    }
    expectHostHome();
    expect(await fsPromises.stat(root).catch(() => null)).toBeNull();
  });

  test("removing a superseded root leaves the newer root's isolation in place", async () => {
    const first = await createTaskServiceTestRoot();
    const second = await createTaskServiceTestRoot();
    try {
      const isolated = os.homedir();
      await removeTaskServiceTestRoot(first);
      expect(os.homedir()).toBe(isolated);
      expect(isolated).not.toBe(hostHomedir);
    } finally {
      await removeTaskServiceTestRoot(second);
    }
    expectHostHome();
  });

  test("a root whose removal was skipped does not nest the next isolation", async () => {
    const skipped = await createTaskServiceTestRoot();
    const second = await createTaskServiceTestRoot();
    await removeTaskServiceTestRoot(second);
    expectHostHome();
    await fsPromises.rm(skipped, { recursive: true, force: true });
  });
});
