import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "path";
import type { Workspace } from "@/common/types/project";
import { Config } from "@/node/config";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

/**
 * Regression coverage for the config lost-update resurrection race.
 *
 * Pre-fix interleaving (Config.saveConfig was public):
 *   1. setHeartbeatSettings(B) read a full config snapshot via loadConfigOrDefault()
 *      — the snapshot still contained workspace A.
 *   2. config.removeWorkspace(A) ran through the serialized editConfig queue and
 *      persisted a config without A.
 *   3. setHeartbeatSettings(B) then called saveConfig(staleSnapshot) directly,
 *      bypassing the queue — the stale snapshot write landed after the removal and
 *      resurrected A as a permanent sidebar ghost pointing at a deleted
 *      worktree/session (reproduced in 14/17 timing probes with a 1200-workspace
 *      config).
 *
 * Post-fix, saveConfig is private and every mutation is an editConfig transform that
 * re-resolves its target from the fresh snapshot, so this interleaving cannot lose
 * the removal regardless of scheduling. The loop below is a bounded stress run so a
 * regression fails deterministically rather than by scheduler luck.
 */
describe("WorkspaceService config resurrection regression", () => {
  const PROJECT_PATH = "/test/project";
  let harness: WorkspaceServiceHarness;
  let config: Config;
  let service: WorkspaceService;

  function workspaceEntry(id: string, extra?: Partial<Workspace>): Workspace {
    const entry: Workspace = {
      id,
      path: path.join(PROJECT_PATH, id),
      name: id,
      ...extra,
    };
    return entry;
  }

  async function seedWorkspaces(entries: Workspace[]): Promise<void> {
    await config.editConfig((cfg) => {
      cfg.projects = new Map([[PROJECT_PATH, { workspaces: entries }]]);
      return cfg;
    });
  }

  /** Re-read the persisted state through a fresh Config so assertions hit disk. */
  function readPersistedWorkspaces(): Workspace[] {
    const persisted = new Config(harness.rootDir).loadConfigOrDefault();
    return persisted.projects.get(PROJECT_PATH)?.workspaces ?? [];
  }

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    ({ config, service } = harness);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("removeWorkspace cannot be resurrected by a concurrent heartbeat write", async () => {
    // Large-ish config widens the read/write window that made the pre-fix race
    // near-certain; several iterations make a regression fail deterministically.
    const filler = Array.from({ length: 200 }, (_, i) => workspaceEntry(`filler-${i}`));

    for (let iteration = 0; iteration < 8; iteration++) {
      const removalTargetId = `removal-target-${iteration}`;
      const heartbeatTargetId = `heartbeat-target-${iteration}`;
      await seedWorkspaces([
        workspaceEntry(removalTargetId),
        workspaceEntry(heartbeatTargetId),
        ...filler,
      ]);

      // Fire both mutations without awaiting in between so their internal reads and
      // writes interleave exactly like the production race.
      const removal = config.removeWorkspace(removalTargetId);
      const heartbeatWrite = service.setHeartbeatSettings(heartbeatTargetId, {
        enabled: true,
        intervalMs: 45 * 60 * 1000,
      });
      const [, writeResult] = await Promise.all([removal, heartbeatWrite]);

      const persistedWorkspaces = readPersistedWorkspaces();
      const resurrected = persistedWorkspaces.find((w) => w.id === removalTargetId);
      expect(resurrected).toBeUndefined();

      // The concurrent mutation must still land — serialization, not starvation.
      expect(writeResult.success).toBe(true);
      const heartbeatTarget = persistedWorkspaces.find((w) => w.id === heartbeatTargetId);
      expect(heartbeatTarget?.heartbeat?.enabled).toBe(true);
      expect(heartbeatTarget?.heartbeat?.intervalMs).toBe(45 * 60 * 1000);
    }
  });

  test("heartbeat writes racing removal of the same workspace degrade gracefully", async () => {
    await seedWorkspaces([workspaceEntry("doomed"), workspaceEntry("other")]);

    const removal = config.removeWorkspace("doomed");
    const setResult = await service.setHeartbeatSettings("doomed", {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
    await removal;

    // Depending on queue order the write either landed before the removal (Ok) or
    // found the entry gone (Err) — both are acceptable; resurrection is not.
    if (!setResult.success) {
      expect(setResult.error).toContain("Workspace not found");
    }
    expect(readPersistedWorkspaces().find((w) => w.id === "doomed")).toBeUndefined();
  });

  test("unset heartbeat racing removal of the same workspace stays Ok and never resurrects", async () => {
    await seedWorkspaces([
      workspaceEntry("doomed", {
        heartbeat: { enabled: true, intervalMs: 45 * 60 * 1000 },
      }),
      workspaceEntry("other"),
    ]);

    const removal = config.removeWorkspace("doomed");
    const unsetResult = await service.unsetHeartbeatSettings("doomed");
    await removal;

    // Unset on a concurrently removed entry is trivially satisfied.
    expect(unsetResult.success).toBe(true);
    expect(readPersistedWorkspaces().find((w) => w.id === "doomed")).toBeUndefined();
  });

  // Regression (PR #3694 Codex P2): workspace paths are reusable after deletion. A
  // settings write queued behind a remove+recreate that reuses the same path must
  // treat its original entry as gone — the path fallback previously retargeted the
  // stale write onto the REPLACEMENT workspace's fresh entry.
  test("stale heartbeat write does not leak onto a replacement workspace at the same path", async () => {
    const sharedPath = path.join(PROJECT_PATH, "reused-checkout");
    await seedWorkspaces([workspaceEntry("original", { path: sharedPath })]);

    // Enqueue remove + recreate back-to-back (editConfig is FIFO) so BOTH land before
    // the heartbeat write's transform: a NEW workspace (different id) reuses the path.
    const removal = config.removeWorkspace("original");
    const recreate = config.editConfig((cfg) => {
      cfg.projects
        .get(PROJECT_PATH)
        ?.workspaces.push(workspaceEntry("replacement", { path: sharedPath }));
      return cfg;
    });
    // Resolves "original" from the pre-removal snapshot, then its transform runs
    // after the remove+recreate and must NOT match the replacement by path.
    const writeResult = await service.setHeartbeatSettings("original", {
      enabled: true,
      intervalMs: 45 * 60 * 1000,
    });
    await Promise.all([removal, recreate]);

    expect(writeResult.success).toBe(false);
    const replacement = readPersistedWorkspaces().find((w) => w.id === "replacement");
    expect(replacement).toBeDefined();
    expect(replacement?.heartbeat).toBeUndefined();
  });
});
