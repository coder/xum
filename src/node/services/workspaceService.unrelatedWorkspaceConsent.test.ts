import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import cjsFs from "fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Workspace } from "@/common/types/project";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import type { WorkspaceService } from "./workspaceService";
import {
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const WORKSPACE_ID = "a1b2c3d4e5";
const OTHER_WORKSPACE_ID = "f6e5d4c3b2";

/**
 * Real Config in a temp root: the consent generation must round-trip through the serialized
 * config writer and the metadata loader, not a mocked transform.
 */
async function createHarness() {
  const { config, service, rootDir: tempDir, cleanup } = await createWorkspaceServiceHarness();
  const projectPath = path.join(tempDir, "project");
  const workspacePath = path.join(tempDir, "src", "project", "consent-ws");
  const otherWorkspacePath = path.join(tempDir, "src", "project", "other-ws");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(otherWorkspacePath, { recursive: true });
  await config.editConfig((cfg) => {
    const workspaces: Workspace[] = [
      { id: WORKSPACE_ID, name: "consent-ws", path: workspacePath },
      { id: OTHER_WORKSPACE_ID, name: "other-ws", path: otherWorkspacePath },
    ];
    cfg.projects.set(projectPath, { workspaces });
    return cfg;
  });

  const persistedConsent = (workspaceId = WORKSPACE_ID): unknown =>
    [...config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === workspaceId)?.unrelatedWorkspaceConsent;

  return { config, service, projectPath, workspacePath, persistedConsent, cleanup };
}

/**
 * Fails only the rename that publishes config.json, so the save really fails inside the real
 * editConfig pipeline (#4444) while every other file write stays real.
 */
function failConfigPublish() {
  const realRename = cjsFs.rename.bind(cjsFs);
  return spyOn(cjsFs, "rename").mockImplementation(((
    from: cjsFs.PathLike,
    to: cjsFs.PathLike,
    callback: cjsFs.NoParamCallback
  ) => {
    if (path.basename(String(to)) === "config.json") {
      callback(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
      return;
    }
    realRename(from, to, callback);
  }) as typeof cjsFs.rename);
}

describe("WorkspaceService.setUnrelatedWorkspaceConsent", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let config: Config;
  let service: WorkspaceService;

  beforeEach(async () => {
    harness = await createHarness();
    config = harness.config;
    service = harness.service;
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  test("enabling fails loudly and publishes nothing when the save fails (#4444)", async () => {
    const metadataEvents: Array<{ metadata: { unrelatedWorkspaceConsent?: string } | null }> = [];
    service.on("metadata", (event: { metadata: { unrelatedWorkspaceConsent?: string } | null }) =>
      metadataEvents.push(event)
    );
    const publish = failConfigPublish();

    const result = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true);
    publish.mockRestore();

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected Err");
    expect(result.error).toContain("EACCES");
    expect(harness.persistedConsent()).toBeUndefined();
    expect(metadataEvents.some((event) => event.metadata?.unrelatedWorkspaceConsent != null)).toBe(
      false
    );
  });

  test("revoking fails loudly and keeps the persisted grant when the save fails (#4444)", async () => {
    expect((await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(true);
    const generation = harness.persistedConsent();
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
    const publish = failConfigPublish();

    const result = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false);
    publish.mockRestore();

    // Never report a revocation that discovery and admission will not see.
    expect(result.success).toBe(false);
    expect(harness.persistedConsent()).toBe(generation);
  });

  test("consent is off by default and revoking an already-off workspace is a committed no-op", async () => {
    expect(harness.persistedConsent()).toBeUndefined();
    const metadataEvents: Array<{
      workspaceId: string;
      metadata: { unrelatedWorkspaceConsent?: string } | null;
    }> = [];
    service.on(
      "metadata",
      (event: { workspaceId: string; metadata: { unrelatedWorkspaceConsent?: string } | null }) =>
        metadataEvents.push(event)
    );

    const result = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false);

    expect(result.success).toBe(true);
    expect(harness.persistedConsent()).toBeUndefined();
    // Nothing changed on disk, but the authoritative state is still republished: the Ok ack
    // promises "committed AND published", and a no-op is what a retry after a failed
    // publication looks like.
    expect(metadataEvents).toHaveLength(1);
    expect(metadataEvents[0].workspaceId).toBe(WORKSPACE_ID);
    expect(metadataEvents[0].metadata?.unrelatedWorkspaceConsent).toBeUndefined();
  });

  test("enabling persists an opaque generation, publishes metadata, and stays idempotent while on", async () => {
    const published: Array<{
      workspaceId: string;
      metadata: { unrelatedWorkspaceConsent?: string } | null;
    }> = [];
    service.on(
      "metadata",
      (event: { workspaceId: string; metadata: { unrelatedWorkspaceConsent?: string } | null }) =>
        published.push(event)
    );

    const enabled = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true);
    expect(enabled.success).toBe(true);

    // The ack means the generation is already committed to config...
    const generation = harness.persistedConsent();
    expect(typeof generation).toBe("string");
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
    // ...and already published on the shared metadata channel.
    expect(published).toHaveLength(1);
    expect(published[0].workspaceId).toBe(WORKSPACE_ID);
    expect(published[0].metadata?.unrelatedWorkspaceConsent).toBe(generation as string);

    // A fresh metadata load (what every other reader sees) carries the same generation.
    const reloaded = await config.getAllWorkspaceMetadata();
    expect(reloaded.find((m) => m.id === WORKSPACE_ID)?.unrelatedWorkspaceConsent).toBe(
      generation as string
    );
    // The other workspace is untouched: consent never leaks across entries.
    expect(reloaded.find((m) => m.id === OTHER_WORKSPACE_ID)?.unrelatedWorkspaceConsent).toBe(
      undefined
    );

    // Already on: the generation is retained (no revocation semantics on a repeat enable),
    // and the unchanged state is republished so a retry can heal a stale UI.
    const again = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true);
    expect(again.success).toBe(true);
    expect(harness.persistedConsent()).toBe(generation);
    expect(published).toHaveLength(2);
    expect(published[1].workspaceId).toBe(WORKSPACE_ID);
    expect(published[1].metadata?.unrelatedWorkspaceConsent).toBe(generation as string);
  });

  test.each([
    { label: "enabling", enabled: true },
    { label: "disabling", enabled: false },
  ])(
    "$label: a failed publication leaves the write committed and the idempotent retry publishes it",
    async ({ enabled }) => {
      // Start from the opposite state so the first call is a real transition.
      if (!enabled) {
        expect((await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(true);
      }
      const before = harness.persistedConsent();

      // A real downstream consumer failing during publication: registered first so it runs
      // before the observing listener and aborts the emit (EventEmitter runs listeners
      // synchronously and propagates the throw).
      let failNextPublication = true;
      service.on("metadata", () => {
        if (failNextPublication) {
          failNextPublication = false;
          throw new Error("metadata consumer exploded");
        }
      });
      const published: Array<{
        workspaceId: string;
        metadata: { unrelatedWorkspaceConsent?: string } | null;
      }> = [];
      service.on(
        "metadata",
        (event: { workspaceId: string; metadata: { unrelatedWorkspaceConsent?: string } | null }) =>
          published.push(event)
      );

      const first = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, enabled);
      // The ack is "committed AND published", so a publication failure is an error...
      expect(first.success).toBe(false);
      // ...but the config write already happened and is not rolled back.
      const committed = harness.persistedConsent();
      expect(committed).not.toBe(before);
      if (enabled) {
        expect(getValidUnrelatedWorkspaceConsent(committed)).toBe(committed as string);
      } else {
        expect(committed).toBeUndefined();
      }
      expect(published).toEqual([]);

      // Retrying the same value is a no-op on disk yet must publish the authoritative state:
      // same generation (no re-mint, so nothing admitted under it is invalidated), same "off".
      const retry = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, enabled);
      expect(retry.success).toBe(true);
      expect(harness.persistedConsent()).toBe(committed);
      expect(published).toHaveLength(1);
      expect(published[0].workspaceId).toBe(WORKSPACE_ID);
      expect(published[0].metadata?.unrelatedWorkspaceConsent).toBe(
        enabled ? (committed as string) : undefined
      );
    }
  );

  test("revoking deletes the field and re-enabling mints a different generation", async () => {
    expect((await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(true);
    const first = harness.persistedConsent();
    expect(typeof first).toBe("string");

    const revoked = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false);
    expect(revoked.success).toBe(true);
    // Deleted, not set to "" or false: absent is the only off representation on disk.
    expect(harness.persistedConsent()).toBeUndefined();
    const workspaceEntry = [...config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === WORKSPACE_ID);
    expect(workspaceEntry != null && "unrelatedWorkspaceConsent" in workspaceEntry).toBe(false);

    expect((await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(true);
    const second = harness.persistedConsent();
    expect(typeof second).toBe("string");
    // Off→on is a new generation: anything admitted under the old one is stale.
    expect(second).not.toBe(first);
  });

  test("enabling over a malformed persisted value mints a fresh generation instead of keeping it", async () => {
    await config.editConfig((cfg) => {
      const entry = cfg.projects
        .get(harness.projectPath)
        ?.workspaces.find((w) => w.id === WORKSPACE_ID);
      if (entry) {
        (entry as { unrelatedWorkspaceConsent?: unknown }).unrelatedWorkspaceConsent = "   ";
      }
      return cfg;
    });
    // Malformed reads as off (fail closed) both in the validator and in published metadata.
    expect(getValidUnrelatedWorkspaceConsent(harness.persistedConsent())).toBeUndefined();
    const metadata = await config.getAllWorkspaceMetadata();
    expect(metadata.find((m) => m.id === WORKSPACE_ID)?.unrelatedWorkspaceConsent).toBeUndefined();
    // Legacy/corrupted values never brick the workspace: it is still listed and addressable.
    expect(metadata.find((m) => m.id === WORKSPACE_ID)?.name).toBe("consent-ws");

    expect((await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(true);
    const generation = harness.persistedConsent();
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
  });

  test("rejects unknown workspaces without touching config or publishing", async () => {
    const before = JSON.stringify([...config.loadConfigOrDefault().projects.entries()]);
    const metadataEvents: unknown[] = [];
    service.on("metadata", (event: unknown) => metadataEvents.push(event));
    const result = await service.setUnrelatedWorkspaceConsent("0000000000", true);
    expect(result.success).toBe(false);
    expect(JSON.stringify([...config.loadConfigOrDefault().projects.entries()])).toBe(before);
    // Republishing is for successful writes only; a rejected id must not emit a null row.
    expect(metadataEvents).toEqual([]);
  });

  test("loading a child does not derive consent from its parent", async () => {
    // Consent belongs to the actual recipient; metadata loading must not inherit the parent's grant.
    expect((await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(true);
    const source = (await config.getAllWorkspaceMetadata()).find((m) => m.id === WORKSPACE_ID);
    expect(source?.unrelatedWorkspaceConsent).toBeDefined();

    const forkPath = path.join(harness.workspacePath, "..", "consent-ws-fork");
    await fs.mkdir(forkPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.get(harness.projectPath)?.workspaces.push({
        id: "0f0e0d0c0b",
        name: "consent-ws-fork",
        path: forkPath,
        parentWorkspaceId: WORKSPACE_ID,
      });
      return cfg;
    });
    const fork = (await config.getAllWorkspaceMetadata()).find((m) => m.id === "0f0e0d0c0b");
    expect(fork).toBeDefined();
    expect(fork?.unrelatedWorkspaceConsent).toBeUndefined();
    // Parent's consent is unchanged by adding a child.
    expect(
      (await config.getAllWorkspaceMetadata()).find((m) => m.id === WORKSPACE_ID)
        ?.unrelatedWorkspaceConsent
    ).toBe(source?.unrelatedWorkspaceConsent);
  });
});

describe("WorkspaceService deferred-checkout default consent", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  interface ServiceInternals {
    grantPendingDefaultUnrelatedWorkspaceConsent: (workspaceId: string) => Promise<void>;
    sanitizeMaterializedTaskWorkspace: (...args: unknown[]) => Promise<string | undefined>;
    abortUnsanitizedCreation: (...args: unknown[]) => Promise<boolean>;
    materializeDeferredCheckout: (args: unknown) => Promise<void>;
    saveConfig: (config: unknown) => Promise<void>;
    grantCreationUnrelatedWorkspaceConsent: (
      projectPath: string,
      workspaceId: string,
      workspacePath: string
    ) => Promise<string | undefined>;
  }
  const internals = () => harness.service as unknown as ServiceInternals;
  /** What create() writes on the row when it registers a workspace that gets the default. */
  const markPending = (workspaceId = WORKSPACE_ID) =>
    harness.config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const entry = project.workspaces.find((workspace) => workspace.id === workspaceId);
        if (entry) entry.unrelatedWorkspaceConsentPending = true;
      }
      return cfg;
    });
  const persistedPending = (workspaceId = WORKSPACE_ID) =>
    [...harness.config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === workspaceId)?.unrelatedWorkspaceConsentPending;
  const grantPending = (workspaceId = WORKSPACE_ID) =>
    internals().grantPendingDefaultUnrelatedWorkspaceConsent(workspaceId);

  /** Drives the real deferred-checkout settlement with a fake runtime. */
  async function runDeferredCheckout(options: { materializeError?: Error } = {}) {
    const initLogger = { logStderr: mock(() => undefined), logComplete: mock(() => undefined) };
    await internals().materializeDeferredCheckout({
      workspaceId: WORKSPACE_ID,
      runtime: {
        materializeWorkspace: mock(() =>
          options.materializeError
            ? Promise.reject(options.materializeError)
            : Promise.resolve(undefined)
        ),
      },
      runtimeConfig: { type: "worktree" },
      workspaceName: "consent-ws",
      initParams: {
        projectPath: harness.projectPath,
        workspacePath: harness.workspacePath,
        initLogger,
        trusted: true,
      },
      pending: {},
      initAbortController: new AbortController(),
    });
  }

  test("grants only after the checkout is sanitized, before the init hook runs", async () => {
    await markPending();
    const consentAtSanitize: unknown[] = [];
    const consentAtInit: unknown[] = [];
    spyOn(internals(), "sanitizeMaterializedTaskWorkspace").mockImplementation(() => {
      consentAtSanitize.push(harness.persistedConsent());
      return Promise.resolve(undefined);
    });
    spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() => {
      consentAtInit.push(harness.persistedConsent());
      return Promise.resolve(undefined);
    });
    const published: Array<{ workspaceId: string }> = [];
    harness.service.on("metadata", (event: { workspaceId: string }) => published.push(event));

    await runDeferredCheckout();

    // Not discoverable while stale plugin enables could still be unpruned...
    expect(consentAtSanitize).toEqual([undefined]);
    // ...granted (and published, since the workspace is already announced) before init.
    const generation = harness.persistedConsent();
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
    expect(consentAtInit).toEqual([generation]);
    // The grant consumed the row's pending mark in the same write.
    expect(persistedPending()).toBeUndefined();
    expect(published.map((event) => event.workspaceId)).toEqual([WORKSPACE_ID]);
    expect(harness.persistedConsent(OTHER_WORKSPACE_ID)).toBeUndefined();
  });

  test.each([
    { label: "failed sanitization", sanitizeError: "stale enable", materializeError: undefined },
    { label: "failed checkout", sanitizeError: undefined, materializeError: new Error("clone") },
  ])("$label never grants", async ({ sanitizeError, materializeError }) => {
    await markPending();
    spyOn(internals(), "sanitizeMaterializedTaskWorkspace").mockResolvedValue(sanitizeError);
    spyOn(internals(), "abortUnsanitizedCreation").mockResolvedValue(true);
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);

    await runDeferredCheckout({ materializeError });

    expect(harness.persistedConsent()).toBeUndefined();
  });

  test("an explicit toggle while the default is pending wins", async () => {
    await markPending();
    // The user turns it on and back off after the workspace appeared, before the grant runs.
    expect((await harness.service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(
      true
    );
    expect((await harness.service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false)).success).toBe(
      true
    );
    const published: unknown[] = [];
    harness.service.on("metadata", (event: unknown) => published.push(event));

    // The explicit choice cleared the pending mark.
    expect(persistedPending()).toBeUndefined();
    await grantPending();

    expect(harness.persistedConsent()).toBeUndefined();
    expect(published).toEqual([]);
  });

  test("never grants a workspace that is not pending, and the mark is one-shot", async () => {
    // Existing workspaces must never be backfilled through this path.
    await grantPending(OTHER_WORKSPACE_ID);
    expect(harness.persistedConsent(OTHER_WORKSPACE_ID)).toBeUndefined();

    await markPending();
    await grantPending();
    expect(harness.persistedConsent()).toBeDefined();
    expect((await harness.service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false)).success).toBe(
      true
    );
    await grantPending();
    expect(harness.persistedConsent()).toBeUndefined();
  });

  test("does not report consent whose save failed (#4444)", async () => {
    await markPending();
    const publish = failConfigPublish();

    const reported = await internals().grantCreationUnrelatedWorkspaceConsent(
      harness.projectPath,
      WORKSPACE_ID,
      harness.workspacePath
    );
    publish.mockRestore();

    expect(reported).toBeUndefined();
    expect(harness.persistedConsent()).toBeUndefined();
  });

  test("does not report consent that is not on disk after the edit", async () => {
    await markPending();
    // A write another writer replaced: editConfig resolved, but the file lacks the grant.
    spyOn(harness.config as unknown as ServiceInternals, "saveConfig").mockResolvedValue(undefined);

    // create() and fork() announce exactly what this returns, so it must be the persisted
    // value (none), not the one the transform wrote in memory.
    const reported = await internals().grantCreationUnrelatedWorkspaceConsent(
      harness.projectPath,
      WORKSPACE_ID,
      harness.workspacePath
    );

    expect(reported).toBeUndefined();
    expect(harness.persistedConsent()).toBeUndefined();
  });

  test("a failing metadata publication does not throw out of the grant", async () => {
    await markPending();
    harness.service.on("metadata", () => {
      throw new Error("metadata consumer exploded");
    });

    // Resolves (the deferred checkout must still go on to run its init hook)...
    await grantPending();
    // ...and the grant itself stays durable.
    const generation = harness.persistedConsent();
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
  });
});

