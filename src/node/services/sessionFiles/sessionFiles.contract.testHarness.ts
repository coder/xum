/**
 * The behaviour of SessionFiles that the history code relies on, as one suite that every layer
 * must pass (the Node layer now, the memory layer later). One case for each member and for each
 * flag or error the history files depend on.
 *
 * Each case builds the layer again, so no two cases share state, and works in a fresh mkdtemp
 * folder. A layer without host files creates the same paths in its own volume.
 */
import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { randomUUID } from "node:crypto";
import * as hostFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionFilesTag } from "@/node/services/di/tags";
import type { SessionFiles } from "./sessionFiles";

async function errorCode(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return "no error";
}

/** The stamps that historyAppendProvenance.ts compares (sameStamps). */
async function stamps(files: SessionFiles, file: string): Promise<string> {
  const s = await files.promises.stat(file, { bigint: true });
  return JSON.stringify([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String));
}

/** Creates a symlink in the layer's files; SessionFiles itself has no symlink member. */
export type SymlinkHook = (files: SessionFiles, target: string, link: string) => Promise<void>;

export function describeSessionFilesContract(
  name: string,
  layer: Layer.Layer<SessionFilesTag>,
  symlink: SymlinkHook = (_files, target, link) => hostFs.symlink(target, link)
): void {
  describe(`SessionFiles contract: ${name}`, () => {
    function it(
      title: string,
      body: (files: SessionFiles, dir: string) => Promise<void>,
      options: { posixOnly?: boolean } = {}
    ): void {
      // The history code skips directory fsync on win32 too.
      const run = options.posixOnly === true && process.platform === "win32" ? test.skip : test;
      run(title, async () => {
        const files = Effect.runSync(
          Effect.gen(function* () {
            return yield* SessionFilesTag;
          }).pipe(Effect.provide(layer))
        );
        // A unique root that exists in the layer under test (on the host for the Node layer).
        const dir = path.join(os.tmpdir(), `xum-session-files-${randomUUID()}`);
        await files.promises.mkdir(dir, { recursive: true });
        try {
          await body(files, dir);
        } finally {
          await files.promises.rm(dir, { recursive: true, force: true });
        }
      });
    }

    it("open 'a' appends at the end, whatever the position", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "abc");
      const handle = await files.promises.open(file, "a", 0o600);
      await handle.write(Buffer.from("X"), 0, 1, 0);
      await handle.close();
      expect(await files.promises.readFile(file, "utf8")).toBe("abcX");
    });

    it("open 'a+' reads from the start and appends at the end", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "abc");
      const handle = await files.promises.open(file, "a+");
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(3), 0, 3, 0);
      expect(buffer.subarray(0, bytesRead).toString()).toBe("abc");
      await handle.writeFile("d");
      await handle.close();
      expect(await files.promises.readFile(file, "utf8")).toBe("abcd");
    });

    it("open 'wx' fails with EEXIST on a file that exists", async (files, dir) => {
      const file = path.join(dir, "receipt.json");
      await (await files.promises.open(file, "wx", 0o600)).close();
      expect(await errorCode(() => files.promises.open(file, "wx", 0o600))).toBe("EEXIST");
    });

    it("open 'r+' writes in place and fails with ENOENT on a missing file", async (files, dir) => {
      const file = path.join(dir, "partial.json");
      await files.promises.appendFile(file, "abcdef");
      const handle = await files.promises.open(file, "r+");
      await handle.write(Buffer.from("XY"), 0, 2, 1);
      await handle.close();
      expect(await files.promises.readFile(file, "utf8")).toBe("aXYdef");
      expect(await errorCode(() => files.promises.open(path.join(dir, "no"), "r+"))).toBe("ENOENT");
    });

    it(
      "open with O_RDONLY|O_NOFOLLOW|O_NONBLOCK fails with ELOOP on a symlink",
      async (files, dir) => {
        const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = files.constants;
        const target = path.join(dir, "target.json");
        await files.promises.appendFile(target, "{}");
        const link = path.join(dir, "link.json");
        await symlink(files, target, link);
        const flags = O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0);
        expect(await errorCode(() => files.promises.open(link, flags))).toBe("ELOOP");
        await (await files.promises.open(target, flags)).close();
      },
      { posixOnly: true }
    );

    it("a FileHandle reads, writes, syncs, stats and closes", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      const handle = await files.promises.open(file, "a+", 0o600);
      await handle.writeFile("row\n");
      await handle.sync();
      expect((await handle.stat()).size).toBe(4);
      const read = await handle.read(Buffer.alloc(8), 0, 8, 0);
      expect(read.buffer.subarray(0, read.bytesRead).toString()).toBe("row\n");
      await handle.close();
      expect(await errorCode(() => handle.stat())).not.toBe("no error");
    });

    it("await using closes the handle at the end of the scope", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "row\n");
      let escaped: Awaited<ReturnType<SessionFiles["promises"]["open"]>> | undefined;
      {
        await using handle = await files.promises.open(file, "r");
        escaped = handle;
        expect((await handle.stat()).size).toBe(4);
      }
      expect(await errorCode(() => escaped.stat())).not.toBe("no error");
    });

    it("bigint stat keeps dev and ino across rename, a new file gets a new ino", async (files, dir) => {
      const first = path.join(dir, "a");
      const moved = path.join(dir, "b");
      await files.promises.appendFile(first, "1");
      const before = await files.promises.stat(first, { bigint: true });
      await files.promises.rename(first, moved);
      const after = await files.promises.stat(moved, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      await files.promises.appendFile(first, "1");
      expect((await files.promises.stat(first, { bigint: true })).ino).not.toBe(before.ino);
    });

    it("a replaced file gets different stamps (sameStamps sees it)", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "old\n");
      const before = await stamps(files, file);
      await files.promises.appendFile(`${file}.new`, "new rows\n");
      await files.promises.rename(`${file}.new`, file);
      expect(await stamps(files, file)).not.toBe(before);
    });

    it(
      "a directory opens, syncs through its handle and through fsyncSync(fd)",
      async (files, dir) => {
        const handle = await files.promises.open(dir, "r");
        await handle.sync();
        files.fsyncSync(handle.fd);
        await handle.close();
      },
      { posixOnly: true }
    );

    it("writeSync(handle.fd) then fsyncSync(handle.fd) persists the row", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      const handle = await files.promises.open(file, "a", 0o600);
      const bytes = Buffer.from("row\n");
      expect(files.writeSync(handle.fd, bytes, 0, bytes.length)).toBe(bytes.length);
      files.fsyncSync(handle.fd);
      await handle.close();
      expect(await files.promises.readFile(file, "utf8")).toBe("row\n");
    });

    it("readFile of a directory fails with EISDIR, unlink like the host", async (files, dir) => {
      expect(await errorCode(() => files.promises.readFile(dir))).toBe("EISDIR");
      // unlink(2) of a directory: EISDIR on Linux, EPERM on macOS and Windows.
      const unlinkCode = process.platform === "linux" ? "EISDIR" : "EPERM";
      expect(await errorCode(() => files.promises.unlink(dir))).toBe(unlinkCode);
      expect(await errorCode(() => files.unlinkSync(dir))).toBe(unlinkCode);
    });

    it("rmdir of a full directory fails with ENOTEMPTY, of an empty one removes it", async (files, dir) => {
      const sub = path.join(dir, "sub");
      await files.promises.mkdir(sub);
      await files.promises.appendFile(path.join(sub, "file"), "x");
      expect(await errorCode(() => files.promises.rmdir(sub))).toBe("ENOTEMPTY");
      expect(await errorCode(() => files.rmdirSync(sub))).toBe("ENOTEMPTY");
      await files.promises.unlink(path.join(sub, "file"));
      files.rmdirSync(sub);
      expect(await errorCode(() => files.promises.access(sub))).toBe("ENOENT");
    });

    it("rm force ignores a missing path, rm without force fails with ENOENT", async (files, dir) => {
      const missing = path.join(dir, "missing");
      await files.promises.rm(missing, { force: true });
      files.rmSync(missing, { force: true });
      expect(await errorCode(() => files.promises.rm(missing))).toBe("ENOENT");
      await files.promises.appendFile(missing, "x");
      files.rmSync(missing, { force: true });
      expect(await errorCode(() => files.promises.access(missing))).toBe("ENOENT");
    });

    it("rename and renameSync replace an existing file", async (files, dir) => {
      const target = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(target, "old");
      await files.promises.appendFile(`${target}.a`, "async");
      await files.promises.rename(`${target}.a`, target);
      expect(await files.promises.readFile(target, "utf8")).toBe("async");
      await files.promises.appendFile(`${target}.b`, "sync");
      files.renameSync(`${target}.b`, target);
      expect(await files.promises.readFile(target, "utf8")).toBe("sync");
      expect(await errorCode(() => files.renameSync(`${target}.b`, target))).toBe("ENOENT");
    });

    it("readdir withFileTypes tells files from directories", async (files, dir) => {
      await files.promises.mkdir(path.join(dir, "sub"));
      await files.promises.appendFile(path.join(dir, "chat.jsonl"), "x");
      const entries = await files.promises.readdir(dir, { withFileTypes: true });
      const kinds = entries.map((entry) => [entry.name, entry.isDirectory()]).sort();
      expect(kinds).toEqual([
        ["chat.jsonl", false],
        ["sub", true],
      ]);
    });

    it("access resolves on a file and fails with ENOENT on a missing one", async (files, dir) => {
      await files.promises.appendFile(path.join(dir, "x"), "x");
      await files.promises.access(path.join(dir, "x"));
      expect(await errorCode(() => files.promises.access(path.join(dir, "y")))).toBe("ENOENT");
    });

    it(
      "mkdir recursive creates the parents with the mode and accepts an existing one",
      async (files, dir) => {
        const nested = path.join(dir, "a", "b");
        await files.promises.mkdir(nested, { recursive: true, mode: 0o700 });
        await files.promises.mkdir(nested, { recursive: true, mode: 0o700 });
        expect((await files.promises.stat(nested)).mode & 0o777).toBe(0o700);
        expect(await errorCode(() => files.promises.mkdir(nested))).toBe("EEXIST");
      },
      { posixOnly: true }
    );

    it("appendFile creates the file, then appends", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "a\n");
      await files.promises.appendFile(file, Buffer.from("b\n"));
      expect(await files.promises.readFile(file, "utf8")).toBe("a\nb\n");
    });

    it("readFile returns a Buffer, or a string with an encoding, ENOENT when missing", async (files, dir) => {
      const file = path.join(dir, "x");
      await files.promises.appendFile(file, "é");
      expect(Buffer.isBuffer(await files.promises.readFile(file))).toBe(true);
      expect(await files.promises.readFile(file, "utf8")).toBe("é");
      expect(await errorCode(() => files.promises.readFile(path.join(dir, "y")))).toBe("ENOENT");
    });

    it("stat reports size and kind, and fails with ENOENT on a missing path", async (files, dir) => {
      const file = path.join(dir, "x");
      await files.promises.appendFile(file, "abc");
      const stat = await files.promises.stat(file);
      expect([stat.size, stat.isFile(), (await files.promises.stat(dir)).isDirectory()]).toEqual([
        3,
        true,
        true,
      ]);
      expect(await errorCode(() => files.promises.stat(path.join(dir, "y")))).toBe("ENOENT");
    });

    it("unlink removes a file and fails with ENOENT on a missing one", async (files, dir) => {
      const file = path.join(dir, "x");
      await files.promises.appendFile(file, "x");
      await files.promises.unlink(file);
      expect(await errorCode(() => files.promises.unlink(file))).toBe("ENOENT");
      await files.promises.appendFile(file, "x");
      files.unlinkSync(file);
      expect(await errorCode(() => files.promises.access(file))).toBe("ENOENT");
    });

    it("writeFileAtomic replaces the bytes with the mode and leaves no temp file", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "old\n");
      await files.writeFileAtomic(file, "new\n", { mode: 0o600 });
      await files.writeFileAtomic(file, Buffer.from("newer\n"));
      expect(await files.promises.readFile(file, "utf8")).toBe("newer\n");
      expect(await files.promises.readdir(dir)).toEqual(["chat.jsonl"]);
      if (process.platform !== "win32")
        expect((await files.promises.stat(file)).mode & 0o777).toBe(0o600);
    });

    it("fsyncParentDirectory resolves for a file in the folder", async (files, dir) => {
      const file = path.join(dir, "chat.jsonl");
      await files.promises.appendFile(file, "x");
      await files.fsyncParentDirectory(file);
    });

    it(
      "ensurePrivateDir creates the folder with mode 0o700 and fixes an existing one",
      async (files, dir) => {
        const sessionDir = path.join(dir, "sessions", "ws");
        await files.ensurePrivateDir(sessionDir);
        expect((await files.promises.stat(sessionDir)).mode & 0o777).toBe(0o700);
        const shared = path.join(dir, "shared");
        await files.promises.mkdir(shared, { mode: 0o755 });
        await files.ensurePrivateDir(shared);
        expect((await files.promises.stat(shared)).mode & 0o777).toBe(0o700);
      },
      { posixOnly: true }
    );
  });
}
