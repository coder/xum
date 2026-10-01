import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
// Default import: the module under test reads fs through the same CommonJS object, so
// spies installed here are the ones it observes (see the note in writeFileAtomic.ts).
import fs from "fs";
import * as os from "os";
import * as path from "path";
import writeFileAtomic, { sync as writeFileAtomicSync } from "./writeFileAtomic";

type BufferWrite = (
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | null,
  callback: (
    error: NodeJS.ErrnoException | null,
    written: number,
    buffer: NodeJS.ArrayBufferView
  ) => void
) => void;

describe("writeFileAtomic", () => {
  let dir: string;
  let target: string;
  const previous = '{"previous":true}';
  const payload = JSON.stringify({ padding: "x".repeat(64 * 1024) });

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "write-file-atomic-"));
    target = path.join(dir, "config.json");
    await fs.promises.writeFile(target, previous);
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  async function siblings(): Promise<string[]> {
    return (await fs.promises.readdir(dir)).sort();
  }

  function contents(file: string): Promise<string> {
    return fs.promises.readFile(file, "utf-8");
  }

  // The kernel contract under test: a short count is not an error, and any failure only
  // surfaces on the following call.
  function mockWrite(
    behavior: (call: number, original: BufferWrite, args: Parameters<BufferWrite>) => void
  ): { restore: () => void; calls: () => number } {
    const original: BufferWrite = fs.write.bind(fs);
    let calls = 0;
    const spy = spyOn(fs, "write").mockImplementation(((...args: Parameters<BufferWrite>) => {
      calls += 1;
      behavior(calls, original, args);
    }) as typeof fs.write);
    return { restore: () => spy.mockRestore(), calls: () => calls };
  }

  function writeHalf(original: BufferWrite, args: Parameters<BufferWrite>): void {
    const [fd, buffer, offset, length, position, callback] = args;
    original(fd, buffer, offset, Math.floor(length / 2), position, callback);
  }

  it("replaces the destination and leaves no temp file behind", async () => {
    await writeFileAtomic(target, payload, "utf-8");
    expect(await contents(target)).toBe(payload);
    expect(await siblings()).toEqual(["config.json"]);
  });

  it("keeps the destination when the disk fills up after a short write", async () => {
    const write = mockWrite((call, original, args) => {
      if (call === 1) {
        writeHalf(original, args);
        return;
      }
      const error: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      args[5](error, 0, args[1]);
    });
    let failure: unknown;
    try {
      await writeFileAtomic(target, payload);
    } catch (error) {
      failure = error;
    } finally {
      write.restore();
    }
    expect((failure as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(await contents(target)).toBe(previous);
    expect(await siblings()).toEqual(["config.json"]);
  });

  it("continues after a short write until the whole payload is stored", async () => {
    const write = mockWrite((call, original, args) => {
      if (call === 1) {
        writeHalf(original, args);
        return;
      }
      original(...args);
    });
    try {
      await writeFileAtomic(target, payload);
    } finally {
      write.restore();
    }
    expect(write.calls()).toBe(2);
    expect(await contents(target)).toBe(payload);
  });

  it("refuses to publish a temp file whose size disagrees with the payload", async () => {
    // A write that reports the full length but stores less must be caught by the size
    // check even though the retry loop believes it is done.
    const write = mockWrite((_call, original, args) => {
      const [fd, buffer, offset, length, position, callback] = args;
      original(fd, buffer, offset, Math.floor(length / 2), position, (error) =>
        callback(error, length, buffer)
      );
    });
    let failure: unknown;
    try {
      await writeFileAtomic(target, payload);
    } catch (error) {
      failure = error;
    } finally {
      write.restore();
    }
    expect(String(failure)).toContain("Incomplete write");
    expect(await contents(target)).toBe(previous);
    expect(await siblings()).toEqual(["config.json"]);
  });

  it("applies the same guards on the synchronous path", async () => {
    const original = fs.writeSync.bind(fs);
    let calls = 0;
    const spy = spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null
    ) => {
      calls += 1;
      if (calls === 1) {
        return original(fd, buffer, offset, Math.floor(length / 2), position);
      }
      const error: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }) as typeof fs.writeSync);
    try {
      expect(() => writeFileAtomicSync(target, payload)).toThrow("ENOSPC");
    } finally {
      spy.mockRestore();
    }
    expect(await contents(target)).toBe(previous);
    expect(await siblings()).toEqual(["config.json"]);

    writeFileAtomicSync(target, payload);
    expect(await contents(target)).toBe(payload);
  });

  it("keeps the destination's mode and honors an explicit mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    await fs.promises.chmod(target, 0o600);
    await writeFileAtomic(target, payload);
    expect((await fs.promises.stat(target)).mode & 0o777).toBe(0o600);

    const fresh = path.join(dir, "fresh.json");
    await writeFileAtomic(fresh, payload, { mode: 0o640 });
    expect((await fs.promises.stat(fresh)).mode & 0o777).toBe(0o640);
  });

  // A crash right after rename(2) can lose the rename unless the parent directory entry is
  // flushed too (#5331). Windows cannot fsync directory handles, so it skips this step.
  /* eslint-disable local/no-sync-fs-methods -- the spies wrap the synchronous variant's own
     calls and classify descriptors inline, as the module under test does. */
  describe.skipIf(process.platform === "win32")("parent directory durability", () => {
    function recordDirectorySyncs() {
      const events: string[] = [];
      const rename = fs.rename;
      const renameSync = fs.renameSync;
      const fsync = fs.fsync;
      const fsyncSync = fs.fsyncSync;
      const isDirectory = (fd: number) => fs.fstatSync(fd).isDirectory();
      const spies = [
        spyOn(fs, "rename").mockImplementation(((...args: Parameters<typeof fs.rename>) => {
          events.push("rename");
          return rename(...args);
        }) as typeof fs.rename),
        spyOn(fs, "renameSync").mockImplementation((...args) => {
          events.push("rename");
          return renameSync(...args);
        }),
        spyOn(fs, "fsync").mockImplementation(((fd: number, callback: fs.NoParamCallback) => {
          events.push(isDirectory(fd) ? "fsync dir" : "fsync file");
          return fsync(fd, callback);
        }) as typeof fs.fsync),
        spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          events.push(isDirectory(fd) ? "fsync dir" : "fsync file");
          return fsyncSync(fd);
        }),
      ];
      return { events, restore: () => spies.forEach((spy) => spy.mockRestore()) };
    }

    it.each(["async", "sync"] as const)(
      "flushes the parent directory after the rename (%s)",
      async (variant) => {
        const recorded = recordDirectorySyncs();
        try {
          if (variant === "async") await writeFileAtomic(target, payload);
          else writeFileAtomicSync(target, payload);
        } finally {
          recorded.restore();
        }
        expect(recorded.events).toEqual(["fsync file", "rename", "fsync dir"]);
        expect(await contents(target)).toBe(payload);
      }
    );

    it.each(["async", "sync"] as const)(
      "skips every fsync when fsync is disabled (%s)",
      async (variant) => {
        const recorded = recordDirectorySyncs();
        try {
          if (variant === "async") await writeFileAtomic(target, payload, { fsync: false });
          else writeFileAtomicSync(target, payload, { fsync: false });
        } finally {
          recorded.restore();
        }
        expect(recorded.events).toEqual(["rename"]);
      }
    );

    it.each(["async", "sync"] as const)(
      "keeps the write successful when the directory flush fails (%s)",
      async (variant) => {
        const fsync = fs.fsync;
        const fsyncSync = fs.fsyncSync;
        const unsupported = () => Object.assign(new Error("not supported"), { code: "EINVAL" });
        const spies = [
          spyOn(fs, "fsync").mockImplementation(((fd: number, callback: fs.NoParamCallback) => {
            if (fs.fstatSync(fd).isDirectory()) return callback(unsupported());
            return fsync(fd, callback);
          }) as typeof fs.fsync),
          spyOn(fs, "fsyncSync").mockImplementation((fd) => {
            if (fs.fstatSync(fd).isDirectory()) throw unsupported();
            return fsyncSync(fd);
          }),
        ];
        try {
          if (variant === "async") await writeFileAtomic(target, payload);
          else writeFileAtomicSync(target, payload);
        } finally {
          spies.forEach((spy) => spy.mockRestore());
        }
        expect(await contents(target)).toBe(payload);
        expect(await siblings()).toEqual(["config.json"]);
      }
    );
  });

  /* eslint-enable local/no-sync-fs-methods */

  it("serializes concurrent writes to the same path", async () => {
    const values = Array.from({ length: 5 }, (_, i) => `{"n":${i}}`);
    await Promise.all(values.map((value) => writeFileAtomic(target, value)));
    expect(await contents(target)).toBe(values[values.length - 1]);
    expect(await siblings()).toEqual(["config.json"]);
  });
});
