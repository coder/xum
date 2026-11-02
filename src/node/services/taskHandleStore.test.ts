import * as path from "path";
import { describe, expect, it } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";

import { Config } from "@/node/config";
import {
  TaskHandleStore,
  WORKSPACE_TURN_TASK_ID_PREFIX,
  type WorkspaceTurnTaskHandleRecord,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";

async function createTempConfig(testName: string): Promise<{ config: Config; rootDir: string }> {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${testName}-`));
  const config = new Config(rootDir);
  await fsPromises.mkdir(config.srcDir, { recursive: true });
  return { config, rootDir };
}

describe("TaskHandleStore", () => {
  it("persists and lists owner-scoped workspace turn handles", async () => {
    const { config } = await createTempConfig("task-handle-store-persist");
    const store = new TaskHandleStore(config);

    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`,
      ownerWorkspaceId: "owner",
      workspaceId: "child",
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Summary",
      prompt: "Summarize",
    });

    const record = await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`);
    expect(record?.workspaceId).toBe("child");

    expect(await store.getWorkspaceTurn("other", `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`)).toBeNull();
    expect(await store.isWorkspaceOwnedBy("owner", "child")).toBe(true);
    expect(await store.isWorkspaceOwnedBy("other", "child")).toBe(false);

    const listed = await store.listWorkspaceTurns("owner", { statuses: ["running"] });
    expect(listed.map((item) => item.handleId)).toEqual([`${WORKSPACE_TURN_TASK_ID_PREFIX}abc`]);
  });

  it("rejects unsafe handle IDs before composing paths", async () => {
    const { config } = await createTempConfig("task-handle-store-unsafe-id");
    const store = new TaskHandleStore(config);
    const sessionDir = path.join(config.sessionsDir, "owner");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "chat.json"),
      JSON.stringify({
        kind: "workspace_turn",
        handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}x/../../chat`,
        ownerWorkspaceId: "owner",
        workspaceId: "escaped",
        turnId: "turn-1",
        status: "completed",
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
      })
    );

    expect(
      await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}x/../../chat`)
    ).toBeNull();
  });

  it("self-heals corrupt handle records by ignoring them", async () => {
    const { config } = await createTempConfig("task-handle-store-corrupt");
    const store = new TaskHandleStore(config);
    const sessionDir = path.join(config.sessionsDir, "owner");
    await fsPromises.mkdir(path.join(sessionDir, "task-handles"), { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "task-handles", `${WORKSPACE_TURN_TASK_ID_PREFIX}bad.json`),
      "not json"
    );

    expect(await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}bad`)).toBeNull();
    expect(await store.listWorkspaceTurns("owner")).toEqual([]);
  });
});

interface ScanOptions {
  statuses?: readonly WorkspaceTurnTaskStatus[];
}

/** The largest Date: every real file stamp is older than the scan's racy margin. */
const TRUSTED_CLOCK = () => 8.64e15;
const ACTIVE: ScanOptions = { statuses: ["queued", "starting", "running"] };
const SCAN_FILTERS: readonly ScanOptions[] = [
  {},
  ACTIVE,
  { statuses: ["completed", "interrupted", "error"] },
  { statuses: ["starting", "running"] },
];
const EARLY = "2026-08-10T00:00:00.000Z";
const MIDDLE = "2026-08-10T00:00:01.000Z";
const LATE = "2026-08-10T00:00:02.000Z";

