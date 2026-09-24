import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Workspace } from "@/common/types/project";
import { getValidUnrelatedWorkspaceConsent } from "@/common/orpc/schemas/workspace";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { InitStateManager } from "./initStateManager";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceService } from "./workspaceService";

const WORKSPACE_ID = "a1b2c3d4e5";
const OTHER_WORKSPACE_ID = "f6e5d4c3b2";

/**
 * Real Config in a temp root: the consent generation must round-trip through the serialized
 * config writer and the metadata loader, not a mocked transform.
 */
async function createHarness() {
  const { config, historyService, tempDir, cleanup } = await createTestHistoryService();
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

  const aiService = new EventEmitter() as unknown as AIService;
  // Metadata publication enriches rows with init state; the narrow stub keeps that path real.
  const initStateManager = Object.assign(new EventEmitter(), {
    getInitState: () => undefined,
  }) as unknown as InitStateManager;
  const service = new WorkspaceService(
    config,
    historyService,
    aiService,
    new ContextManagementService({ config, historyService, aiService }),
    initStateManager,
    {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    } as unknown as ExtensionMetadataService,
    {} as BackgroundProcessManager
  );

  const persistedConsent = (workspaceId = WORKSPACE_ID): unknown =>
    [...config.loadConfigOrDefault().projects.values()]
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === workspaceId)?.unrelatedWorkspaceConsent;

  return { config, service, projectPath, workspacePath, persistedConsent, cleanup };
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

describe("WorkspaceService.grantDefaultUnrelatedWorkspaceConsent", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
  });

  /** What create() records when it defers the default grant to WorkspaceTurnManager. */
  const markDeferredDefault = (workspaceId = WORKSPACE_ID) =>
    (
      harness.service as unknown as { pendingDefaultUnrelatedConsent: Set<string> }
    ).pendingDefaultUnrelatedConsent.add(workspaceId);

  test("persists a generation for that workspace only and publishes it", async () => {
    const published: Array<{
      workspaceId: string;
      metadata: { unrelatedWorkspaceConsent?: string } | null;
    }> = [];
    harness.service.on(
      "metadata",
      (event: { workspaceId: string; metadata: { unrelatedWorkspaceConsent?: string } | null }) =>
        published.push(event)
    );

    markDeferredDefault();
    await harness.service.grantDefaultUnrelatedWorkspaceConsent(WORKSPACE_ID);

    const generation = harness.persistedConsent();
    expect(typeof generation).toBe("string");
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
    expect(harness.persistedConsent(OTHER_WORKSPACE_ID)).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0].workspaceId).toBe(WORKSPACE_ID);
    expect(published[0].metadata?.unrelatedWorkspaceConsent).toBe(generation as string);
  });

  test("an explicit toggle while the default is pending wins over the deferred grant", async () => {
    markDeferredDefault();
    // The user turns it on and back off after the workspace appeared, before the grant runs.
    expect((await harness.service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true)).success).toBe(
      true
    );
    expect((await harness.service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false)).success).toBe(
      true
    );
    const published: unknown[] = [];
    harness.service.on("metadata", (event: unknown) => published.push(event));

    await harness.service.grantDefaultUnrelatedWorkspaceConsent(WORKSPACE_ID);

    expect(harness.persistedConsent()).toBeUndefined();
    expect(published).toEqual([]);
  });

  test("a failing metadata publication does not throw out of the deferred grant", async () => {
    markDeferredDefault();
    // A downstream metadata consumer throwing makes the publication reject.
    harness.service.on("metadata", () => {
      throw new Error("metadata consumer exploded");
    });

    // Resolves (WorkspaceTurnManager must still reach its send/settlement paths)...
    await harness.service.grantDefaultUnrelatedWorkspaceConsent(WORKSPACE_ID);
    // ...and the grant itself stays durable.
    const generation = harness.persistedConsent();
    expect(getValidUnrelatedWorkspaceConsent(generation)).toBe(generation as string);
  });

  test("grants nothing to a workspace whose creation did not defer the default", async () => {
    // Existing workspaces must never be backfilled, even through the deferred-grant entry point.
    await harness.service.grantDefaultUnrelatedWorkspaceConsent(OTHER_WORKSPACE_ID);
    expect(harness.persistedConsent(OTHER_WORKSPACE_ID)).toBeUndefined();

    // And the pending mark is one-shot: a second call after a grant does nothing new.
    markDeferredDefault();
    await harness.service.grantDefaultUnrelatedWorkspaceConsent(WORKSPACE_ID);
    const generation = harness.persistedConsent();
    expect((await harness.service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false)).success).toBe(
      true
    );
    await harness.service.grantDefaultUnrelatedWorkspaceConsent(WORKSPACE_ID);
    expect(generation).toBeDefined();
    expect(harness.persistedConsent()).toBeUndefined();
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
