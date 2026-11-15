import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startFakeBackend, unservedBaseUrl } from "../testXumBackend";
import { isXumRootShared } from "./sshForwardTarget";

describe("isXumRootShared", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-ai-proxy-shared-"));
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  async function writeServerLock(pid: number, baseUrl = "http://127.0.0.1:3000"): Promise<void> {
    const lock = {
      pid,
      baseUrl,
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
    const running = await startFakeBackend("xum");
    try {
      await writeServerLock(process.ppid, running.baseUrl); // a running `xum server`
      expect(await isXumRootShared(rootDir, {})).toBe(true);
    } finally {
      await running.close();
    }
    await writeServerLock(2 ** 30); // a lock left by a process that is gone
    expect(await isXumRootShared(rootDir, {})).toBe(false);
  });

  test("a lock whose pid another process now holds does not share the root", async () => {
    // The backend that wrote the lock is gone and nothing serves its baseUrl any more.
    await writeServerLock(process.ppid, await unservedBaseUrl());
    expect(await isXumRootShared(rootDir, {})).toBe(false);
  });
});
