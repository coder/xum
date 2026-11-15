import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ServerLockfile } from "@/node/services/serverLockfile";
import {
  identityOf,
  startFakeBackend,
  startUnrelatedProcess,
} from "@/node/services/testXumBackend";
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

  test("sends no token to a server that took over a dead backend's pid and port", async () => {
    // The backend that wrote the lock crashed. An unrelated process holds its pid, and another
    // server holds its port: neither may get the token that authorizes command execution.
    const other = await startFakeBackend("other");
    const unrelated = startUnrelatedProcess();
    try {
      await fs.writeFile(
        path.join(root, "server.lock"),
        JSON.stringify({
          pid: unrelated.pid,
          baseUrl: other.baseUrl,
          token: "lock-token",
          startedAt: new Date().toISOString(),
        })
      );
      expect(await readSandboxToken({ root, baseUrl: other.baseUrl })).toBe("");
      expect(JSON.stringify(other.requests)).not.toContain("lock-token");
    } finally {
      unrelated.kill();
      await other.close();
    }
  });

  test.skipIf(process.platform !== "linux")(
    "sends no token to a server that copies the version answer on a dead backend's port",
    async () => {
      // Linux records the backend's start time in the lock, so the squatter is never asked.
      const squatter = await startFakeBackend("xum");
      const holder = startUnrelatedProcess();
      try {
        await fs.writeFile(
          path.join(root, "server.lock"),
          JSON.stringify({
            pid: holder.pid,
            baseUrl: squatter.baseUrl,
            token: "lock-token",
            startedAt: new Date().toISOString(),
            identity: { ...identityOf(holder.pid), birth: "linux-ticks:1" },
          })
        );
        expect(await readSandboxToken({ root, baseUrl: squatter.baseUrl })).toBe("");
        expect(squatter.requests).toEqual([]);
      } finally {
        holder.kill();
        await squatter.close();
      }
    }
  );

  test("sends no token for an open server or when no server runs under the root", async () => {
    expect(await readSandboxToken({ root, baseUrl: "http://127.0.0.1:41234" })).toBe("");
    await new ServerLockfile(root).acquire("http://127.0.0.1:41234", "");
    expect(await readSandboxToken({ root, baseUrl: "http://127.0.0.1:41234" })).toBe("");
  });
});
