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
    const metadataEvents: unknown[] = [];
    service.on("metadata", (event: { workspaceId: string }) => metadataEvents.push(event));

    const result = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, false);

    expect(result.success).toBe(true);
    expect(harness.persistedConsent()).toBeUndefined();
    // Nothing changed on disk, so nothing is republished.
    expect(metadataEvents).toEqual([]);
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

    // Already on: the generation is retained (no revocation semantics on a repeat enable).
    const again = await service.setUnrelatedWorkspaceConsent(WORKSPACE_ID, true);
    expect(again.success).toBe(true);
    expect(harness.persistedConsent()).toBe(generation);
    expect(published).toHaveLength(1);
  });

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

  test("rejects unknown workspaces without touching config", async () => {
    const before = JSON.stringify([...config.loadConfigOrDefault().projects.entries()]);
    const result = await service.setUnrelatedWorkspaceConsent("0000000000", true);
    expect(result.success).toBe(false);
    expect(JSON.stringify([...config.loadConfigOrDefault().projects.entries()])).toBe(before);
  });

  test("consent is not carried into a new workspace entry built from another workspace's metadata", async () => {
    // Forks and child tasks assemble their own metadata; the loader's metadata→entry
    // projection is the one place where a copied field could resurrect consent, so pin
    // that an entry written from consented metadata still needs an explicit opt-in.
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
