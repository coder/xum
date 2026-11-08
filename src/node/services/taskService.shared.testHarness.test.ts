/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { __resetFileSinkForTests, log } from "@/node/services/log";
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

  test("gives the home back even when deleting the root fails", async () => {
    const root = await createTaskServiceTestRoot();
    const failure = new Error("injected root removal failure");
    const rm = spyOn(fsPromises, "rm").mockRejectedValueOnce(failure);
    try {
      await expect(removeTaskServiceTestRoot(root)).rejects.toBe(failure);
      expectHostHome();
    } finally {
      rm.mockRestore();
      await removeTaskServiceTestRoot(root);
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  // The log file sink opens at the first log line, in the home that is current then. A sink that
  // outlives its home keeps a descriptor on a deleted file, and a later test's log lines never
  // reach the home that is current for it.
  test("closes the log sink that the isolated home opened when the root is removed", async () => {
    __resetFileSinkForTests();
    const open = spyOn(fs, "createWriteStream");
    const root = await createTaskServiceTestRoot();
    try {
      const isolated = os.homedir();
      log.info("task service test root: the sink opens inside the isolated home");
      expect(open.mock.calls.length).toBe(1);
      expect(String(open.mock.calls[0][0]).startsWith(isolated)).toBe(true);
      const sink = open.mock.results[0].value as fs.WriteStream;
      expect(sink.writableEnded).toBe(false);
      await removeTaskServiceTestRoot(root);
      expect(sink.writableEnded).toBe(true);
    } finally {
      open.mockRestore();
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });

  test("closes a log sink that an earlier test opened under the host home", async () => {
    __resetFileSinkForTests();
    // Open the sink as an earlier test would, without touching the host's log folder or file.
    const openStream = fs.createWriteStream;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const open = spyOn(fs, "createWriteStream").mockImplementation(() => openStream(os.devNull));
    let sink: fs.WriteStream;
    try {
      log.info("task service test root: a sink that an earlier test opened");
      expect(open.mock.calls.length).toBe(1);
      sink = open.mock.results[0].value as fs.WriteStream;
    } finally {
      open.mockRestore();
      mkdir.mockRestore();
    }
    const root = await createTaskServiceTestRoot();
    try {
      expect(sink.writableEnded).toBe(true);
    } finally {
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });
});
