/**
 * writeFileAtomic and ensurePrivateDir run on the fs they are given: the in-memory session files
 * pass their own, and no call may reach the host fs behind it.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "fs";
import fsp from "fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePrivateDir } from "./fs";
import writeFileAtomic, { type WriteFileAtomicFs } from "./writeFileAtomic";

const MEMBERS = [
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "close",
  "closeSync",
  "fstat",
  "fstatSync",
  "fsync",
  "fsyncSync",
  "open",
  "openSync",
  "realpath",
  "realpathSync",
  "rename",
  "renameSync",
  "stat",
  "statSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeSync",
] as const satisfies ReadonlyArray<keyof WriteFileAtomicFs>;

type AnyFunction = (...args: unknown[]) => unknown;

/** Forwards each member to the host function captured now and records its name. */
function recordingWrapper<K extends string>(target: object, members: readonly K[]) {
  const calls: string[] = [];
  const host = target as Record<K, AnyFunction>;
  const wrapper = Object.fromEntries(
    members.map((name) => {
      const original = host[name].bind(target);
      const forward: AnyFunction = (...args) => {
        calls.push(name);
        return original(...args);
      };
      return [name, forward];
    })
  );
  // Spies on the host object, installed after the capture, see only calls that bypass the wrapper.
  const bypasses = members.map((name) => spyOn(host, name));
  const bypassed = () =>
    bypasses.flatMap((spy, index) => (spy.mock.calls.length ? [members[index]] : []));
  return { calls, wrapper, bypassed };
}

describe("writeFileAtomic and ensurePrivateDir on a given fs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xum-write-file-atomic-fs-"));
  });
  afterEach(async () => {
    mock.restore();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // win32 skips the parent directory fsync, so its call list is shorter.
  test.skipIf(process.platform === "win32")(
    "an async and a sync write make every call through the given fs",
    async () => {
      const file = path.join(dir, "chat.jsonl");
      const { calls, wrapper, bypassed } = recordingWrapper(fs, MEMBERS);
      const files = wrapper as unknown as WriteFileAtomicFs;

      await writeFileAtomic(file, "async\n", { fs: files });
      expect(calls.splice(0)).toEqual([
        "realpath",
        "stat",
        "open",
        "write",
        "fsync",
        "fstat",
        "close",
        "rename",
        // The parent directory fsync.
        "open",
        "fsync",
        "close",
        "unlink",
      ]);
      writeFileAtomic.sync(file, "sync\n", { fs: files });
      // The file exists now, so the write keeps its owner and mode.
      const ownership = process.getuid ? ["chownSync", "chmodSync"] : ["chmodSync"];
      expect(calls).toEqual([
        "realpathSync",
        "statSync",
        "openSync",
        "writeSync",
        "fsyncSync",
        "fstatSync",
        "closeSync",
        ...ownership,
        "renameSync",
        "openSync",
        "fsyncSync",
        "closeSync",
        "unlinkSync",
      ]);
      expect(bypassed()).toEqual([]);
      expect(await fsp.readFile(file, "utf8")).toBe("sync\n");
    }
  );

  test("ensurePrivateDir makes its calls through the given fs/promises", async () => {
    const { calls, wrapper, bypassed } = recordingWrapper(fsp, ["mkdir", "chmod"] as const);
    const sessionDir = path.join(dir, "sessions", "ws");
    await ensurePrivateDir(sessionDir, wrapper as unknown as Pick<typeof fsp, "mkdir" | "chmod">);
    expect(calls).toEqual(["mkdir", "chmod"]);
    expect(bypassed()).toEqual([]);
    expect((await fsp.stat(sessionDir)).mode & 0o777).toBe(0o700);
  });
});