describe("getValidUnrelatedWorkspaceConsent", () => {
  test("accepts only non-empty, whitespace-free opaque strings", () => {
    expect(getValidUnrelatedWorkspaceConsent("3b6a1f9e-2c4d-4e8f-9a0b-1c2d3e4f5a6b")).toBe(
      "3b6a1f9e-2c4d-4e8f-9a0b-1c2d3e4f5a6b"
    );
    for (const malformed of [undefined, null, "", "   ", " abc", "abc ", 42, true, {}, []]) {
      expect(getValidUnrelatedWorkspaceConsent(malformed)).toBeUndefined();
    }
  });
});

describe("WorkspaceService.setAgentMessageDispatchMode", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  test("turn-end round-trips through config and metadata; tool-end restores the absent default", async () => {
    const { config, service } = harness;
    const persistedMode = (): unknown =>
      [...config.loadConfigOrDefault().projects.values()]
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === WORKSPACE_ID)?.agentMessageDispatchMode;
    const published: Array<{ agentMessageDispatchMode?: string } | null> = [];
    service.on("metadata", (event: { metadata: { agentMessageDispatchMode?: string } | null }) =>
      published.push(event.metadata)
    );

    expect((await service.setAgentMessageDispatchMode(WORKSPACE_ID, "turn-end")).success).toBe(
      true
    );
    expect(persistedMode()).toBe("turn-end");
    expect(published.at(-1)?.agentMessageDispatchMode).toBe("turn-end");
    const reloaded = await config.getAllWorkspaceMetadata();
    expect(reloaded.find((m) => m.id === WORKSPACE_ID)?.agentMessageDispatchMode).toBe("turn-end");
    expect(
      reloaded.find((m) => m.id === OTHER_WORKSPACE_ID)?.agentMessageDispatchMode
    ).toBeUndefined();

    // The default is stored as an absent field, so old and new entries read the same way.
    expect((await service.setAgentMessageDispatchMode(WORKSPACE_ID, "tool-end")).success).toBe(
      true
    );
    expect(persistedMode()).toBeUndefined();
    expect(published.at(-1)?.agentMessageDispatchMode).toBeUndefined();
  });

  test("does not acknowledge a mode that is not on disk after the edit", async () => {
    // A write another writer replaced: editConfig resolved, but the file lacks the mode.
    spyOn(
      harness.config as unknown as { saveConfig: (config: unknown) => Promise<void> },
      "saveConfig"
    ).mockResolvedValue(undefined);

    const result = await harness.service.setAgentMessageDispatchMode(WORKSPACE_ID, "turn-end");

    expect(result.success).toBe(false);
  });
});

