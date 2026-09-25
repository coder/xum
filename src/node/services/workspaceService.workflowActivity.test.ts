import { describe, expect, test, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import { Ok } from "@/common/types/result";
import { createTestHistoryService } from "./testHistoryService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { WorkflowRunStore } from "./workflows/WorkflowRunStore";
import {
  createDeferred,
  createMockAIService,
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
  createFrontendWorkspaceMetadata,
} from "./workspaceService.testHarness";

describe("WorkspaceService workflow activity", () => {
  test("defers archived workflow stores until unarchive but retains live events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scanSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const projectPath = path.join(config.rootDir, "project");
      for (const id of ["active", "archived", "unarchived"]) {
        await config.addWorkspace(projectPath, {
          id,
          name: id,
          projectPath,
          projectName: "project",
          createdAt: "2026-01-01T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          archivedAt: id === "active" ? undefined : "2026-01-02T00:00:00.000Z",
          unarchivedAt: id === "unarchived" ? "2026-01-03T00:00:00.000Z" : undefined,
        });
        const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, id) });
        await runStore.createRun({
          id: "wfr_" + id,
          workspaceId: id,
          workflow: { name: "demo", description: "Demo", scope: "global", executable: true },
          source: "export default function workflow() { return {}; }",
          args: {},
          now: "2026-01-01T00:00:00.000Z",
        });
      }
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const metadataSpy = spyOn(config, "getAllWorkspaceMetadata");
      const internals = workspaceService as unknown as {
        activeWorkflowRunIdsByWorkspace: Map<string, ReadonlySet<string>>;
      };
      const activity = await workspaceService.getActivityList();
      expect(activity?.active?.activeWorkflowRunIds).toEqual(["wfr_active"]);
      expect(activity?.unarchived?.activeWorkflowRunIds).toEqual(["wfr_unarchived"]);
      expect(activity?.archived).toBeUndefined();
      expect(scanSpy).toHaveBeenCalledTimes(2);
      expect(metadataSpy.mock.calls.every(([options]) => options?.probeCheckouts === false)).toBe(
        true
      );
      // The list walk installs caches only for the stores it actually bootstrapped; a dormant
      // archived workspace gets no placeholder entry.
      expect([...internals.activeWorkflowRunIdsByWorkspace.keys()].sort()).toEqual([
        "active",
        "unarchived",
      ]);

      await workspaceService.emitWorkflowRunActivity({
        workspaceId: "archived",
        runId: "wfr_live",
        status: "running",
      });
      expect(internals.activeWorkflowRunIdsByWorkspace.has("archived")).toBe(true);
      expect((await workspaceService.getActivityList())?.archived?.activeWorkflowRunIds).toEqual([
        "wfr_live",
      ]);
      expect(scanSpy).toHaveBeenCalledTimes(2);
      await workspaceService.emitWorkflowRunActivity({
        workspaceId: "archived",
        runId: "wfr_live",
        status: "completed",
      });

      expect(await workspaceService.unarchive("archived")).toEqual(Ok(undefined));
      expect((await workspaceService.getActivityList())?.archived?.activeWorkflowRunIds).toEqual([
        "wfr_archived",
      ]);
      expect(scanSpy).toHaveBeenCalledTimes(3);
    } finally {
      scanSpy.mockRestore();
      await cleanup();
    }
  });

  test("activity list reports an archived run installed by an event during its later awaits", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scanSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: "archived",
        name: "archived",
        projectPath,
        projectName: "project",
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        archivedAt: "2026-01-02T00:00:00.000Z",
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // The list reads snapshots once before the per-id probes and again afterwards; gate
      // the second read so the event lands after the archived probe resolved its detached
      // empty set but before the response is assembled.
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      const secondReadReached = Promise.withResolvers<void>();
      const secondReadGate = Promise.withResolvers<void>();
      let snapshotReads = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotReads += 1;
          if (snapshotReads === 2) {
            secondReadReached.resolve();
            await secondReadGate.promise;
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const list = workspaceService.getActivityList();
        await secondReadReached.promise;
        await workspaceService.emitWorkflowRunActivity({
          workspaceId: "archived",
          runId: "wfr_live",
          status: "running",
        });
        secondReadGate.resolve();
        expect((await list)?.archived?.activeWorkflowRunIds).toEqual(["wfr_live"]);
        expect(scanSpy).not.toHaveBeenCalled();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      scanSpy.mockRestore();
      await cleanup();
    }
  });

  test("archived reads converge on a set a workflow event installs during the await", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scanSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: "archived",
        name: "archived",
        projectPath,
        projectName: "project",
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        archivedAt: "2026-01-02T00:00:00.000Z",
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const internals = workspaceService as unknown as {
        getActiveWorkflowRunIds: (workspaceId: string) => Promise<ReadonlySet<string>>;
        activeWorkflowRunIdsByWorkspace: Map<string, ReadonlySet<string>>;
      };

      // The list-style read resolves its (dormant, detached) answer synchronously; the event
      // lands in the microtask gap before the read's continuation runs.
      const read = internals.getActiveWorkflowRunIds("archived");
      const event = workspaceService.emitWorkflowRunActivity({
        workspaceId: "archived",
        runId: "wfr_live",
        status: "running",
      });
      await event;
      expect([...(await read)]).toEqual(["wfr_live"]);
      expect(internals.activeWorkflowRunIdsByWorkspace.get("archived")).toBe(await read);
      // Dormant stores are never scanned on either path.
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
      await cleanup();
    }
  });

  test("caches active workflow run counts and updates emitted activity from status events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "workflow-activity";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-activity",
        projectName: "project",
        projectPath,
        createdAt: "2026-06-17T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, workspaceId),
      });
      const definition = {
        name: "demo",
        description: "Demo workflow",
        scope: "global" as const,
        executable: true,
      };
      await runStore.createRun({
        id: "wfr_active",
        workspaceId,
        workflow: definition,
        source: "export default function workflow() { return {}; }",
        args: {},
        now: "2026-06-17T00:00:00.000Z",
      });
      await runStore.createRun({
        id: "wfr_nested",
        workspaceId,
        workflow: definition,
        source: "export default function workflow() { return {}; }",
        args: {},
        parentWorkflow: { runId: "wfr_active", stepId: "child", inputHash: "hash", depth: 0 },
        now: "2026-06-17T00:00:01.000Z",
      });

      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunIds
      ).toEqual(["wfr_active"]);
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBe(1);
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBe(1);
      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);

      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_active",
        status: "completed",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunIds).toBeUndefined();
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBeUndefined();

      const clearedActivityList = await workspaceService.getActivityList();
      expect(clearedActivityList?.[workspaceId]).toBeDefined();
      expect(clearedActivityList?.[workspaceId]?.activeWorkflowRunCount).toBeUndefined();

      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_next",
        status: "running",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunIds).toEqual(["wfr_next"]);
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);
      await workspaceService.updateAgentStatus(workspaceId, {
        emoji: "🔄",
        message: "Still running workflow",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);

      workspaceService.emitWorkspaceActivity(workspaceId, {
        recency: Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);

      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("shares initial active workflow cache bootstrap across parallel status events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scanStarted = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    const listStatusSnapshotsSpy = spyOn(
      WorkflowRunStore.prototype,
      "listRunStatusSnapshots"
    ).mockImplementation(async () => {
      scanStarted.resolve();
      await releaseScan.promise;
      return [];
    });

    try {
      const workspaceId = "workflow-activity-race";
      // getActivityList only emits entries for config-known workspaces.
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));

      const first = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "running",
      });
      await scanStarted.promise;
      const second = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "running",
      });

      releaseScan.resolve();
      await Promise.all([first, second]);

      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(2);
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBe(2);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      releaseScan.resolve();
      await cleanup();
    }
  });

  test("emits current workflow count after overlapping metadata snapshot reads", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const firstSnapshotStarted = createDeferred<void>();
    const releaseFirstSnapshot = createDeferred<void>();
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const getSnapshotSpy = spyOn(extensionMetadata, "getSnapshot");

    try {
      const workspaceId = "workflow-activity-overlap";
      // getActivityList only emits entries for config-known workspaces; keep
      // this workspace known so the zero-count assertion below exercises the
      // tombstone path rather than trivially missing the entry.
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "running",
      });
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "running",
      });

      let shouldDelayNextSnapshot = true;
      getSnapshotSpy.mockImplementation(async (id: string) => {
        if (shouldDelayNextSnapshot) {
          shouldDelayNextSnapshot = false;
          firstSnapshotStarted.resolve();
          await releaseFirstSnapshot.promise;
        }
        return ExtensionMetadataService.prototype.getSnapshot.call(extensionMetadata, id);
      });
      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));

      const first = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "completed",
      });
      await firstSnapshotStarted.promise;
      const second = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "completed",
      });

      await second;
      releaseFirstSnapshot.resolve();
      await first;

      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBeUndefined();
      expect(
        (await workspaceService.getActivityList())?.[workspaceId]?.activeWorkflowRunCount
      ).toBeUndefined();
    } finally {
      getSnapshotSpy.mockRestore();
      releaseFirstSnapshot.resolve();
      await cleanup();
    }
  });
});

