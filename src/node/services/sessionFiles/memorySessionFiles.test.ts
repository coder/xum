/**
 * Each fix of SessionFilesMemory answers a real memfs gap: every case shows the gap on a raw memfs
 * volume, then the fixed behaviour on the layer.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Effect } from "effect";
import { createFsFromVolume, Volume } from "memfs";
import { SessionFilesTag } from "@/node/services/di/tags";
import { SessionFilesMemory } from "./memorySessionFiles.testHarness";
import type { SessionFiles } from "./sessionFiles";

const build = (): SessionFiles =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* SessionFilesTag;
    }).pipe(Effect.provide(SessionFilesMemory))
  );

/** The files of a raw memfs volume, typed like SessionFiles for the members these cases use. */
const raw = (): SessionFiles => createFsFromVolume(new Volume()) as unknown as SessionFiles;

async function errorCode(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return "no error";
}

async function stamps(files: SessionFiles, file: string): Promise<string> {
  const s = await files.promises.stat(file, { bigint: true });
  return JSON.stringify([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String));
}

describe("SessionFilesMemory fixes", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("fix 1: unlink of a directory gives the host's error", async () => {
    const hostCode = process.platform === "linux" ? "EISDIR" : "EPERM";
    for (const [files, expected] of [
      [raw(), "EPERM"],
      [build(), hostCode],
    ] as const) {
      await files.promises.mkdir("/dir");
      expect(await errorCode(() => files.promises.unlink("/dir"))).toBe(expected);
      expect(await errorCode(() => files.unlinkSync("/dir"))).toBe(expected);
    }
  });

  test("fix 2: rename of a directory onto a non-empty directory fails with ENOTEMPTY", async () => {
    for (const [files, expected] of [
      [raw(), "no error"],
      [build(), "ENOTEMPTY"],
    ] as const) {
      await files.promises.mkdir("/a");
      await files.promises.mkdir("/b");
      await files.promises.appendFile("/b/file", "x");
      expect(await errorCode(() => files.promises.rename("/a", "/b"))).toBe(expected);
      expect(await errorCode(() => files.renameSync("/a", "/b"))).toBe(
        expected === "no error" ? "ENOENT" : expected
      );
    }
  });

  test("fix 3: an inode number never comes back after unlink", async () => {
    for (const [files, reused] of [
      [raw(), true],
      [build(), false],
    ] as const) {
      await files.promises.appendFile("/a", "x");
      const first = (await files.promises.stat("/a", { bigint: true })).ino;
      await files.promises.unlink("/a");
      await files.promises.appendFile("/b", "x");
      expect((await files.promises.stat("/b", { bigint: true })).ino === first).toBe(reused);
    }
  });

  test("fix 3: a same-size rewrite in the same millisecond changes the stamps", async () => {
    // A frozen clock makes the raw memfs gap certain instead of a race with the ms boundary.
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (const [files, changes] of [
      [raw(), false],
      [build(), true],
    ] as const) {
      await files.promises.appendFile("/chat.jsonl", "row 1\n");
      const before = await stamps(files, "/chat.jsonl");
      const handle = await files.promises.open("/chat.jsonl", "r+");
      await handle.write(Buffer.from("row 2\n"), 0, 6, 0);
      await handle.close();
      expect((await stamps(files, "/chat.jsonl")) !== before).toBe(changes);
    }
  });

  test("fix 3: rename changes ctime", async () => {
    for (const [files, changes] of [
      [raw(), false],
      [build(), true],
    ] as const) {
      setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await files.promises.appendFile("/a", "x");
      const before = (await files.promises.stat("/a", { bigint: true })).ctimeNs;
      setSystemTime(new Date("2026-01-01T00:00:01Z"));
      await files.promises.rename("/a", "/b");
      const after = (await files.promises.stat("/b", { bigint: true })).ctimeNs;
      expect(after > before).toBe(changes);
    }
  });

  test("two builds of the layer share no file", async () => {
    const first = build();
    const second = build();
    await first.promises.appendFile("/chat.jsonl", "row\n");
    expect(await errorCode(() => second.promises.access("/chat.jsonl"))).toBe("ENOENT");
    expect(await errorCode(() => build().promises.access("/chat.jsonl"))).toBe("ENOENT");
  });
});
