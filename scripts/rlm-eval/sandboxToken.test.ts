import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { readSandboxToken } from "./sandboxToken";

describe("readSandboxToken", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rlm-eval-token-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("returns the lockfile token for the server the lock names", async () => {
    await new ServerLockfile(root).acquire("http://127.0.0.1:41234", "lock-token");
    expect(await readSandboxToken({ root, baseUrl: "http://127.0.0.1:41234" })).toBe("lock-token");
  });

  test("refuses to hand the token to another origin", async () => {
    await new ServerLockfile(root).acquire("http://127.0.0.1:41234", "lock-token");
    for (const baseUrl of ["http://127.0.0.1:41235", "http://attacker.example:41234"]) {
      const error = await readSandboxToken({ root, baseUrl }).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("lock-token");
    }
  });

  test("sends no token for an open server or when no server runs under the root", async () => {
    expect(await readSandboxToken({ root, baseUrl: "http://127.0.0.1:41234" })).toBe("");
    await new ServerLockfile(root).acquire("http://127.0.0.1:41234", "");
    expect(await readSandboxToken({ root, baseUrl: "http://127.0.0.1:41234" })).toBe("");
  });
});
