/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { __resetFileSinkForTests, clearLogFiles, getLogFilePath, log } from "@/node/services/log";
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

  // Spies on the deletion of the isolated home. When rm deletes `home`, it records whether every
  // stream that the log sink opened by then is closed, and how many log files the sink had renamed.
  function spyOnHomeDeletion(home: string) {
    const streams = spyOn(fs, "createWriteStream");
    const renames = spyOn(fs, "renameSync");
    const realRmSync = fs.rmSync;
    const atDeletion = { deleted: false, allStreamsClosed: false, renames: 0 };
    const rmSync = spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === home) {
        atDeletion.deleted = true;
        // Every sink that was ever opened, including one that a late log line reopened.
        atDeletion.allStreamsClosed = streams.mock.results.every((result) => {
          return (result.value as fs.WriteStream).closed;
        });
        atDeletion.renames = renames.mock.calls.length;
      }
      return realRmSync(target, options);
    });
    return {
      atDeletion,
      streams,
      renames,
      restore() {
        rmSync.mockRestore();
        renames.mockRestore();
        streams.mockRestore();
      },
    };
  }

  // The log file sink opens at the first log line, in the home that is current then. Windows cannot
  // delete a file that a stream holds open, and a sink that outlives its home would keep writing
  // to a deleted file instead of the home that is current for a later test.
  test("closes the log sink that the isolated home opened before it deletes that home", async () => {
    __resetFileSinkForTests();
    const root = await createTaskServiceTestRoot();
    const isolated = os.homedir();
    const spy = spyOnHomeDeletion(isolated);
    try {
      log.info("task service test root: the sink opens inside the isolated home");
      expect(spy.streams.mock.calls.length).toBe(1);
      expect(String(spy.streams.mock.calls[0][0]).startsWith(isolated)).toBe(true);
      const sink = spy.streams.mock.results[0].value as fs.WriteStream;
      expect(sink.closed).toBe(false);
      // Work that a test leaves running can log while the root is being removed.
      sink.once("close", () => log.info("task service test root: a late log line"));
      await removeTaskServiceTestRoot(root);
      expect(spy.atDeletion.allStreamsClosed).toBe(true);
      expect(spy.streams.mock.calls.length).toBe(1);
    } finally {
      spy.restore();
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });

  // A rotation takes its stream out of the open state at once and renames the log files later, in
  // the sink queue. The home must not be deleted before that rename or before the old stream is
  // closed, and the rotation must not reopen the sink in the deleted home afterwards.
  test("waits for a log rotation that is in flight before it deletes the isolated home", async () => {
    __resetFileSinkForTests();
    const root = await createTaskServiceTestRoot();
    const isolated = os.homedir();
    const logFile = getLogFilePath();
    const spy = spyOnHomeDeletion(isolated);
    try {
      // The sink starts from the size of the file that it finds, and it rotates at 10 MiB. A sparse
      // file of that size makes the first log line rotate, with no 10 MiB write.
      await fsPromises.mkdir(path.dirname(logFile), { recursive: true });
      await fsPromises.writeFile(logFile, "");
      await fsPromises.truncate(logFile, 10 * 1024 * 1024);
      log.info("task service test root: this line rotates the log");
      expect(spy.renames.mock.calls.length).toBe(0);
      await removeTaskServiceTestRoot(root);
      expect(spy.atDeletion.renames).toBeGreaterThan(0);
      expect(spy.atDeletion.allStreamsClosed).toBe(true);
      // A rotation that resumed later would recreate the folder that was just deleted.
      expect(await fsPromises.stat(isolated).catch(() => null)).toBeNull();
    } finally {
      spy.restore();
      await removeTaskServiceTestRoot(root);
      __resetFileSinkForTests();
    }
  });

  // A clear also takes its stream out of the open state at once and truncates the log later.
  test("waits for a log clear that is in flight before it deletes the isolated home", async () => {
    __resetFileSinkForTests();
    const root = await createTaskServiceTestRoot();
    const isolated = os.homedir();
    const spy = spyOnHomeDeletion(isolated);
    try {
      log.info("task service test root: the sink opens inside the isolated home");
      const clearing = clearLogFiles();
      await removeTaskServiceTestRoot(root);
      expect(spy.atDeletion.allStreamsClosed).toBe(true);
      await clearing;
      expect(await fsPromises.stat(isolated).catch(() => null)).toBeNull();
    } finally {
      spy.restore();
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