/**
 * #4446: two backends share one root (desktop beside `xum server`). Backend A creates a root
 * workspace and grants its default consent once setup completes; backend B, which sees the row
 * in config, can toggle consent in that window. B's explicit choice must win: the pending
 * default lives on the row, so B's toggle clears it.
 */
describe("default consent pending mark (#4446, #4455)", () => {
  const CREATED_ID = "c0ffee0001";
  let harness: Awaited<ReturnType<typeof createWorkspaceServiceHarness>>;
  let projectPath: string;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    projectPath = path.join(harness.rootDir, "proj");
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "existing", "e0e0e0e0e0"),
    ]);
    spyOn(harness.config, "generateStableId").mockReturnValue(CREATED_ID);
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  const readEntry = () =>
    new Config(harness.rootDir)
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((entry) => entry.id === CREATED_ID) as
      | (Workspace & Record<string, unknown>)
      | undefined;
  /** Backend B: its own Config on the same root. */
  const backendB = () => createWorkspaceServiceForTest({ config: new Config(harness.rootDir) });

  interface CreateInternals {
    sanitizeStalePluginOverridesForNewWorkspace: (
      ...args: unknown[]
    ) => Promise<string | undefined>;
    sanitizeMaterializedTaskWorkspace: (...args: unknown[]) => Promise<string | undefined>;
    secretsStore: { getEffectiveSecrets: (projectPath: string) => unknown };
  }
  const internals = () => harness.service as unknown as CreateInternals;

  /** Runtime whose checkout is deferred and materializes when `gate` resolves. */
  function mockDeferredRuntime(gate: Promise<void>) {
    let initStarted!: () => void;
    const initRan = new Promise<void>((resolve) => (initStarted = resolve));
    const workspacePath = path.join(projectPath, "deferred");
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: mock(() =>
        Promise.resolve({ success: true as const, workspacePath, pendingMaterialization: {} })
      ),
      materializeWorkspace: mock(() => gate),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    spyOn(internals(), "sanitizeMaterializedTaskWorkspace").mockResolvedValue(undefined);
    spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() => {
      initStarted();
      return Promise.resolve(undefined);
    });
    return { initRan };
  }

  const createDeferredWorkspace = () =>
    harness.service.create(projectPath, "deferred", undefined, undefined, { type: "local" });

  /** create() with a deferred checkout whose materialization waits for `gate`. */
  async function createDeferred(gate: Promise<void>) {
    const { initRan } = mockDeferredRuntime(gate);
    const result = await createDeferredWorkspace();
    expect(result.success).toBe(true);
    // Wrapped: returning the bare promise would make `await createDeferred()` wait for init.
    return { initRan };
  }

  test("create() announces a deferred checkout with the mark set and settles it into consent", async () => {
    // At the announcement the checkout is not sanitized yet: pending, and no consent.
    const atAnnouncement: Array<{ pending: unknown; consent: unknown }> = [];
    harness.service.on("metadata", (event: { workspaceId: string }) => {
      if (event.workspaceId !== CREATED_ID || atAnnouncement.length > 0) return;
      const entry = readEntry();
      atAnnouncement.push({
        pending: entry?.unrelatedWorkspaceConsentPending,
        consent: entry?.unrelatedWorkspaceConsent,
      });
    });
    let release!: () => void;
    const { initRan } = await createDeferred(new Promise<void>((resolve) => (release = resolve)));
    expect(atAnnouncement).toEqual([{ pending: true, consent: undefined }]);

    release();
    await initRan;

    expect(getValidUnrelatedWorkspaceConsent(readEntry()?.unrelatedWorkspaceConsent)).toBeDefined();
    expect(readEntry()?.unrelatedWorkspaceConsentPending).toBeUndefined();
  });

  test("create() that fails after registration leaves no pending mark behind", async () => {
    mockDeferredRuntime(new Promise<void>(() => undefined));
    // Fails once the row is registered, before the deferred checkout's settlement is retained.
    const secretsStore = internals().secretsStore;
    const realGetEffectiveSecrets = secretsStore.getEffectiveSecrets.bind(secretsStore);
    spyOn(secretsStore, "getEffectiveSecrets").mockImplementation((projectPathArg: string) => {
      if (readEntry() != null) throw new Error("secrets unavailable");
      return realGetEffectiveSecrets(projectPathArg);
    });

    const result = await createDeferredWorkspace();

    expect(result.success).toBe(false);
    // The failed create() keeps its row today (tracked separately); the default must not stay
    // pending on it, and no consent was granted.
    expect(readEntry()?.unrelatedWorkspaceConsentPending).toBeUndefined();
    expect(readEntry()?.unrelatedWorkspaceConsent).toBeUndefined();
  });

  test.each([
    { choice: false, label: "opts out" },
    { choice: true, label: "opts in" },
  ])("deferred checkout: B $label while A materializes, and B's choice wins", async (row) => {
    let release!: () => void;
    const { initRan } = await createDeferred(new Promise<void>((resolve) => (release = resolve)));
    expect(readEntry()).toBeDefined();

    expect((await backendB().setUnrelatedWorkspaceConsent(CREATED_ID, row.choice)).success).toBe(
      true
    );
    const chosen = readEntry()?.unrelatedWorkspaceConsent;
    const published: Array<{
      workspaceId: string;
      metadata: { unrelatedWorkspaceConsent?: string } | null;
    }> = [];
    harness.service.on("metadata", (event: (typeof published)[number]) => published.push(event));
    release();
    await initRan;

    // A's grant never reverses B's opt-out, nor rotates B's opt-in generation.
    expect(readEntry()?.unrelatedWorkspaceConsent).toBe(chosen);
    expect(chosen === undefined).toBe(!row.choice);
    expect(readEntry()?.unrelatedWorkspaceConsentPending).toBeUndefined();
    // A's UI learns of B's opt-in (the workspace is already announced); an opt-out publishes nothing.
    expect(
      published
        .filter((event) => event.workspaceId === CREATED_ID)
        .map((event) => event.metadata?.unrelatedWorkspaceConsent)
    ).toEqual(row.choice ? [chosen] : []);
  });

  test.each([
    { choice: false, label: "opts out" },
    { choice: true, label: "opts in" },
  ])(
    "immediate checkout: B $label between registration and A's grant, and B's choice wins",
    async (row) => {
      const workspacePath = path.join(projectPath, "immediate");
      await fs.mkdir(workspacePath, { recursive: true });
      spyOn(runtimeFactory, "createRuntime").mockReturnValue({
        createWorkspace: mock(() => Promise.resolve({ success: true as const, workspacePath })),
      } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
      spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
      // The row is registered; A sanitizes before granting. B toggles in that window.
      let chosen: string | undefined;
      spyOn(internals(), "sanitizeStalePluginOverridesForNewWorkspace").mockImplementation(
        async () => {
          const toggled = await backendB().setUnrelatedWorkspaceConsent(CREATED_ID, row.choice);
          expect(toggled.success).toBe(true);
          chosen = readEntry()?.unrelatedWorkspaceConsent;
          return undefined;
        }
      );

      const result = await harness.service.create(projectPath, "immediate", undefined, undefined, {
        type: "local",
      });

      expect(result.success).toBe(true);
      expect(chosen === undefined).toBe(!row.choice);
      expect(readEntry()?.unrelatedWorkspaceConsent).toBe(chosen);
      expect(readEntry()?.unrelatedWorkspaceConsentPending).toBeUndefined();
      // A announces B's choice as it stands, not a stale "off".
      expect(result.success && result.data.metadata.unrelatedWorkspaceConsent).toBe(chosen);
    }
  );
});