describe("WorkspaceService activity list scoping", () => {
  test("drops stale extension metadata entries and lazily prunes them once", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-scoping-known";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      // Simulates the leaked entry of a removed workspace/sub-agent.
      await extensionMetadata.updateRecency("removed-workspace", 200);
      const pruneSpy = spyOn(extensionMetadata, "pruneMissingWorkspaces");
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]?.recency).toBe(100);
      expect(activityList?.["removed-workspace"]).toBeUndefined();

      // The one-time lazy cleanup dropped the stale entry from disk while
      // keeping the still-existing workspace's entry.
      const snapshots = await extensionMetadata.getAllSnapshots();
      expect(snapshots.has("removed-workspace")).toBe(false);
      expect(snapshots.get(workspaceId)?.recency).toBe(100);

      // One-time: a second bootstrap must not re-run the cleanup scan.
      await workspaceService.getActivityList();
      expect(pruneSpy).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  test("repeat lists keep omitting idle workspaces after the first list installs caches", async () => {
    // The first list's workflow probe installs an empty run cache for every
    // scoped id. Cache initialization must not read as activity: treating it
    // as the zero-count tombstone signal would emit a fabricated recency:0
    // entry for every idle config-known workspace from the second list on,
    // re-bloating exactly the payload this scoping trims.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-scoping-idle";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const firstList = await workspaceService.getActivityList();
      expect(firstList).not.toBeNull();
      expect(firstList?.[workspaceId]).toBeUndefined();
      const secondList = await workspaceService.getActivityList();
      expect(secondList).not.toBeNull();
      expect(secondList?.[workspaceId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("a run-status event racing cache eviction does not strand the seen marker", async () => {
    // An eviction (removal, or a tombstone lifted for revival) can land in
    // the microtask gap after the run cache resolves. The status event must
    // retry against the freshly installed cache instead of mutating the
    // detached set and marking the seen set — a stale marker would fabricate
    // zero-count entries for the idle revived workspace on every later list.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "evict-race";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        getActiveWorkflowRunIds(workspaceId: string): Promise<Set<string>>;
        evictWorkspaceActivityCaches(workspaceId: string): void;
      };
      const realGetActiveWorkflowRunIds = internals.getActiveWorkflowRunIds.bind(workspaceService);
      let evicted = false;
      internals.getActiveWorkflowRunIds = async (targetWorkspaceId: string) => {
        const result = await realGetActiveWorkflowRunIds(targetWorkspaceId);
        if (!evicted && targetWorkspaceId === workspaceId) {
          evicted = true;
          // Lands after the cache read resolved, before the caller's
          // continuation — the exact revival-eviction window.
          internals.evictWorkspaceActivityCaches(targetWorkspaceId);
        }
        return result;
      };

      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_race",
        status: "running",
      });
      const activity = (await workspaceService.getActivityList())?.[workspaceId];
      // The retried update must land the run in the INSTALLED cache (not a
      // detached pre-eviction set that leaves only the stale seen marker).
      expect(activity?.activeWorkflowRunCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList re-establishes the config baseline after a transient initial read failure", async () => {
    // The pre-await baseline read can fail transiently while the strict
    // scoping enumeration succeeds. Without a replacement baseline both
    // cross-process removal guards stay disabled on an authoritative
    // response: a workspace another backend deregisters during the workflow
    // probes (its metadata entry still present in the normal cleanup gap)
    // would ride back into the renderer with no event to correct it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "baseline-retry";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 321);
      const realSuperset = config.readPersistedWorkspaceIdSuperset.bind(config);
      let failedOnce = false;
      const supersetSpy = spyOn(config, "readPersistedWorkspaceIdSuperset").mockImplementation(
        () => {
          if (!failedOnce) {
            failedOnce = true;
            throw new Error("transient config read failure");
          }
          return realSuperset();
        }
      );
      let removedFromConfig = false;
      listStatusSnapshotsSpy.mockImplementation(async () => {
        if (!removedFromConfig) {
          removedFromConfig = true;
          // Another backend deregisters the workspace while the per-id
          // probe awaits; its metadata entry intentionally stays behind.
          const configPath = path.join(config.rootDir, "config.json");
          const parsed = JSON.parse(await fsPromises.readFile(configPath, "utf-8")) as {
            projects?: Array<[string, { workspaces?: Array<{ id?: string }> }]>;
          };
          for (const [, projectConfig] of parsed.projects ?? []) {
            projectConfig.workspaces = (projectConfig.workspaces ?? []).filter(
              (workspace) => workspace.id !== workspaceId
            );
          }
          await fsPromises.writeFile(configPath, JSON.stringify(parsed));
        }
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        supersetSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("prune spares both legacy identities when compatibility files disagree", async () => {
    // An id-less legacy entry can have BOTH supported session layouts with
    // different stable ids (stale basename-side file + live generated-legacy
    // metadata). findWorkspace resolves either id, so the one-time prune must
    // spare extension-metadata entries under both — classifying the second
    // identity as stale would delete activity findWorkspace still vouches
    // for.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "old-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({ projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]] })
      );
      const basenameSessionDir = path.join(config.sessionsDir, "old-ws");
      await fsPromises.mkdir(basenameSessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(basenameSessionDir, "metadata.json"),
        JSON.stringify({ id: "basename-stable-id", name: "old-ws" })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: "generated-live-id", name: "old-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("basename-stable-id", 100);
      await extensionMetadata.updateRecency("generated-live-id", 200);
      await extensionMetadata.updateRecency("truly-stale-id", 300);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();

      const snapshots = await extensionMetadata.getAllSnapshots();
      expect(snapshots.get("basename-stable-id")?.recency).toBe(100);
      expect(snapshots.get("generated-live-id")?.recency).toBe(200);
      expect(snapshots.has("truly-stale-id")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList fails closed when no raw baseline can be established", async () => {
    // If every raw baseline read fails transiently while the strict scoping
    // enumeration succeeds, both cross-process removal guards would stay
    // disabled on a response the renderer applies as authoritative — a
    // workspace another backend deregisters during the probes would ride
    // back with no event to correct it. The list must fail (null → renderer
    // keeps last-known state and retries) instead of serving guardless
    // authoritative data; only the fail-open scope (config unreadable) may
    // do that, and there the enumeration fails too.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "baseline-unavailable";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 111);
      const supersetSpy = spyOn(config, "readPersistedWorkspaceIdSuperset").mockImplementation(
        () => {
          throw new Error("persistent raw read failure");
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        expect(await workspaceService.getActivityList()).toBeNull();
      } finally {
        supersetSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("first prune also removes stale entries stranded in a sidecar", async () => {
    // Crash strands the full snapshot in .corrupt while a valid partial main
    // was recreated. The one-time prune must reconcile FIRST: sidecar-only
    // stale entries would otherwise dodge the deletion set and merge back on
    // the very next read — with the prune latched, they would keep inflating
    // every read and rewrite until restart.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "sidecar-live";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      await fsPromises.writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          workspaces: { [workspaceId]: { recency: 100, streaming: false } },
        })
      );
      await fsPromises.writeFile(
        `${metadataPath}.corrupt`,
        JSON.stringify({
          version: 1,
          workspaces: {
            [workspaceId]: { recency: 90, streaming: false },
            "sidecar-stale": { recency: 80, streaming: false },
          },
        })
      );
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.["sidecar-stale"]).toBeUndefined();

      const snapshots = await extensionMetadata.getAllSnapshots({ throwOnError: true });
      expect(snapshots.get(workspaceId)?.recency).toBe(100);
      expect(snapshots.has("sidecar-stale")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("late-admitted raw-registered ids keep their initial snapshot when re-reads fail", async () => {
    // A raw-registered entry outside the normalized scope (invalid project
    // path) is admitted through the raw config view. When both mid-list
    // snapshot re-reads fail transiently, the already-loaded initial
    // snapshot must still supply its recency/goal/status — an authoritative
    // response omitting the entry would clear that renderer state with no
    // repair event.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "raw-only-live";
      const projectPath = path.join(config.rootDir, "project");
      // Migration flags pre-seeded: without them the first load schedules an
      // async settings-migration persist that rewrites config.json through
      // the parsed view mid-test whenever it happens to land before the
      // second list's raw reads (observed flake).
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [
            [
              projectPath,
              { workspaces: [{ id: workspaceId, path: path.join(projectPath, "ws") }] },
            ],
          ],
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      // Raw-visible but enumeration-invisible: the strict normalized
      // enumeration resolves no ids while the raw persisted view carries the
      // inline id, keeping it out of the per-id scope so it takes the
      // late-candidate path. (Strict loads now reject the previously used
      // malformed-project-key vehicle, so divergence is modeled directly.)
      const enumerateSpy = spyOn(config, "getAllWorkspaceMetadata").mockResolvedValue([]);
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          // List #1 (prune latch): initial + fresh reads stay real. List #2:
          // the initial read (call 3) succeeds; the fresh and final re-reads
          // fail transiently.
          if (snapshotCalls > 3) {
            throw new Error("transient snapshot re-read failure");
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const firstList = await workspaceService.getActivityList();
        expect(firstList?.[workspaceId]?.recency).toBe(42);

        const secondList = await workspaceService.getActivityList();
        expect(secondList).not.toBeNull();
        expect(secondList?.[workspaceId]?.recency).toBe(42);
      } finally {
        snapshotsSpy.mockRestore();
        enumerateSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("mid-list enumeration proves removal when the raw refresh fails", async () => {
    // An inline-id workspace is removed by another backend while the
    // mid-list authoritative enumeration awaits, and the post-enumeration
    // raw refresh fails transiently. The raw comparison is disabled (fresh
    // view null) and the id sits in the initial baseline, so without the
    // enumeration fallback every removal guard passes and the stale entry
    // rides the authoritative response with no event to repair the
    // renderer.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "inline-removed-mid-enum";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          projects: [
            [
              projectPath,
              {
                workspaces: [
                  { id: workspaceId, path: path.join(projectPath, "ws") },
                  // Id-less legacy entry whose stable id lives in session
                  // metadata.json: raw-INVISIBLE at the initial baseline, so
                  // its retained entry forces the mid-list authoritative
                  // enumeration this test exercises (the read-time migration
                  // may persist the id later, but the baseline predates it).
                  { path: path.join(projectPath, "legacy-ws") },
                ],
              },
            ],
          ],
          // Migration flags pre-seeded: without them the first load schedules
          // an async settings-migration persist that rewrites config.json
          // through the parsed view — attaching the resolved legacy id inline
          // — which would make this entry raw-VISIBLE mid-test and skip the
          // mid-list enumeration whenever the persist lands first.
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      const legacyStableId = "legacy-stable-mid-enum";
      const legacySessionDir = path.join(config.sessionsDir, "legacy-ws");
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: legacyStableId, name: "legacy-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 77);
      await extensionMetadata.updateRecency(legacyStableId, 55);
      const realEnumerate = config.getAllWorkspaceMetadata.bind(config);
      let enumerationCalls = 0;
      let failEvidenceReads = false;
      const enumerationSpy = spyOn(config, "getAllWorkspaceMetadata").mockImplementation(
        async (options?: Parameters<typeof realEnumerate>[0]) => {
          enumerationCalls += 1;
          if (enumerationCalls === 2) {
            // Mid-list enumeration: another backend deregisters the inline-id
            // workspace just before the config read, and every later raw
            // view read fails transiently.
            const parsed = JSON.parse(await fsPromises.readFile(configPath, "utf-8")) as {
              projects: Array<[string, { workspaces: Array<{ id?: string }> }]>;
            };
            for (const [, projectConfig] of parsed.projects) {
              projectConfig.workspaces = projectConfig.workspaces.filter(
                (workspace) => workspace.id !== workspaceId
              );
            }
            await fsPromises.writeFile(configPath, JSON.stringify(parsed));
            const result = await realEnumerate(options);
            failEvidenceReads = true;
            return result;
          }
          return realEnumerate(options);
        }
      );
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          if (failEvidenceReads) {
            throw new Error("transient raw config read failure");
          }
          return realEvidence();
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        // The still-registered raw-invisible entry survives the fallback...
        expect(activityList?.[legacyStableId]?.recency).toBe(55);
        // ...while the enumeration-proven removal is dropped.
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        enumerationSpy.mockRestore();
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("final enumeration proves removal when the post-probe raw read fails", async () => {
    // An inline-id workspace is deregistered by another backend while the
    // late-candidate workflow probes await, and the post-probe raw reads
    // fail transiently. Without the enumeration fallback every raw
    // deregistration guard is disabled (finalConfigIds null) and the stale
    // retained entry rides the authoritative response with no cross-process
    // event to repair it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const removedId = "inline-removed-final";
      const survivorId = "inline-survivor-final";
      const lateId = "late-registered-final";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      const configFor = (ids: string[]): string =>
        JSON.stringify({
          projects: [
            [
              projectPath,
              { workspaces: ids.map((id) => ({ id, path: path.join(projectPath, id) })) },
            ],
          ],
          // Migration flags pre-seeded so the first load never schedules the
          // async settings-migration persist mid-test.
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        });
      await fsPromises.writeFile(configPath, configFor([removedId, survivorId]));
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(removedId, 77);
      await extensionMetadata.updateRecency(survivorId, 55);
      // Fresh snapshot re-read (call 2) doubles as the moment "another
      // backend" registers a new workspace: its id enters the fresh raw
      // view outside the initial scope, forcing the late-candidate probes
      // and with them the final post-probe views this test exercises.
      // The final-phase snapshot re-read (call 3) marks the start of the
      // post-probe views: the concurrent deregistration lands there and
      // every later raw evidence read fails transiently, so only the
      // fallback enumeration can prove the removal.
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      let failRawEvidenceReads = false;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(configPath, configFor([removedId, survivorId, lateId]));
          }
          if (snapshotCalls === 3) {
            await fsPromises.writeFile(configPath, configFor([survivorId, lateId]));
            failRawEvidenceReads = true;
          }
          return realGetAllSnapshots(options);
        }
      );
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          if (failRawEvidenceReads) {
            throw new Error("transient raw config read failure");
          }
          return realEvidence();
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[survivorId]?.recency).toBe(55);
        // The enumeration-proven removal is dropped despite the raw view
        // being unreadable.
        expect(activityList?.[removedId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("foreign removals observed mid-list evict process-local activity caches", async () => {
    // A cross-process removal publishes no local tombstone, so the
    // tombstone-cleared eviction listener never fires. Without eviction at
    // the removal guards, the removed incarnation's workflow caches survive
    // — and a downgraded backend re-registering the same deterministic
    // legacy id would then be served ghost runs instead of a fresh probe.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "foreign-removed-evict";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      const configFor = (ids: string[]): string =>
        JSON.stringify({
          projects: [
            [
              projectPath,
              { workspaces: ids.map((id) => ({ id, path: path.join(projectPath, id) })) },
            ],
          ],
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        });
      await fsPromises.writeFile(configPath, configFor([workspaceId]));
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const first = await workspaceService.getActivityList();
      expect(first?.[workspaceId]?.recency).toBe(42);
      const internals = workspaceService as unknown as {
        activeWorkflowRunIdsByWorkspace: Map<string, ReadonlySet<string>>;
      };
      expect(internals.activeWorkflowRunIdsByWorkspace.has(workspaceId)).toBe(true);
      // Another backend removes the workspace between the second list's
      // initial and fresh raw reads (its metadata cleanup may lag).
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(configPath, configFor([]));
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const second = await workspaceService.getActivityList();
        expect(second?.[workspaceId]).toBeUndefined();
        expect(internals.activeWorkflowRunIdsByWorkspace.has(workspaceId)).toBe(false);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("first bootstrap reuses the prune's config enumeration for scoping", async () => {
    // getAllWorkspaceMetadata walks every workspace with per-workspace disk
    // probes; the latency-sensitive first bootstrap must not pay it twice.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-scoping-reuse";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      await extensionMetadata.updateRecency("removed-workspace", 200);
      const metadataSpy = spyOn(config, "getAllWorkspaceMetadata");
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]?.recency).toBe(100);
      expect(activityList?.["removed-workspace"]).toBeUndefined();
      // The single walk belongs to the prune's initial enumeration: the
      // list's SCOPING reuses the prune's ids, and the prune's mid-pass
      // re-registration recheck uses the raw config view (complete evidence
      // here — every persisted workspace id is inline) instead of repeating
      // the per-workspace walk while the metadata queue blocks live writes.
      expect(metadataSpy).toHaveBeenCalledTimes(1);
      // The stale entry really was reclaimed on disk, not merely filtered.
      expect((await extensionMetadata.getAllSnapshots()).has("removed-workspace")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("first bootstrap scope keeps raw-registered ids the normalized view cannot see", async () => {
    // A duplicate project path key (e.g. a trailing-slash variant) shadows
    // the earlier pair in the normalized view — its workspace is registered
    // and raw-visible (spared by the prune) yet absent from every strict
    // enumeration. The first-bootstrap scope must come from the prune's
    // FULL raw-plus-normalized union, not the enumeration alone: when the
    // later raw refreshes fail transiently, an enumeration-only scope would
    // serve an authoritative response omitting the live workspace, clearing
    // its renderer activity state with no event to correct it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const shadowedId = "raw-only-shadowed-ws";
      const winnerId = "normalized-winner-ws";
      const projectPath = path.join(config.rootDir, "project");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [
            // Map construction keeps the LAST duplicate key: the first pair
            // (trailing-slash variant of the same path) is dropped from the
            // normalized view with its workspace, while the raw id scan
            // still collects it.
            [
              `${projectPath}/`,
              { workspaces: [{ id: shadowedId, path: path.join(projectPath, "shadowed") }] },
            ],
            [
              projectPath,
              { workspaces: [{ id: winnerId, path: path.join(projectPath, "winner") }] },
            ],
          ],
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(shadowedId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Every raw config read AFTER the prune's successful one fails
      // transiently (the finding's window: the id was already loaded, and
      // only the discarded return kept it out of scope).
      const internals = workspaceService as unknown as {
        pruneStaleExtensionMetadataOnce(): Promise<unknown>;
      };
      const realPrune = internals.pruneStaleExtensionMetadataOnce.bind(workspaceService);
      let failRawReads = false;
      internals.pruneStaleExtensionMetadataOnce = async () => {
        const prefetched = await realPrune();
        failRawReads = true;
        return prefetched;
      };
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          if (failRawReads) {
            throw new Error("transient config read failure");
          }
          return realEvidence();
        }
      );
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[shadowedId]?.recency).toBe(42);
        // Its snapshot was spared by the prune too, not merely re-admitted.
        expect((await extensionMetadata.getAllSnapshots()).has(shadowedId)).toBe(true);
      } finally {
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a mid-list corruption reset does not read as workspace removal", async () => {
    // getAllSnapshots self-heals a deterministically corrupt metadata file
    // into a valid (possibly EMPTY) one, so a quarantine landing between the
    // initial and fresh reads makes every earlier snapshot key vanish from a
    // SUCCESSFUL re-read while the config still registers the workspaces.
    // Treating that disappearance as foreign-removal evidence would evict
    // the workflow caches and omit live workspaces from an authoritative
    // response — with no cross-process event to repair the renderer.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "corruption-reset-survivor";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 123);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const realGetAll = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotReads = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        (options) => {
          snapshotReads += 1;
          if (snapshotReads === 1) {
            return realGetAll(options);
          }
          // Every re-read after the initial one models the post-quarantine
          // self-healed EMPTY file: a successful, authoritative-looking
          // read with every previous key gone.
          return Promise.resolve(new Map<string, WorkspaceActivitySnapshot>());
        }
      );
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.recency).toBe(123);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a raw-removed id affirmed by the fresh enumeration is retained, not tombstoned", async () => {
    // A downgraded backend can remove an inline-id workspace entry and
    // re-register the SAME deterministic id as an id-less legacy entry
    // while this list awaits. The id then vanishes from every fresh raw
    // view (its identity lives in session metadata.json) while the fresh
    // authoritative enumeration — the very evidence that clears the id's
    // tombstone — still resolves it. Treating the raw disappearance alone
    // as removal would drop the revived workspace's activity and republish
    // the tombstone that evidence just cleared, suppressing it again.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "raw-invisible-revival";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        pruneStaleExtensionMetadataOnce(): Promise<unknown>;
        enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>>;
      };
      const realPrune = internals.pruneStaleExtensionMetadataOnce.bind(workspaceService);
      let revivedIdless = false;
      internals.pruneStaleExtensionMetadataOnce = async () => {
        const prefetched = await realPrune();
        // The removal + id-less re-registration lands after the initial
        // baseline and the prune, before the fresh evidence read.
        revivedIdless = true;
        return prefetched;
      };
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          const evidence = realEvidence();
          if (!revivedIdless) {
            return evidence;
          }
          // The downgraded backend rewrote the entry without an inline id:
          // the id disappears from the raw view, and the id-less entry
          // marks that view incomplete.
          const ids = new Set(evidence.ids);
          ids.delete(workspaceId);
          return { ids, hasWorkspaceEntriesWithoutIds: true };
        }
      );
      const realEnumerate = internals.enumerateAuthoritativeWorkspaceIds.bind(workspaceService);
      internals.enumerateAuthoritativeWorkspaceIds = async () => {
        // The enumeration resolves the id-less entry's stable identity.
        const ids = await realEnumerate();
        ids.add(workspaceId);
        return ids;
      };
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.recency).toBe(42);
        // No republished tombstone suppressing the revived workspace.
        expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
      } finally {
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a revival landing between the enumeration and the raw refresh is re-checked, not dropped", async () => {
    // The staleness window the post-refresh re-enumeration closes: the id
    // is removed BEFORE the mid-list enumeration runs (so that enumeration
    // denies it) and re-registered id-less right after it. The raw refresh
    // then reports id-less entries — proof the earlier denial may be
    // stale — so the removal arms must consult a fresh enumeration (which
    // resolves the revived identity) instead of dropping the workspace on
    // the stale denial and tombstoning it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "revived-between-reads";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 42);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        pruneStaleExtensionMetadataOnce(): Promise<unknown>;
        enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>>;
      };
      const realPrune = internals.pruneStaleExtensionMetadataOnce.bind(workspaceService);
      let removed = false;
      internals.pruneStaleExtensionMetadataOnce = async () => {
        const prefetched = await realPrune();
        // The cross-process removal lands after the initial baseline and
        // the prune.
        removed = true;
        return prefetched;
      };
      const realEvidence = config.readPersistedWorkspaceIdEvidence.bind(config);
      const evidenceSpy = spyOn(config, "readPersistedWorkspaceIdEvidence").mockImplementation(
        () => {
          const evidence = realEvidence();
          if (!removed) {
            return evidence;
          }
          // Post-removal raw views: the id is gone, and an unrelated
          // id-less legacy entry keeps the view incomplete throughout.
          const ids = new Set(evidence.ids);
          ids.delete(workspaceId);
          return { ids, hasWorkspaceEntriesWithoutIds: true };
        }
      );
      const realEnumerate = internals.enumerateAuthoritativeWorkspaceIds.bind(workspaceService);
      let postRemovalEnumerations = 0;
      internals.enumerateAuthoritativeWorkspaceIds = async () => {
        const ids = await realEnumerate();
        if (!removed) {
          return ids;
        }
        postRemovalEnumerations += 1;
        if (postRemovalEnumerations === 1) {
          // First post-removal enumeration: the removal is visible, the
          // id-less re-registration has not landed yet — a stale denial.
          ids.delete(workspaceId);
        }
        // Later enumerations resolve the revived id-less identity.
        return ids;
      };
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.recency).toBe(42);
        expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
      } finally {
        evidenceSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("first bootstrap admits snapshotless ids registered after the prune enumerated config", async () => {
    // A workspace another backend registers after the prune captured its id
    // set may have workflow- or bash-monitor-only activity and therefore no
    // extensionMetadata snapshot. Admission must come from the refreshed raw
    // config view — filtering through snapshot keys would skip the per-id
    // workflow probe entirely and return an authoritative list without it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const lateWorkspaceId = "late-registered-workspace";
      // Registered for real (the mid-list registration lands in config.json
      // in the modeled race); the spies below hide it from the baseline and
      // prune reads so only the refresh discovers it — the authoritative
      // removal recheck must then still find it registered.
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: lateWorkspaceId,
        name: lateWorkspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realSuperset = config.readPersistedWorkspaceIdSuperset.bind(config);
      let supersetCalls = 0;
      const supersetSpy = spyOn(config, "readPersistedWorkspaceIdSuperset").mockImplementation(
        () => {
          supersetCalls += 1;
          const ids = realSuperset();
          // Calls 1 (pre-await baseline) and 2 (prune enumeration) see the
          // pre-registration config; the refresh and the post-await
          // revalidation see the concurrently registered workspace.
          if (supersetCalls <= 2) {
            ids.delete(lateWorkspaceId);
          }
          return ids;
        }
      );
      const realMetadata = config.getAllWorkspaceMetadata.bind(config);
      let metadataCalls = 0;
      const metadataSpy = spyOn(config, "getAllWorkspaceMetadata").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          // Only the prune's enumeration (first call) predates the
          // registration in the modeled race; the revalidation's fresh
          // authoritative enumeration sees the registered workspace.
          metadataCalls += 1;
          const all = await realMetadata(options);
          if (metadataCalls === 1) {
            return all.filter((metadata) => metadata.id !== lateWorkspaceId);
          }
          return all;
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        // Workflow-only activity: discoverable by the per-id probe, never a
        // persisted snapshot.
        await workspaceService.emitWorkflowRunActivity({
          workspaceId: lateWorkspaceId,
          runId: "late-run",
          status: "running",
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[lateWorkspaceId]?.activeWorkflowRunCount).toBe(1);
      } finally {
        supersetSpy.mockRestore();
        metadataSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("suppresses activity emissions for removed workspaces", async () => {
    // A late in-flight producer completing after removal must not broadcast:
    // the renderer would re-insert the removed id into its activity map after
    // already processing the metadata-removal event.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "activity-emit-after-removal";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const events: Array<{ workspaceId: string }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Working" });
      expect(events.length).toBe(1);

      // Discard verifies deregistration against persisted config, so remove
      // the workspace first (mirroring the real removal flow).
      await config.removeWorkspace(workspaceId);
      await workspaceService.discardExtensionMetadataEntry(workspaceId);
      // Simulates the producer that was already in flight when removal ran.
      await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Late" });
      expect(events.length).toBe(1);
      // Clearing (null) emissions stay allowed for removed workspaces.
      workspaceService.emitWorkspaceActivity(workspaceId, null);
      expect(events.length).toBe(2);
      // A late workflow-run producer can also fire after removal: its cache
      // entry turns a null snapshot into a non-null merged payload, which
      // must be suppressed exactly like a non-null snapshot emission — the
      // tombstone check runs on the merged payload, not the raw snapshot.
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "late-run",
        status: "running",
      });
      expect(events.length).toBe(2);
      workspaceService.emitWorkspaceActivity(workspaceId, null);
      expect(events.length).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("a re-registered id sheds its tombstone on the next activity list", async () => {
    // Tombstones are process-local removal knowledge; the shared config is
    // the authority. A downgraded concurrent backend can legitimately
    // re-register a deterministic legacy id this process pruned — the next
    // activity list observes the id in fresh config evidence and must lift
    // the write suppression instead of muting the revived workspace until
    // restart.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "revived-legacy-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const workspaceEntry = {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" as const },
      };
      await config.addWorkspace(projectPath, workspaceEntry);
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Removal flow: deregister, then discard (delete + tombstone).
      await config.removeWorkspace(workspaceId);
      await workspaceService.discardExtensionMetadataEntry(workspaceId);
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(true);
      // Writes are suppressed while tombstoned.
      await extensionMetadata.updateRecency(workspaceId, 200);
      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(false);

      // The "other backend" re-registers the same id in the shared config.
      await config.addWorkspace(projectPath, workspaceEntry);

      await workspaceService.getActivityList();
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
      // Writes persist again after the revival.
      await extensionMetadata.updateRecency(workspaceId, 300);
      expect((await extensionMetadata.getAllSnapshots()).get(workspaceId)?.recency).toBe(300);
    } finally {
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry keeps the entry when the workspace is still persisted", async () => {
    // saveConfig swallows write failures, so config.removeWorkspace can
    // resolve while the workspace is still persisted in config.json.
    // Discarding then would write-tombstone a live id and suppress all of
    // its future activity writes for the rest of the process.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "discard-still-persisted";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      await workspaceService.discardExtensionMetadataEntry(workspaceId);

      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(true);
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry keeps entries of id-less legacy workspaces", async () => {
    // An id-less legacy config entry resolves its stable id from
    // sessions/<generated-legacy-id>/metadata.json. The raw config scan
    // cannot see that id, so the discard's registration check must resolve
    // it through the same authoritative path getAllWorkspaceMetadata uses;
    // otherwise the still-registered workspace would be reported absent and
    // its activity writes permanently tombstoned for this process.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: stableId, name: "legacy-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(stableId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      await workspaceService.discardExtensionMetadataEntry(stableId);

      expect((await extensionMetadata.getAllSnapshots()).has(stableId)).toBe(true);
      expect(extensionMetadata.isWorkspaceDeleted(stableId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("discardExtensionMetadataEntry keeps entries when legacy metadata parses without an id", async () => {
    // Same identity-unknowable contract as the unparseable case: a legacy
    // metadata.json that parses as `{}` carries no id, so the strict
    // findWorkspace lookup must fail closed rather than fall through to
    // "not registered" — the entry under the real (unknowable) stable id
    // would otherwise be deleted and write-tombstoned while its workspace
    // remains registered.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(path.join(legacySessionDir, "metadata.json"), "{}");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(stableId, 100);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      await workspaceService.discardExtensionMetadataEntry(stableId);

      expect((await extensionMetadata.getAllSnapshots()).has(stableId)).toBe(true);
      expect(extensionMetadata.isWorkspaceDeleted(stableId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList merges snapshots another process persisted mid-list", async () => {
    // Another backend can register a workspace and persist its first
    // activity after this process's initial snapshot read. The refreshed
    // config admits the id, but the per-id computation saw a null snapshot
    // and no local caches, so the entry would be omitted — and the activity
    // subscription is process-local, so no delta ever heals it. The fresh
    // revalidation re-read must merge the addition.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "late-snapshot-workspace";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      // Simulate the cross-process write landing between the initial read
      // (call 1) and the revalidation re-read (call 2).
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return realGetAllSnapshots(options);
          }
          await extensionMetadata.updateRecency(workspaceId, 777);
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.recency).toBe(777);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList merges workspaces registered and written entirely mid-list", async () => {
    // Harder variant of the mid-list merge: the workspace is registered AND
    // written after every scope read (baseline, prune, refresh), so it is in
    // neither the per-id scope nor the initial snapshots — only the fresh
    // revalidation views (snapshot re-read + raw config re-read) know it.
    // The merge must admit ids those fresh views agree on.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "brand-new-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // The other backend registers the workspace and persists its
            // first activity between the initial read and the revalidation
            // re-read (before the fresh raw config re-read).
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.recency).toBe(888);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow runs for workspaces merged mid-list", async () => {
    // A workspace admitted only by the fresh revalidation re-reads never went
    // through the per-id loop, so its on-disk active workflow runs are not in
    // the process-local cache. The merge must probe disk for them — a
    // cached-only merge would omit activeWorkflowRunCount for exactly the
    // cross-process registrations it exists to bootstrap, and the
    // process-local activity subscription can never deliver that delta.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "brand-new-workflow-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // The other backend registers the workspace, persists its first
            // activity, AND starts a workflow run before the revalidation
            // re-read.
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, workspaceId),
            });
            await runStore.createRun({
              id: "wfr_midlist",
              workspaceId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.recency).toBe(888);
        expect(activityList?.[workspaceId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[workspaceId]?.activeWorkflowRunIds).toEqual(["wfr_midlist"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList admits raw-invisible legacy workspaces registered mid-list", async () => {
    // A downgraded backend can register a legacy (id-less config entry)
    // workspace mid-list: its stable id lives only in session metadata.json,
    // so the fresh raw config re-read can never vouch for it. The merge must
    // resolve such fresh-snapshot ids through the authoritative identity
    // path instead of excluding them until reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "late-legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(
              configPath,
              JSON.stringify({
                projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
              })
            );
            const legacySessionDir = path.join(
              config.sessionsDir,
              config.generateLegacyId(projectPath, workspacePath)
            );
            await fsPromises.mkdir(legacySessionDir, { recursive: true });
            await fsPromises.writeFile(
              path.join(legacySessionDir, "metadata.json"),
              JSON.stringify({ id: stableId, name: "legacy-ws" })
            );
            await extensionMetadata.updateRecency(stableId, 777);
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[stableId]?.recency).toBe(777);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow-only workspaces registered mid-list", async () => {
    // A backend can register a workspace after the scope reads and start a
    // workflow WITHOUT writing extension metadata: the fresh snapshot re-read
    // never contains the id, so admission must come from the fresh raw
    // config view alone — otherwise the workflow-only activity is missing
    // from the authoritative response until reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "workflow-only-late-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // Registered + workflow started, but NO metadata write.
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, workspaceId),
            });
            await runStore.createRun({
              id: "wfr_workflow_only",
              workspaceId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[workspaceId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[workspaceId]?.activeWorkflowRunIds).toEqual(["wfr_workflow_only"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("a workflow bootstrap evicted mid-flight is retried instead of served detached", async () => {
    // Cache eviction (removal / tombstone-lift revival) can race an
    // in-flight bootstrap: waiters that captured the pre-eviction Set would
    // return the removed incarnation's runs — ghost counts with no terminal
    // event to clear them. The read must detect the eviction and re-probe.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "evicted-mid-bootstrap";
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const internals = workspaceService as unknown as {
        getActiveWorkflowRunIds(id: string): Promise<Set<string>>;
        evictWorkspaceActivityCaches(id: string): void;
      };
      const releaseFirstScan = createDeferred<void>();
      let scanCalls = 0;
      listStatusSnapshotsSpy.mockImplementation(async () => {
        scanCalls += 1;
        if (scanCalls === 1) {
          // Old-incarnation bootstrap: parked, then reports a ghost run.
          await releaseFirstScan.promise;
          return [
            {
              id: "wfr_ghost",
              workspaceId,
              status: "running" as const,
              createdAt: "2026-06-17T00:00:00.000Z",
              updatedAt: "2026-06-17T00:00:00.000Z",
            },
          ];
        }
        // Post-revival probe: the new incarnation has no runs.
        return [];
      });

      const read = internals.getActiveWorkflowRunIds(workspaceId);
      // Removal + re-registration land while the bootstrap is parked.
      internals.evictWorkspaceActivityCaches(workspaceId);
      releaseFirstScan.resolve();
      const runIds = await read;
      expect(runIds.size).toBe(0);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("a re-registered id does not inherit workflow caches from its removed incarnation", async () => {
    // Workspace removal deletes session state without producing terminal
    // workflow events, and the process-local run cache was never evicted:
    // a deterministic legacy id re-registered by a downgraded backend would
    // show the removed incarnation's ghost activeWorkflowRunCount forever
    // (the per-id bootstrap returns the cached set without re-probing disk).
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "revived-workspace";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Cache a live workflow run for the (unregistered) old incarnation.
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_ghost",
        status: "running",
      });
      // Removal cleanup: deregistered (never in config here), so the entry
      // is tombstoned and the process-local caches must be evicted.
      await workspaceService.discardExtensionMetadataEntry(workspaceId);
      // The downgraded backend re-registers the same id; its session dir has
      // no workflow runs.
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      // No ghost count from the removed incarnation's cache: the revived id
      // re-probes disk (empty) and stays absent from the list.
      expect(activityList?.[workspaceId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow-only late ids even when the metadata reread fails", async () => {
    // The fresh raw config re-read can discover a workflow-only late
    // registration while the metadata re-read transiently fails. The list
    // still returns an authoritative (non-null) response, and the
    // process-local subscription cannot supply the foreign workflow event —
    // so the config-proven id must be probed regardless of the failed
    // snapshot view.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "workflow-only-late-reread-fails";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return realGetAllSnapshots(options);
          }
          if (snapshotCalls === 2) {
            // Registration + workflow start land before the (failing)
            // revalidation re-read.
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, workspaceId),
            });
            await runStore.createRun({
              id: "wfr_reread_fail",
              workspaceId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          // Every re-read after the initial one fails transiently.
          throw new Error("transient metadata read failure");
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[workspaceId]?.activeWorkflowRunIds).toEqual(["wfr_reread_fail"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList bootstraps workflow-only legacy workspaces registered mid-list", async () => {
    // Combined raw-invisible + snapshotless case: a downgraded backend
    // registers an id-less legacy workspace mid-list and starts a workflow
    // WITHOUT writing extension metadata. The stable id appears in neither
    // the fresh raw view nor the fresh snapshots, so discovery must come
    // from the authoritative enumeration triggered by the raw evidence's
    // id-less-entry signal.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "late-legacy-workflow-only";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(
              configPath,
              JSON.stringify({
                projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
              })
            );
            const legacySessionDir = path.join(
              config.sessionsDir,
              config.generateLegacyId(projectPath, workspacePath)
            );
            await fsPromises.mkdir(legacySessionDir, { recursive: true });
            await fsPromises.writeFile(
              path.join(legacySessionDir, "metadata.json"),
              JSON.stringify({ id: stableId, name: "legacy-ws" })
            );
            const runStore = new WorkflowRunStore({
              sessionDir: path.join(config.sessionsDir, stableId),
            });
            await runStore.createRun({
              id: "wfr_legacy_only",
              workspaceId: stableId,
              workflow: {
                name: "demo",
                description: "Demo workflow",
                scope: "global" as const,
                executable: true,
              },
              source: "export default function workflow() { return {}; }",
              args: {},
              now: "2026-06-17T00:00:00.000Z",
            });
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.[stableId]?.activeWorkflowRunCount).toBe(1);
        expect(activityList?.[stableId]?.activeWorkflowRunIds).toEqual(["wfr_legacy_only"]);
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops legacy additions deregistered during the workflow probe", async () => {
    // A raw-invisible legacy workspace admitted mid-list and deregistered
    // while the workflow probe awaits: every raw view is blind to it and its
    // metadata snapshot survives the deregistration gap, so only the
    // post-probe authoritative re-enumeration can prove the removal.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const stableId = "late-legacy-then-removed";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(
              configPath,
              JSON.stringify({
                projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
              })
            );
            const legacySessionDir = path.join(
              config.sessionsDir,
              config.generateLegacyId(projectPath, workspacePath)
            );
            await fsPromises.mkdir(legacySessionDir, { recursive: true });
            await fsPromises.writeFile(
              path.join(legacySessionDir, "metadata.json"),
              JSON.stringify({ id: stableId, name: "legacy-ws" })
            );
            await extensionMetadata.updateRecency(stableId, 999);
          }
          return realGetAllSnapshots(options);
        }
      );
      listStatusSnapshotsSpy.mockImplementation(async () => {
        // Another backend deregisters the legacy workspace mid-probe; its
        // metadata snapshot intentionally survives (cleanup gap).
        await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[stableId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops late additions deregistered during the workflow probe", async () => {
    // A workspace registered AFTER the initial raw baseline and removed
    // while the workflow probe awaits sits in the normal gap between config
    // deregistration and extension-metadata cleanup: its snapshot still
    // exists, so only the post-probe raw config re-read (compared against
    // the fresh view that admitted it — the initial baseline never saw it)
    // can prove the removal.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "late-then-deregistered";
      const projectPath = path.join(config.rootDir, "project");
      const configPath = path.join(config.rootDir, "config.json");
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
          }
          return realGetAllSnapshots(options);
        }
      );
      listStatusSnapshotsSpy.mockImplementation(async () => {
        // Another backend deregisters the workspace mid-probe; its metadata
        // entry intentionally survives (cleanup has not run yet).
        await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops mid-list additions removed during the workflow probe", async () => {
    // The workflow-run bootstrap for late merge candidates awaits disk; a
    // cross-process removal landing during that probe is invisible to every
    // guard view captured before it. The final post-probe snapshot re-read
    // must drop the entry instead of riding the deleted id back into the
    // renderer (the process-local subscription cannot correct it).
    const { config, historyService, cleanup } = await createTestHistoryService();
    const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "late-then-removed";
      const projectPath = path.join(config.rootDir, "project");
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await config.addWorkspace(projectPath, {
              id: workspaceId,
              name: workspaceId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(workspaceId, 888);
          }
          return realGetAllSnapshots(options);
        }
      );
      listStatusSnapshotsSpy.mockImplementation(async () => {
        // Another backend removes the workspace while the probe is awaited:
        // its persisted metadata entry disappears, unseen by this process's
        // tombstones.
        await new ExtensionMetadataService(metadataPath).deleteWorkspace(workspaceId);
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[workspaceId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops retained entries removed during late workflow probes", async () => {
    // The retained-entry filter runs before the late-candidate workflow
    // probes await disk. A cross-process removal of an ALREADY-RETAINED
    // workspace landing during those probes is invisible to every view the
    // filter used — without the post-probe re-filter the removed id rides
    // the response back into the renderer with no event to correct it.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const retainedId = "retained-then-removed";
      const lateId = "late-registered";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: retainedId,
        name: retainedId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      await extensionMetadata.updateRecency(retainedId, 555);
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            // Another backend registers a NEW workspace mid-list so the
            // merge has a late candidate whose probe awaits disk.
            await config.addWorkspace(projectPath, {
              id: lateId,
              name: lateId,
              projectName: "project",
              projectPath,
              runtimeConfig: { type: "local" },
            });
            await extensionMetadata.updateRecency(lateId, 777);
          }
          return realGetAllSnapshots(options);
        }
      );
      let probeCalls = 0;
      listStatusSnapshotsSpy.mockImplementation(async () => {
        probeCalls += 1;
        if (probeCalls === 2) {
          // The late candidate's probe is awaited: another backend removes
          // the RETAINED workspace — config deregistration first (the real
          // removeUnlocked order), then the metadata entry deletion unseen
          // by this process's tombstones.
          await config.removeWorkspace(retainedId);
          await new ExtensionMetadataService(metadataPath).deleteWorkspace(retainedId);
        }
        return [];
      });
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[lateId]).toBeDefined();
        expect(activityList?.[retainedId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("getActivityList drops snapshotless legacy entries removed mid-list", async () => {
    // A legacy id-less config entry's stable id is resolved authoritatively
    // during enumeration and can never appear in the raw config-id baseline,
    // so the raw-superset removal comparison is blind to it. If another
    // backend removes the workspace while the per-id reads run, a
    // snapshotless (workflow-only) entry has no metadata-file revalidation
    // to catch it either — the authoritative findWorkspace recheck must
    // drop it instead of reinserting the removed workspace.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: stableId, name: "legacy-ws" })
      );
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      // Workflow-only activity: no persisted snapshot.
      await workspaceService.emitWorkflowRunActivity({
        workspaceId: stableId,
        runId: "legacy-run",
        status: "running",
      });
      // Simulate the cross-process removal between the entry computation and
      // the revalidation phase: the fresh metadata re-read is the first
      // revalidation step, so rewriting config.json there lands mid-list.
      const realGetAllSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      let snapshotCalls = 0;
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(
        async (options?: { throwOnError?: boolean }) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
            await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
          }
          return realGetAllSnapshots(options);
        }
      );
      try {
        const activityList = await workspaceService.getActivityList();
        expect(activityList).not.toBeNull();
        expect(activityList?.[stableId]).toBeUndefined();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("drops retained legacy entries removed during the mid-list identity scan", async () => {
    // An id-less legacy workspace is retained on the strength of the
    // mid-list authoritative enumeration — which can observe the stable id
    // right before another backend deregisters it and deletes its metadata
    // later in the same await. Raw config scans can never see the stable
    // id and the fresh snapshot re-read predates the removal, so with zero
    // late candidates nothing else re-reads: the final revalidation must
    // run for retained raw-invisible ids too, or the deleted workspace
    // rides every authoritative response until reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const stableId = "legacy-retained-stable-id";
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.writeFile(
        configPath,
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: stableId, name: "legacy-ws" })
      );
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      // Persisted snapshot: the entry is RETAINED by the per-id loop, so
      // the late-candidate merge has nothing to probe.
      await extensionMetadata.updateRecency(stableId, 321);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const internals = workspaceService as unknown as {
        enumerateAuthoritativeWorkspaceIds(): Promise<Set<string>>;
      };
      const realEnumerate = internals.enumerateAuthoritativeWorkspaceIds.bind(workspaceService);
      let enumerateCalls = 0;
      internals.enumerateAuthoritativeWorkspaceIds = async () => {
        enumerateCalls += 1;
        const ids = await realEnumerate();
        if (enumerateCalls === 2) {
          // The removal lands INSIDE the mid-list enumeration await, after
          // the enumeration observed the id: config deregistration first
          // (the real removal write order), then the metadata deletion by
          // another backend (no local tombstone).
          await fsPromises.writeFile(configPath, JSON.stringify({ projects: [] }));
          await new ExtensionMetadataService(metadataPath).deleteWorkspace(stableId);
        }
        return ids;
      };
      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[stableId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList quarantines a deterministically corrupt metadata file", async () => {
    // Parse/structure corruption fails identically on every retry, so a
    // strict read that only rethrows would leave activity hydration broken
    // across restarts until some unrelated writer replaced the file. The
    // strict path quarantines the bytes (preserved for inspection, never
    // silently deleted) and the resulting empty state is authoritative.
    // Note: a valid file with version !== 1 is deliberately NOT here — that
    // is a newer build's schema, treated as unsupported (propagated, never
    // quarantined/reset) so a downgrade round-trip cannot destroy it.
    const corruptFiles = [
      "{not json",
      JSON.stringify({ version: 1, workspaces: [] }),
      JSON.stringify({ version: 1, workspaces: "bogus" }),
      JSON.stringify({ version: 1, workspaces: null }),
    ];
    for (const corruptFile of corruptFiles) {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
        await fsPromises.writeFile(metadataPath, corruptFile, "utf-8");
        const extensionMetadata = new ExtensionMetadataService(metadataPath);
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        // Lenient reads (writer paths) self-heal without quarantining.
        expect((await extensionMetadata.getAllSnapshots()).size).toBe(0);
        expect(await fsPromises.readFile(metadataPath, "utf-8")).toBe(corruptFile);

        const activityList = await workspaceService.getActivityList();
        expect(activityList).toEqual({});
        // The corrupt bytes were moved aside, not destroyed.
        expect(await fsPromises.readFile(`${metadataPath}.corrupt`, "utf-8")).toBe(corruptFile);
        // Quarantine must leave a valid EMPTY main file behind (never a
        // missing path): readers of a missing-main-plus-sidecar state treat
        // it as a retryable mid-quarantine window, not authoritative empty.
        expect(JSON.parse(await fsPromises.readFile(metadataPath, "utf-8"))).toEqual({
          version: 1,
          workspaces: {},
        });
      } finally {
        await cleanup();
      }
    }
  });

  test("getActivityList returns null when the metadata path exists but cannot be read", async () => {
    // Only a genuinely missing file (ENOENT) is a healthy empty state. Any
    // other read failure (here EISDIR; EACCES/ENOTDIR/EIO in the field) must
    // surface as the null read-failure signal instead of masquerading as an
    // authoritative empty list.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      await fsPromises.mkdir(metadataPath, { recursive: true });
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      // Lenient reads (writer paths) still self-heal.
      expect((await extensionMetadata.getAllSnapshots()).size).toBe(0);

      expect(await workspaceService.getActivityList()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops workspaces removed while the list was computing", async () => {
    // A removal that lands between the snapshot read and the response must
    // not ride the delayed list past emitWorkspaceActivity's tombstone
    // suppression: a renderer that already processed the removal event would
    // re-insert the deleted id until the next reconnect.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "removed-mid-list";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const readSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      spyOn(extensionMetadata, "getAllSnapshots").mockImplementationOnce(async () => {
        const snapshots = await readSnapshots();
        // Simulates a concurrent removal completing after this request read
        // its snapshot view but before the response was assembled — in the
        // real removeUnlocked order: config deregistration first, then the
        // metadata deletion.
        await config.removeWorkspace(workspaceId);
        await extensionMetadata.deleteWorkspace(workspaceId);
        return snapshots;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops entries whose metadata another process removed mid-list", async () => {
    // XUM_ALLOW_MULTIPLE_INSTANCES: a removal in another backend never
    // reaches this process's in-memory tombstones, so the final response
    // revalidates against a fresh read of the shared file instead.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "removed-by-other-process";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const metadataPath = path.join(config.rootDir, "extensionMetadata.json");
      const extensionMetadata = new ExtensionMetadataService(metadataPath);
      await extensionMetadata.updateRecency(workspaceId, 100);
      const readSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      spyOn(extensionMetadata, "getAllSnapshots").mockImplementationOnce(async (options) => {
        const snapshots = await readSnapshots(options);
        // Simulates another backend's removal landing after this request read
        // its snapshot view: rewrite the shared file without the entry, with
        // no in-process deleteWorkspace tombstone. Faithful to the removal
        // protocol's write order (removeUnlocked deregisters config BEFORE
        // deleting metadata): a vanished snapshot with config still
        // registering the id is a corruption-reset lookalike and must be
        // retained, so removal simulations must deregister first.
        await config.removeWorkspace(workspaceId);
        await fsPromises.writeFile(
          metadataPath,
          JSON.stringify({ version: 1, workspaces: {} }),
          "utf-8"
        );
        return snapshots;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]).toBeUndefined();
      // The removal was detected from foreign evidence — and retained as a
      // local tombstone: cache eviction alone cannot stop a LATE local
      // producer (workflow-run/bash-monitor completion) from re-emitting
      // the removed incarnation's activity right after this authoritative
      // response dropped it, because emitWorkspaceActivity's
      // isWorkspaceDeleted check only knows local removals.
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(true);
      // A late producer's write stays unpersisted (transient) instead of
      // recreating the removed entry on disk.
      await extensionMetadata.updateRecency(workspaceId, 200);
      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList drops entries another process deregistered from config mid-list", async () => {
    // Covers entries without a persisted snapshot too: the metadata-file
    // revalidation cannot see workflow/bash-monitor-only entries, so final
    // membership is also re-checked against the shared config state.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "deregistered-by-other-process";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency(workspaceId, 100);
      const readSnapshots = extensionMetadata.getAllSnapshots.bind(extensionMetadata);
      spyOn(extensionMetadata, "getAllSnapshots").mockImplementationOnce(async (options) => {
        const snapshots = await readSnapshots(options);
        // Simulates another backend deregistering the workspace after this
        // request read its snapshot view. The metadata entry stays behind, so
        // only the fresh config membership check can catch it.
        await config.removeWorkspace(workspaceId);
        return snapshots;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList).not.toBeNull();
      expect(activityList?.[workspaceId]).toBeUndefined();
      // Foreign removals proven by the list guards publish a local
      // tombstone (late-producer suppression — see the metadata-removal
      // test above).
      expect(extensionMetadata.isWorkspaceDeleted(workspaceId)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("getActivityList returns null on metadata read failure instead of {}", async () => {
    // With scoping, {} is a valid authoritative answer that clears renderer
    // state; failures must be distinguishable (null) so the renderer keeps
    // its last-known snapshots and retries.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const snapshotsSpy = spyOn(extensionMetadata, "getAllSnapshots").mockImplementation(() =>
        Promise.reject(new Error("metadata unreadable"))
      );
      try {
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        expect(await workspaceService.getActivityList()).toBeNull();
      } finally {
        snapshotsSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("falls back to the unscoped union when config workspaces cannot be listed", async () => {
    // Real on-disk corruption shapes. loadConfigOrDefault SWALLOWS the first
    // (parse failure) and lenient-normalizes the rest (parseable but
    // structurally invalid) into an empty/partial workspace view unless
    // callers opt into the strict read. Without throwOnError + strict
    // structural validation, each of these states would silently wipe every
    // metadata entry (prune sees an "empty" config) and drop every live
    // entry from the list instead of reaching the fail-open fallback.
    const corruptConfigs = [
      "{not json",
      JSON.stringify({ projects: {} }),
      JSON.stringify({ projects: [["/tmp/project", { workspaces: "bogus" }]] }),
      // Arrays pass typeof "object": lenient normalization turns an
      // array-valued project config into a project with no workspaces.
      JSON.stringify({ projects: [["/tmp/project", []]] }),
    ];
    for (const corruptConfig of corruptConfigs) {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const extensionMetadata = new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        );
        await extensionMetadata.updateRecency("possibly-live", 100);
        await fsPromises.writeFile(path.join(config.rootDir, "config.json"), corruptConfig);
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });
        // Fail open: without a trustworthy config view, stale ids cannot be
        // told apart from live ones, so nothing may be dropped from the list
        // or pruned from disk.
        const activityList = await workspaceService.getActivityList();
        expect(activityList?.["possibly-live"]?.recency).toBe(100);
        expect((await extensionMetadata.getAllSnapshots()).has("possibly-live")).toBe(true);
      } finally {
        await cleanup();
      }
    }
  });

  test("falls back to the unscoped union when config.json exists but cannot be read", async () => {
    // EISDIR here; EACCES/ENOTDIR/EIO in the field. existsSync-style probes
    // report all of these as "missing", which would masquerade as an empty
    // config and let the prune delete every metadata entry instead of
    // failing open.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("possibly-live", 100);
      const configPath = path.join(config.rootDir, "config.json");
      await fsPromises.rm(configPath, { force: true });
      await fsPromises.mkdir(configPath);
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      expect(activityList?.["possibly-live"]?.recency).toBe(100);
      expect((await extensionMetadata.getAllSnapshots()).has("possibly-live")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("fails open when a legacy workspace's identity lookup fails", async () => {
    // A legacy config entry without an id resolves its authoritative stable
    // id from its session metadata.json. If that file is unreadable or
    // unparseable, the lenient path substitutes the generated path id — the
    // strict enumeration must instead propagate the failure so the prune
    // cannot classify the real stable id's entries as stale.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("legacy-stable-id", 100);
      const projectPath = path.join(config.rootDir, "project");
      const workspacePath = path.join(projectPath, "legacy-ws");
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
        })
      );
      // Corrupt the metadata.json holding that entry's stable id.
      const legacySessionDir = path.join(
        config.sessionsDir,
        config.generateLegacyId(projectPath, workspacePath)
      );
      await fsPromises.mkdir(legacySessionDir, { recursive: true });
      await fsPromises.writeFile(path.join(legacySessionDir, "metadata.json"), "{not json");
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });

      const activityList = await workspaceService.getActivityList();
      // Fail open: the identity of the legacy workspace is unknowable, so
      // nothing may be dropped from the list or pruned from disk.
      expect(activityList?.["legacy-stable-id"]?.recency).toBe(100);
      expect((await extensionMetadata.getAllSnapshots()).has("legacy-stable-id")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("fails open when a legacy metadata.json parses without a usable id", async () => {
    // Successful JSON parsing does not establish identity: `{}` (or an
    // array) passes the parse but resolves an id-less entry, and the raw
    // config has no id to contribute. Strict enumeration must fail closed
    // exactly like the unparseable case above, or the prune classifies the
    // real stable id's entries as stale and deletes them.
    const idlessMetadataFiles = ["{}", "[]"];
    for (const idlessMetadataFile of idlessMetadataFiles) {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const extensionMetadata = new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        );
        await extensionMetadata.updateRecency("legacy-stable-id", 100);
        const projectPath = path.join(config.rootDir, "project");
        const workspacePath = path.join(projectPath, "legacy-ws");
        await fsPromises.writeFile(
          path.join(config.rootDir, "config.json"),
          JSON.stringify({
            projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
          })
        );
        const legacySessionDir = path.join(
          config.sessionsDir,
          config.generateLegacyId(projectPath, workspacePath)
        );
        await fsPromises.mkdir(legacySessionDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(legacySessionDir, "metadata.json"),
          idlessMetadataFile
        );
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          extensionMetadata,
        });

        const activityList = await workspaceService.getActivityList();
        expect(activityList?.["legacy-stable-id"]?.recency).toBe(100);
        expect((await extensionMetadata.getAllSnapshots()).has("legacy-stable-id")).toBe(true);
      } finally {
        await cleanup();
      }
    }
  });

  test("never prunes entries whose config entry is discarded by normalization", async () => {
    // A parseable config entry that lenient normalization filters out (null
    // project path): the workspace vanishes from the normalized view — and
    // thus from the activity list, matching every other renderer surface —
    // but its metadata entry must survive the prune. Two guards enforce it:
    // strict loads reject the malformed project key outright (aborting the
    // prune, fail closed), and the raw-superset union spares the inline id
    // even if enumeration were to succeed.
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      await extensionMetadata.updateRecency("possibly-live", 100);
      await fsPromises.writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [[null, { workspaces: [{ id: "possibly-live", path: "/tmp/x" }] }]],
        })
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      await workspaceService.getActivityList();
      expect((await extensionMetadata.getAllSnapshots()).has("possibly-live")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("prunes the extension metadata entry after a workspace is removed", async () => {
    const workspaceId = "remove-prunes-metadata";
    const harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve(Ok(undefined))),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok(createFrontendWorkspaceMetadata({ id: workspaceId, name: workspaceId }))
          )
        ),
      }),
    });
    const { service: workspaceService, config, extensionMetadata } = harness;
    try {
      await fsPromises.mkdir(path.join(config.sessionsDir, workspaceId), { recursive: true });
      // The workspace is not registered in config, so the discard's deregistration check
      // (persisted superset + findWorkspace) passes and the entry is deleted.
      await extensionMetadata.updateRecency(workspaceId, 100);
      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(true);

      const removeResult = await workspaceService.remove(workspaceId, true);
      expect(removeResult.success).toBe(true);
      expect((await extensionMetadata.getAllSnapshots()).has(workspaceId)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  test("discardExtensionMetadataEntry swallows deletion failures", async () => {
    // Rollback paths (e.g. TaskService's failed task-create rollback) call
    // this best-effort; a metadata disk failure must not abort the rollback.
    const harness = await createWorkspaceServiceHarness();
    try {
      const deleteWorkspace = spyOn(harness.extensionMetadata, "deleteWorkspace").mockRejectedValue(
        new Error("disk full")
      );

      await harness.service.discardExtensionMetadataEntry("rollback-ws");
      expect(deleteWorkspace).toHaveBeenCalledWith("rollback-ws");
    } finally {
      await harness.cleanup();
    }
  });
});
