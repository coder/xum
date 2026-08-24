import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetFileSinkForTests, clearLogFiles, closeLogFile, getLogFilePath, log } from "./log";

describe("log file sink state machine", () => {
  let tempXumRoot: string;
  let originalXumRoot: string | undefined;

  beforeAll(async () => {
    originalXumRoot = process.env.XUM_ROOT;
    tempXumRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-log-test-"));
    process.env.XUM_ROOT = tempXumRoot;
  });

  beforeEach(() => {
    __resetFileSinkForTests();
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(async () => {
    closeLogFile();

    if (originalXumRoot === undefined) {
      delete process.env.XUM_ROOT;
    } else {
      process.env.XUM_ROOT = originalXumRoot;
    }

    await fsPromises.rm(tempXumRoot, { recursive: true, force: true });
  });

  test("writes only the canonical Xum log file", () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) =>
      originalCreateWriteStream(...args)
    );

    log.error("canonical log path");

    const canonicalPath = path.join(tempXumRoot, "logs", "xum.log");
    expect(getLogFilePath()).toBe(canonicalPath);
    expect(createWriteStreamSpy).toHaveBeenCalledWith(canonicalPath, { flags: "a" });
    expect(createWriteStreamSpy).not.toHaveBeenCalledWith(
      path.join(tempXumRoot, "logs", "mux.log"),
      { flags: "a" }
    );
  });

  test("transitions to degraded after stream error and suppresses immediate retries", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    let streamCreations = 0;

    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      streamCreations += 1;

      if (streamCreations === 1) {
        queueMicrotask(() => {
          stream.emit("error", new Error("forced log stream failure"));
        });
      }

      return stream;
    });

    expect(() => log.info("first log line")).not.toThrow();
    await Promise.resolve();

    expect(() => log.info("second log line should no-op while degraded")).not.toThrow();
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
  });

  test("clearLogFiles closes and reopens the active sink stream", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createdStreams: fs.WriteStream[] = [];

    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      createdStreams.push(stream);
      return stream;
    });

    const nowSpy = spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    log.info("line before clear");
    nowSpy.mockRestore();

    expect(createdStreams).toHaveLength(1);

    const firstStream = createdStreams[0];
    if (!firstStream) {
      throw new Error("expected an initial log stream");
    }

    const firstStreamEndSpy = spyOn(firstStream, "end");

    await clearLogFiles();

    expect(firstStreamEndSpy).toHaveBeenCalledTimes(1);
    expect(createdStreams).toHaveLength(2);
    expect(createdStreams[1]).not.toBe(firstStream);

    log.info("line after clear");
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(2);
  });

  test("clearLogFiles removes pre-rename active and rotated logs", async () => {
    const logsDir = path.join(tempXumRoot, "logs");
    await fsPromises.mkdir(logsDir, { recursive: true });
    const legacyLogPaths = [
      path.join(logsDir, "mux.log"),
      path.join(logsDir, "mux.1.log"),
      path.join(logsDir, "mux.3.log"),
    ];
    await Promise.all(
      legacyLogPaths.map((legacyPath) => fsPromises.writeFile(legacyPath, "legacy"))
    );

    await clearLogFiles();

    for (const legacyPath of legacyLogPaths) {
      const legacyStats = await fsPromises.stat(legacyPath).catch(() => null);
      expect(legacyStats).toBeNull();
    }
  });

  test("clearLogFiles rejects when truncate fails", async () => {
    const openSyncSpy = spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("truncate failed");
    });

    let clearError: unknown;
    try {
      await clearLogFiles();
    } catch (error) {
      clearError = error;
    }

    expect(openSyncSpy).toHaveBeenCalled();
    expect(clearError).toBeInstanceOf(Error);
    if (!(clearError instanceof Error)) {
      throw new Error("expected clearLogFiles to reject with Error");
    }
    expect(clearError.message).toContain("truncate failed");
  });

  test("queued clear cannot reopen after closeLogFile", async () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createdStreams: fs.WriteStream[] = [];

    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      const stream = originalCreateWriteStream(...args);
      createdStreams.push(stream);
      return stream;
    });

    log.info("line before clear and close");
    expect(createdStreams).toHaveLength(1);

    const clearPromise = clearLogFiles();
    closeLogFile();
    await clearPromise.catch(() => undefined);

    expect(createdStreams).toHaveLength(1);

    log.info("line after close should be dropped");
    expect(createWriteStreamSpy).toHaveBeenCalledTimes(1);
  });

  test("closeLogFile transitions sink to closed and blocks reopen attempts", () => {
    const originalCreateWriteStream = fs.createWriteStream;
    const createWriteStreamSpy = spyOn(fs, "createWriteStream").mockImplementation((...args) =>
      originalCreateWriteStream(...args)
    );
    const writeSpy = spyOn(fs.WriteStream.prototype, "write");

    log.info("line before close");
    const createCallsBeforeClose = createWriteStreamSpy.mock.calls.length;
    const writeCallsBeforeClose = writeSpy.mock.calls.length;
    expect(writeCallsBeforeClose).toBeGreaterThan(0);

    closeLogFile();

    expect(() => log.info("line after close should be dropped")).not.toThrow();
    expect(createWriteStreamSpy.mock.calls.length).toBe(createCallsBeforeClose);
    expect(writeSpy.mock.calls.length).toBe(writeCallsBeforeClose);
  });
});
