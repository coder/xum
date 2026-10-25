import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DaytonaSSHRuntime } from "@/node/runtime/DaytonaSSHRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { createDaytonaTestRig } from "@/node/services/daytona/daytona.testHarness";

import { createSshForwardTarget, isXumRootShared } from "./sshForwardTarget";

describe("createSshForwardTarget", () => {
  test("gives a Daytona sandbox no forward (its gateway refuses remote port forwarding)", async () => {
    const rig = await createDaytonaTestRig();
    try {
      const plain = { host: "box", srcBaseDir: "~/src" };
      const daytona = { ...plain, host: "sb-1.xum--daytona", daytona: { sandboxId: "sb-1" } };
      const sshTarget = createSshForwardTarget(
        new SSHRuntime(plain, createSSHTransport(plain, false))
      );
      const daytonaTarget = createSshForwardTarget(
        new DaytonaSSHRuntime(daytona, createSSHTransport(daytona, false), rig.service)
      );
      expect(sshTarget).toBeDefined();
      expect(daytonaTarget).toBeUndefined();
    } finally {
      await rig.cleanup();
    }
  });
});

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