function turnRecord(
  ownerWorkspaceId: string,
  name: string,
  status: WorkspaceTurnTaskStatus,
  createdAt = EARLY
): WorkspaceTurnTaskHandleRecord {
  return {
    kind: "workspace_turn",
    handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}${name}`,
    ownerWorkspaceId,
    workspaceId: `child-${name}`,
    turnId: `turn-${name}`,
    status,
    createdAt,
    updatedAt: createdAt,
    createdWorkspace: true,
    disposableWorkspace: false,
  };
}

function sessionPaths(config: Config) {
  const ownerDir = (owner: string) => path.join(config.sessionsDir, owner);
  const handleDir = (owner: string) => path.join(ownerDir(owner), "task-handles");
  const handleFile = (owner: string, name: string) =>
    path.join(handleDir(owner), `${WORKSPACE_TURN_TASK_ID_PREFIX}${name}.json`);
  return { ownerDir, handleDir, handleFile };
}

/**
 * Sets the stamps of `targets` to a past time no earlier call used. Under TRUSTED_CLOCK a write in
 * the same timestamp tick as the previous scan leaves equal stamps; this models the time that
 * passes between another backend's writes.
 */
function createAger(): (...targets: string[]) => Promise<void> {
  let calls = 0;
  return async (...targets) => {
    calls += 1;
    const at = new Date(Date.UTC(2020, 0, 1) + calls * 1000);
    for (const target of targets) await fsPromises.utimes(target, at, at);
  };
}

/** The scan contract from per-owner reads: owners in readdir order, then a stable createdAt sort. */
async function recordsFromOwnerLists(
  config: Config,
  options: ScanOptions
): Promise<WorkspaceTurnTaskHandleRecord[]> {
  const store = new TaskHandleStore(config);
  const owners = (await fsPromises.readdir(config.sessionsDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory()
  );
  const perOwner = await Promise.all(
    owners.map((owner) => store.listWorkspaceTurns(owner.name, options))
  );
  return perOwner.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Starts at a different filter each call, so each kind of filter runs the first, refreshing scan. */
async function expectScansMatchFreshReads(
  store: TaskHandleStore,
  config: Config,
  firstFilter: number
): Promise<void> {
  for (let offset = 0; offset < SCAN_FILTERS.length; offset++) {
    const options = SCAN_FILTERS[(firstFilter + offset) % SCAN_FILTERS.length];
    const cold = await new TaskHandleStore(config).scanAllWorkspaceTurns(options);
    expect(cold).toEqual({ records: await recordsFromOwnerLists(config, options), complete: true });
    expect(await store.scanAllWorkspaceTurns(options)).toEqual(cold);
  }
}

describe("TaskHandleStore global scan", () => {
  it.each([
    ["the real clock", {}],
    ["a trusted clock", { now: TRUSTED_CLOCK }],
  ])(
    "a warm scan matches fresh reads through writes, deletes and owner changes (%s)",
    async (_clock, options) => {
      const { config } = await createTempConfig("task-handle-store-oracle");
      const { ownerDir, handleDir, handleFile } = sessionPaths(config);
      const store = new TaskHandleStore(config, undefined, options);
      const otherBackend = new TaskHandleStore(config);
      const age = createAger();
      for (const record of [
        turnRecord("owner-a", "a1", "running", MIDDLE),
        turnRecord("owner-a", "a2", "completed", MIDDLE),
        turnRecord("owner-a", "a3", "queued", LATE),
        turnRecord("owner-b", "b1", "starting", MIDDLE),
        turnRecord("owner-b", "b2", "error"),
      ]) {
        await otherBackend.upsertWorkspaceTurn(record);
      }
      await fsPromises.writeFile(handleFile("owner-a", "corrupt"), "not json");
      await fsPromises.writeFile(`${handleFile("owner-a", "a1")}.0123456789ab`, "{}");
      await fsPromises.mkdir(ownerDir("owner-c"));

      // Each step returns the paths whose stamps it changed.
      const steps: Array<() => Promise<string[]>> = [
        async () => {
          await otherBackend.upsertWorkspaceTurn(turnRecord("owner-a", "a2", "running", MIDDLE));
          return [handleDir("owner-a"), handleFile("owner-a", "a2")];
        },
        async () => {
          await otherBackend.upsertWorkspaceTurn(turnRecord("owner-a", "a1", "completed", MIDDLE));
          return [handleDir("owner-a"), handleFile("owner-a", "a1")];
        },
        async () => {
          await store.upsertWorkspaceTurn(turnRecord("owner-b", "b3", "queued"));
          return [handleDir("owner-b"), handleFile("owner-b", "b3")];
        },
        async () => {
          await fsPromises.unlink(handleFile("owner-a", "a3"));
          return [handleDir("owner-a")];
        },
        async () => {
          await otherBackend.upsertWorkspaceTurn(turnRecord("owner-d", "d1", "running"));
          return [ownerDir("owner-d"), handleDir("owner-d"), handleFile("owner-d", "d1")];
        },
        async () => {
          await otherBackend.upsertWorkspaceTurn(turnRecord("owner-c", "c1", "running", LATE));
          return [ownerDir("owner-c"), handleDir("owner-c"), handleFile("owner-c", "c1")];
        },
        async () => {
          await fsPromises.rm(ownerDir("owner-b"), { recursive: true });
          return [];
        },
        async () => {
          await fsPromises.mkdir(ownerDir("owner-e"));
          return [ownerDir("owner-e")];
        },
        async () => {
          await fsPromises.writeFile(handleFile("owner-c", "corrupt"), "{");
          return [handleDir("owner-c"), handleFile("owner-c", "corrupt")];
        },
        async () => {
          await store.upsertWorkspaceTurn(turnRecord("owner-c", "c1", "interrupted", LATE));
          return [handleDir("owner-c"), handleFile("owner-c", "c1")];
        },
      ];

      await expectScansMatchFreshReads(store, config, 0);
      for (const [index, step] of steps.entries()) {
        await age(...(await step()));
        await expectScansMatchFreshReads(store, config, index + 1);
      }
    }
  );

  it("shows this store's own writes on the next scan, with no stamp change", async () => {
    const { config } = await createTempConfig("task-handle-store-own-write");
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    await fsPromises.mkdir(sessionPaths(config).ownerDir("owner"), { recursive: true });
    expect(await store.scanAllWorkspaceTurns(ACTIVE)).toEqual({ records: [], complete: true });

    const running = turnRecord("owner", "own", "running");
    await store.upsertWorkspaceTurn(running);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([running]);

    const completed = turnRecord("owner", "own", "completed");
    await store.upsertWorkspaceTurn(completed);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([]);
    expect(await store.listAllWorkspaceTurns()).toEqual([completed]);

    await store.upsertWorkspaceTurn(running);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([running]);
  });

  it("shows another store's status change once the stamps move", async () => {
    const { config } = await createTempConfig("task-handle-store-other-backend");
    const { handleDir, handleFile } = sessionPaths(config);
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    const otherBackend = new TaskHandleStore(config);
    const age = createAger();
    const completed = turnRecord("owner", "flip", "completed");
    await otherBackend.upsertWorkspaceTurn(completed);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([]);

    const running = turnRecord("owner", "flip", "running");
    await otherBackend.upsertWorkspaceTurn(running);
    await age(handleDir("owner"), handleFile("owner", "flip"));
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([running]);

    await otherBackend.upsertWorkspaceTurn(completed);
    await age(handleDir("owner"), handleFile("owner", "flip"));
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([]);
    expect(await store.listAllWorkspaceTurns()).toEqual([completed]);
  });

  it("shows handles in a new owner directory and in an owner that had none", async () => {
    const { config } = await createTempConfig("task-handle-store-new-owner");
    const { ownerDir, handleDir, handleFile } = sessionPaths(config);
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    const otherBackend = new TaskHandleStore(config);
    const age = createAger();
    await fsPromises.mkdir(ownerDir("empty-owner"), { recursive: true });
    expect(await store.scanAllWorkspaceTurns(ACTIVE)).toEqual({ records: [], complete: true });

    const fresh = turnRecord("new-owner", "fresh", "running");
    await otherBackend.upsertWorkspaceTurn(fresh);
    await age(ownerDir("new-owner"), handleDir("new-owner"), handleFile("new-owner", "fresh"));
    const late = turnRecord("empty-owner", "late", "queued", LATE);
    await otherBackend.upsertWorkspaceTurn(late);
    await age(ownerDir("empty-owner"), handleDir("empty-owner"), handleFile("empty-owner", "late"));
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([fresh, late]);
  });

  it("drops a deleted handle file", async () => {
    const { config } = await createTempConfig("task-handle-store-unlink");
    const { handleDir, handleFile } = sessionPaths(config);
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    const kept = turnRecord("owner", "kept", "running");
    const deleted = turnRecord("owner", "deleted", "running", LATE);
    await store.upsertWorkspaceTurn(kept);
    await store.upsertWorkspaceTurn(deleted);
    expect(await store.listAllWorkspaceTurns()).toEqual([kept, deleted]);

    await fsPromises.unlink(handleFile("owner", "deleted"));
    await createAger()(handleDir("owner"));
    expect(await store.listAllWorkspaceTurns()).toEqual([kept]);
  });

  it("re-reads a file rewritten in place after a scan that saw recent stamps", async () => {
    const { config } = await createTempConfig("task-handle-store-racy");
    const file = sessionPaths(config).handleFile("owner", "inplace");
    let now = 0;
    const store = new TaskHandleStore(config, undefined, { now: () => now });
    const completed = { ...turnRecord("owner", "inplace", "completed"), title: "a" };
    await store.upsertWorkspaceTurn(completed);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([]);

    // Same size, same inode, and likely the same timestamp tick: only the stamps' age tells the
    // scan that its first look proves nothing.
    const running = { ...turnRecord("owner", "inplace", "running"), title: "abc" };
    const sizeBefore = (await fsPromises.stat(file)).size;
    await fsPromises.writeFile(file, JSON.stringify(running, null, 2));
    expect((await fsPromises.stat(file)).size).toBe(sizeBefore);
    now = TRUSTED_CLOCK();
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([running]);
  });

  it("shows an in-place rewrite after a trusted scan", async () => {
    const { config } = await createTempConfig("task-handle-store-in-place");
    const { handleDir, handleFile } = sessionPaths(config);
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    await store.upsertWorkspaceTurn(turnRecord("owner", "revived", "completed"));
    await store.upsertWorkspaceTurn(turnRecord("owner", "other", "completed"));
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([]);

    // Builds before #4413 rewrite a handle in place, which leaves the directory stamps unchanged.
    const dirBefore = await fsPromises.stat(handleDir("owner"), { bigint: true });
    const running = turnRecord("owner", "revived", "running");
    await fsPromises.writeFile(handleFile("owner", "revived"), JSON.stringify(running, null, 2));
    await createAger()(handleFile("owner", "revived"));
    const dirAfter = await fsPromises.stat(handleDir("owner"), { bigint: true });
    expect([dirAfter.mtimeNs, dirAfter.ctimeNs]).toEqual([dirBefore.mtimeNs, dirBefore.ctimeNs]);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([running]);
  });

  it("leaves out a handle whose file no longer holds a selected status", async () => {
    const { config } = await createTempConfig("task-handle-store-recheck");
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    const running = turnRecord("owner", "recheck", "running");
    await store.upsertWorkspaceTurn(running);
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([running]);

    const completed = turnRecord("owner", "recheck", "completed");
    await fsPromises.writeFile(
      sessionPaths(config).handleFile("owner", "recheck"),
      JSON.stringify(completed, null, 2)
    );
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([]);
    expect(await store.listAllWorkspaceTurns()).toEqual([completed]);
  });

  it("reports an unreadable owner as incomplete until it is readable again", async () => {
    const { config } = await createTempConfig("task-handle-store-owner-isolation");
    const { ownerDir, handleDir, handleFile } = sessionPaths(config);
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    const otherBackend = new TaskHandleStore(config);
    const age = createAger();
    const good = turnRecord("good-owner", "good", "running");
    const bad = turnRecord("bad-owner", "bad", "running", LATE);
    await otherBackend.upsertWorkspaceTurn(good);
    await otherBackend.upsertWorkspaceTurn(bad);
    expect(await store.scanAllWorkspaceTurns()).toEqual({ records: [good, bad], complete: true });

    // A regular file where the directory belongs: readdir fails with ENOTDIR, even as root.
    await fsPromises.rm(handleDir("bad-owner"), { recursive: true });
    await fsPromises.writeFile(handleDir("bad-owner"), "");
    await age(ownerDir("bad-owner"), handleDir("bad-owner"));
    for (let scan = 0; scan < 2; scan++) {
      expect(await store.scanAllWorkspaceTurns()).toEqual({ records: [good], complete: false });
    }

    await fsPromises.rm(handleDir("bad-owner"));
    await otherBackend.upsertWorkspaceTurn(bad);
    await age(ownerDir("bad-owner"), handleDir("bad-owner"), handleFile("bad-owner", "bad"));
    expect(await store.scanAllWorkspaceTurns()).toEqual({ records: [good, bad], complete: true });
  });

  it("returns records that callers can mutate without changing later scans", async () => {
    const { config } = await createTempConfig("task-handle-store-isolation");
    const store = new TaskHandleStore(config, undefined, { now: TRUSTED_CLOCK });
    const record = { ...turnRecord("owner", "mutable", "running"), deferredMessageIds: ["m1"] };
    const expected = structuredClone(record);
    await store.upsertWorkspaceTurn(record);
    record.deferredMessageIds.push("after-write");

    const scanned = await store.listAllWorkspaceTurns(ACTIVE);
    expect(scanned).toEqual([expected]);
    scanned[0].status = "error";
    scanned[0].deferredMessageIds?.push("after-scan");
    expect(await store.listAllWorkspaceTurns(ACTIVE)).toEqual([expected]);
  });
});
