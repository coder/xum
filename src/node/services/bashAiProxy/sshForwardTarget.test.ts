import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isXumRootShared } from "./sshForwardTarget";

describe("isXumRootShared", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-ai-proxy-shared-"));
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  async function writeServerLock(pid: number): Promise<void> {
    const lock = {
      pid,
      baseUrl: "http://127.0.0.1:3000",
      token: "t",
      startedAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(path.join(rootDir, "server.lock"), JSON.stringify(lock));
  }

  test("the multiple-instances switch shares the root, also under its legacy name", async () => {
    expect(await isXumRootShared(rootDir, { XUM_ALLOW_MULTIPLE_INSTANCES: "1" })).toBe(true);
    expect(await isXumRootShared(rootDir, { MUX_ALLOW_MULTIPLE_INSTANCES: "1" })).toBe(true);
    expect(await isXumRootShared(rootDir, {})).toBe(false);
  });

  test("only a live server lock of another process shares the root", async () => {
    await writeServerLock(process.pid); // this backend's own API server
    expect(await isXumRootShared(rootDir, {})).toBe(false);
    await writeServerLock(process.ppid); // a running `xum server`
    expect(await isXumRootShared(rootDir, {})).toBe(true);
    await writeServerLock(2 ** 30); // a lock left by a process that is gone
    expect(await isXumRootShared(rootDir, {})).toBe(false);
  });
});
