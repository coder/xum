import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  WorkspaceMutationInProgressError,
  WorkspaceUseLeases,
  workspaceMutationLockPath,
  workspaceUseLockDir,
} from "@/node/services/workspaceUseLeases";
import {
  acquireCrossProcessLock,
  inspectCrossProcessLock,
} from "@/node/utils/main/crossProcessLock";

// #4476: two backends on one Xum root (the desktop app beside a `xum server`, or
// XUM_ALLOW_MULTIPLE_INSTANCES) each own one WorkspaceUseLeases; a use lease is the evidence
// another backend's structural mutation (rename, remove) must see before it touches the checkout.

const workspaceId = "ws-lease";

describe("WorkspaceUseLeases across two backends on one root", () => {
  let rootDir: string;
  let a: WorkspaceUseLeases;
  let b: WorkspaceUseLeases;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-use-leases-"));
    a = new WorkspaceUseLeases(rootDir);
    b = new WorkspaceUseLeases(rootDir);
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  const leaseFiles = async () =>
    (await fsPromises.readdir(workspaceUseLockDir(rootDir, workspaceId)).catch(() => [])).filter(
      (name) => name.endsWith(".lock")
    );

  /** What backend A's scan of the workspace's use directory sees for each lease file. */
  const probeAll = async () =>
    Promise.all(
      (await leaseFiles()).map((name) =>
        inspectCrossProcessLock(path.join(workspaceUseLockDir(rootDir, workspaceId), name))
      )
    );

  test("B's lease is a live lease file for A; release removes it and returns B's count to 0", async () => {
    const lease = await b.hold(workspaceId, "terminal");

    expect(b.heldCount(workspaceId)).toBe(1);
    expect(a.heldCount(workspaceId)).toBe(0);
    const [file] = await leaseFiles();
    expect(file).toContain(b.instanceToken);
    expect(file).toContain("terminal");
    const [probe] = await probeAll();
    expect(probe.state === "held" && probe.holder).toContain(`pid ${process.pid}`);

    await lease.release();
    expect(b.heldCount(workspaceId)).toBe(0);
    expect(await leaseFiles()).toEqual([]);
  });

  test("a lease whose owner died probes as dead", async () => {
    await b.hold(workspaceId, "turn");
    const [file] = await leaseFiles();
    const lockPath = path.join(workspaceUseLockDir(rootDir, workspaceId), file);
    // The owner process died: its record names a token no live process holds.
    const record = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as object;
    await fsPromises.writeFile(lockPath, JSON.stringify({ ...record, token: "dead-owner" }));

    expect(await probeAll()).toEqual([{ state: "dead" }]);
  });

  test("holds are refcounted per kind; release is idempotent", async () => {
    const first = await b.hold(workspaceId, "turn");
    const second = await b.hold(workspaceId, "turn");
    const terminal = await b.hold(workspaceId, "terminal");
    expect(b.heldCount(workspaceId, "turn")).toBe(2);
    expect(b.heldCount(workspaceId)).toBe(3);
    expect((await leaseFiles()).length).toBe(2);

    await first.release();
    await first.release(); // A second release of one lease must not drop another holder's count.
    // A concurrent second call awaits the same release instead of returning before it lands.
    const again = await b.hold(workspaceId, "exec");
    const racing = again.release();
    await again.release();
    expect(b.heldCount(workspaceId, "exec")).toBe(0);
    expect((await leaseFiles()).some((name) => name.includes(".exec."))).toBe(false);
    await racing;
    expect(b.heldCount(workspaceId, "turn")).toBe(1);
    expect((await leaseFiles()).length).toBe(2);

    await Promise.all([second.release(), terminal.release()]);
    expect(b.heldCount(workspaceId)).toBe(0);
    expect(await leaseFiles()).toEqual([]);
  });

  test("concurrent holds share one file and a hold racing the last release keeps its file", async () => {
    const [first, second] = await Promise.all([
      b.hold(workspaceId, "turn"),
      b.hold(workspaceId, "turn"),
    ]);
    expect(b.heldCount(workspaceId, "turn")).toBe(2);
    expect((await leaseFiles()).length).toBe(1);
    await second.release();

    // The 1→0 release and a new 0→1 hold interleave; the survivor must still have a live file.
    const [, third] = await Promise.all([first.release(), b.hold(workspaceId, "turn")]);
    expect(b.heldCount(workspaceId, "turn")).toBe(1);
    expect((await probeAll()).map((probe) => probe.state)).toEqual(["held"]);
    await third.release();
    expect(await leaseFiles()).toEqual([]);
  });

  test("a hold that observes a live mutation gate throws and leaves no lease", async () => {
    // A's structural mutation holds the gate (the gate helper itself arrives with its call sites).
    const releaseGate = await acquireCrossProcessLock({
      lockPath: workspaceMutationLockPath(rootDir, workspaceId),
      acquireTimeoutMs: 0,
      staleMs: 60_000,
      timeoutMessage: "gate busy",
    });

    let refused: unknown;
    try {
      await b.hold(workspaceId, "turn");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(WorkspaceMutationInProgressError);
    expect((refused as Error).message).toContain(`pid ${process.pid}`);
    expect(b.heldCount(workspaceId)).toBe(0);
    expect(await leaseFiles()).toEqual([]);

    await releaseGate();
    const lease = await b.hold(workspaceId, "turn");
    expect(b.heldCount(workspaceId)).toBe(1);
    await lease.release();
  });

  test("a dead mutator's gate does not refuse a hold", async () => {
    const gatePath = workspaceMutationLockPath(rootDir, workspaceId);
    const releaseGate = await acquireCrossProcessLock({
      lockPath: gatePath,
      acquireTimeoutMs: 0,
      staleMs: 60_000,
      timeoutMessage: "gate busy",
    });
    const record = JSON.parse(await fsPromises.readFile(gatePath, "utf-8")) as object;
    await fsPromises.writeFile(gatePath, JSON.stringify({ ...record, token: "dead-mutator" }));

    const lease = await b.hold(workspaceId, "turn");
    expect(b.heldCount(workspaceId)).toBe(1);
    await lease.release();
    await releaseGate(); // Not ours anymore: leaves the dead record alone.
  });

  test("counts of one workspace never include another's, whatever the ids contain", async () => {
    const lease = await b.hold("a\0b", "turn");
    expect(b.heldCount("a")).toBe(0);
    expect(b.heldCount("a\0b")).toBe(1);
    await lease.release();
  });

  test("workspace ids never escape the lock directories", () => {
    const useParent = path.dirname(workspaceUseLockDir(rootDir, workspaceId));
    const gateParent = path.dirname(workspaceMutationLockPath(rootDir, workspaceId));
    const hostileIds = [
      "../../etc/passwd",
      ".",
      "..",
      "%".repeat(300),
      "x".repeat(300),
      "CON",
      "Foo",
      "foo",
    ];
    for (const hostile of hostileIds) {
      const useDir = workspaceUseLockDir(rootDir, hostile);
      expect(path.dirname(useDir)).toBe(useParent);
      expect(path.basename(useDir)).toMatch(/^[0-9a-f]{64}$/);
      expect(path.basename(useDir).length).toBeLessThan(100);
      const gate = workspaceMutationLockPath(rootDir, hostile);
      expect(path.dirname(gate)).toBe(gateParent);
      expect(path.basename(gate).length).toBeLessThan(100);
    }
    // Distinct lone surrogates, which UTF-8 would both encode as U+FFFD.
    hostileIds.push("\ud800", "\udc00");
    // Distinct ids never share a directory, even on a case-insensitive filesystem.
    const names = new Set(
      [...hostileIds, workspaceId].map((id) => workspaceUseLockDir(rootDir, id).toLowerCase())
    );
    expect(names.size).toBe(hostileIds.length + 1);
  });
});
