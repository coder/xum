/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { __resetFileSinkForTests, getLogFilePath, log } from "@/node/services/log";
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
    // An open log sink makes ending the skipped isolation take a few ticks, so the next root must
    // wait for it before it isolates.
    log.info("task service test root: the sink of a root whose removal was skipped");
    const second = await createTaskServiceTestRoot();
    expect(os.homedir()).not.toBe(hostHomedir);
    await removeTaskServiceTestRoot(second);
    expectHostHome();
    await fsPromises.rm(skipped, { recursive: true, force: true });
    __resetFileSinkForTests();
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

  // The log file sink opens at the first log line, in the home that is current then. Windows cannot
  // delete a file that a stream holds open, and a sink that outlives its home would keep writing
  // to a deleted file instead of the home that is current for a later test.
  test("closes the log sink that the isolated home opened before it deletes that home", async () => {
    __resetFileSinkForTests();
    const root = await createTaskServiceTestRoot();
    const isolated = os.homedir();
    const open = spyOn(fs, "createWriteStream");
    const realRmSync = fs.rmSync;
    let closedWhenHomeDeleted: boolean | undefined;
    const rmSync = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      // Every sink that was ever opened, including one that a late log line reopened.
      if (String(target) === isolated) {
        closedWhenHomeDeleted = open.mock.results.every((result) => {
          return (result.value as fs.WriteStream).closed;
        });
      }
      return realRmSync(target, options);
    });
    try {
      log.info("task service test root: the sink opens inside the isolated home");
      expect(open.mock.calls.length).toBe(1);
      expect(String(open.mock.calls[0][0]).startsWith(isolated)).toBe(true);
      const sink = open.mock.results[0].value as fs.WriteStream;
      expect(sink.closed).toBe(false);
      // Work that a test leaves running can log while the root is being removed.
      sink.once("close", () => log.info("task service test root: a late log line"));
      await removeTaskServiceTestRoot(root);
      expect(closedWhenHomeDeleted).toBe(true);
      expect(open.mock.calls.length).toBe(1);
    } finally {
      rmSync.mockRestore();
      open.mockRestore();
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });

  // A rotation takes its stream out of the open state at once and renames the log files later, in
  // the sink queue. The home must not be deleted before that rename, and the rotation must not
  // reopen the sink in the deleted home afterwards.
  test("waits for a log rotation that is in flight before it deletes the isolated home", async () => {
    __resetFileSinkForTests();
    const root = await createTaskServiceTestRoot();
    const isolated = os.homedir();
    const logFile = getLogFilePath();
    const realRmSync = fs.rmSync;
    // The rotation shifts the log files with renameSync once its stream is done.
    const rename = spyOn(fs, "renameSync");
    let renamedWhenHomeDeleted: boolean | undefined;
    const rmSync = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === isolated) renamedWhenHomeDeleted = rename.mock.calls.length > 0;
      return realRmSync(target, options);
    });
    try {
      // The sink starts from the size of the file that it finds, and it rotates at 10 MiB. A sparse
      // file of that size makes the first log line rotate, with no 10 MiB write.
      await fsPromises.mkdir(path.dirname(logFile), { recursive: true });
      await fsPromises.writeFile(logFile, "");
      await fsPromises.truncate(logFile, 10 * 1024 * 1024);
      log.info("task service test root: this line rotates the log");
      expect(rename.mock.calls.length).toBe(0);
      await removeTaskServiceTestRoot(root);
      expect(renamedWhenHomeDeleted).toBe(true);
      // A rotation that resumed later would recreate the folder that was just deleted.
      expect(await fsPromises.stat(isolated).catch(() => null)).toBeNull();
    } finally {
      rmSync.mockRestore();
      rename.mockRestore();
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });

  // Writes one log line and returns the sinks it opened. They point at the null device and the log
  // folder is not created, so the host's log file and folder stay untouched.
  function logToNullDevice(message: string): fs.WriteStream[] {
    const openStream = fs.createWriteStream;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const open = spyOn(fs, "createWriteStream").mockImplementation(() => openStream(os.devNull));
    try {
      log.info(message);
      return open.mock.results.map((result) => result.value as fs.WriteStream);
    } finally {
      open.mockRestore();
      mkdir.mockRestore();
    }
  }

  test("closes a log sink that an earlier test opened under the host home", async () => {
    __resetFileSinkForTests();
    const sinks = logToNullDevice("task service test root: a sink that an earlier test opened");
    expect(sinks.length).toBe(1);
    const root = await createTaskServiceTestRoot();
    try {
      expect(sinks[0].writableEnded).toBe(true);
    } finally {
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });

  test("lets the log sink open again once the root is removed", async () => {
    __resetFileSinkForTests();
    const root = await createTaskServiceTestRoot();
    await removeTaskServiceTestRoot(root);
    try {
      expect(
        logToNullDevice("task service test root: a line after the root was removed").length
      ).toBe(1);
    } finally {
      __resetFileSinkForTests();
    }
  });
});
