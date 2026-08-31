import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MonitorArmedPayload } from "@/node/services/backgroundProcessManager";
import {
  BASH_MONITOR_REGISTRY_DIR,
  BashMonitorRegistryStore,
} from "@/node/services/bashMonitorRegistryStore";

function makeConfig(rootDir: string): { sessionsDir: string } {
  return { sessionsDir: path.join(rootDir, "sessions") };
}

function armedPayload(overrides: Partial<MonitorArmedPayload> = {}): MonitorArmedPayload {
  return {
    processId: "proc-1",
    taskId: "bash:proc-1",
    workspaceId: "owner-1",
    displayName: "Dev Server",
    filter: "ERROR",
    filterExclude: false,
    script: "echo hi",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("BashMonitorRegistryStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bash-monitor-registry-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("upsert/list/remove lifecycle", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload());
    await store.upsert(armedPayload({ processId: "proc-2", taskId: "bash:proc-2" }));

    const records = await store.listAll("owner-1");
    expect(records.map((record) => record.processId)).toEqual(["proc-1", "proc-2"]);
    expect(records[0]).toMatchObject({
      ownerWorkspaceId: "owner-1",
      taskId: "bash:proc-1",
      filter: "ERROR",
      script: "echo hi",
    });

    await store.remove("owner-1", "proc-1");
    expect((await store.listAll("owner-1")).map((record) => record.processId)).toEqual(["proc-2"]);

    // remove is idempotent for already-deleted records
    await store.remove("owner-1", "proc-1");
  });

  test("upsert replaces an existing record for the same process", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload({ filter: "ERROR" }));
    await store.upsert(armedPayload({ filter: "READY" }));

    const records = await store.listAll("owner-1");
    expect(records).toHaveLength(1);
    expect(records[0].filter).toBe("READY");
  });

  test("skips malformed records when listing", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload());
    const dir = path.join(config.sessionsDir, "owner-1", BASH_MONITOR_REGISTRY_DIR);
    await fsPromises.writeFile(path.join(dir, "bad.json"), "not json", "utf-8");
    await fsPromises.writeFile(
      path.join(dir, "wrong-shape.json"),
      JSON.stringify({ hello: "world" }),
      "utf-8"
    );

    const records = await store.listAll("owner-1");
    expect(records.map((record) => record.processId)).toEqual(["proc-1"]);
  });

  test("listOwnerWorkspaceIds returns only owners with records", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload({ workspaceId: "owner-b" }));
    await store.upsert(armedPayload({ workspaceId: "owner-a" }));
    await store.remove("owner-b", "proc-1");
    // Session dir without a registry dir must be skipped, not crash the walk.
    await fsPromises.mkdir(path.join(config.sessionsDir, "owner-empty"), { recursive: true });

    expect(await store.listOwnerWorkspaceIds()).toEqual({
      ownerWorkspaceIds: ["owner-a"],
      scanFailed: false,
    });
  });

  test("one unreadable session does not block owner discovery for others", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload({ workspaceId: "owner-good" }));
    // A plain file where the registry directory should be makes listAll reject with ENOTDIR.
    const badSession = path.join(config.sessionsDir, "owner-bad");
    await fsPromises.mkdir(badSession, { recursive: true });
    await fsPromises.writeFile(path.join(badSession, BASH_MONITOR_REGISTRY_DIR), "not a dir");

    expect(await store.listOwnerWorkspaceIds()).toEqual({
      ownerWorkspaceIds: ["owner-good"],
      scanFailed: true,
    });
  });

  test("consumeIfArmedBefore takes stale records but preserves live replacements", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    const cutoffMs = Date.parse("2026-06-01T00:00:00.000Z");

    // Stale record (armed before cutoff) is consumed and returned.
    await store.upsert(armedPayload({ createdAt: "2026-01-01T00:00:00.000Z" }));
    const consumed = await store.consumeIfArmedBefore("owner-1", "proc-1", cutoffMs);
    expect(consumed?.processId).toBe("proc-1");
    expect(await store.listAll("owner-1")).toHaveLength(0);

    // Live record (re-armed at/after cutoff, e.g. by a workspace resumed during recovery)
    // must survive and yield null so no false monitor-lost wake is enqueued for it.
    await store.upsert(armedPayload({ createdAt: "2026-06-01T00:00:00.000Z" }));
    expect(await store.consumeIfArmedBefore("owner-1", "proc-1", cutoffMs)).toBeNull();
    expect(await store.listAll("owner-1")).toHaveLength(1);

    // Missing record yields null.
    expect(await store.consumeIfArmedBefore("owner-1", "proc-missing", cutoffMs)).toBeNull();
  });

  test("keeps a stale record when the pre-remove callback fails", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    const cutoffMs = Date.parse("2026-06-01T00:00:00.000Z");
    await store.upsert(armedPayload({ createdAt: "2026-01-01T00:00:00.000Z" }));

    let rejection: unknown;
    try {
      await store.consumeIfArmedBefore("owner-1", "proc-1", cutoffMs, () =>
        Promise.reject(new Error("wake persistence failed"))
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) throw new Error("expected callback rejection");
    expect(rejection.message).toBe("wake persistence failed");
    expect(await store.listAll("owner-1")).toHaveLength(1);
  });

  test("bounds persisted script length", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload({ script: "x".repeat(10_000) }));

    const records = await store.listAll("owner-1");
    expect(Buffer.byteLength(records[0].script, "utf8")).toBeLessThan(2_200);
    expect(records[0].script.endsWith("… [truncated]")).toBe(true);
  });
});
