import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import { createRouterClient } from "@orpc/server";
import type { ORPCContext } from "@/node/orpc/context";
import { router } from "@/node/orpc/router";
import { configFilePath } from "@/node/config";
import { log } from "@/node/services/log";
import { saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const WORKSPACE_ID = "test-ws";
const PROJECT_PATH = "/test/project";

// chmod 000 does not stop root from reading the file.
const describeAsNonRoot = process.getuid?.() === 0 ? describe.skip : describe;

// #5757: an unreadable config.json made getInfo answer null, made the first edit blame a
// corrupt file, and made later edits say "Workspace not found".
describeAsNonRoot("WorkspaceService with an unreadable config.json", () => {
  let harness: WorkspaceServiceHarness;
  let configFile: string;

  // The workspace.getInfo route, as the renderer and the HTTP API call it.
  function getInfoRoute(workspaceId: string) {
    const context = {
      workspaceService: harness.service,
      config: harness.config,
    } as unknown as ORPCContext;
    return createRouterClient(router(), { context }).workspace.getInfo({ workspaceId });
  }

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    await saveWorkspaces(harness.config, PROJECT_PATH, [
      { id: WORKSPACE_ID, path: "/test/path", name: "test" },
    ]);
    configFile = configFilePath(harness.config.rootDir);
    // The load failure is logged as an error; keep the test output quiet.
    spyOn(log, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await fs.chmod(configFile, 0o600);
    mock.restore();
    await harness.cleanup();
  });

  test("getInfo and edits report the unreadable file until it is readable again", async () => {
    const service = harness.service;
    expect((await service.getInfo(WORKSPACE_ID))?.id).toBe(WORKSPACE_ID);

    await fs.chmod(configFile, 0o000);

    // getInfo must not look like "workspace removed".
    const error = await getInfoRoute(WORKSPACE_ID).then(
      () => null,
      (rejection: Error) => rejection
    );
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(error?.message).toMatch(/could not be read/);

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await service.updateTitle(WORKSPACE_ID, `title ${attempt}`);
      if (result.success) throw new Error("Expected the edit to be refused");
      expect(result.error).toMatch(/could not be read/);
      expect(result.error).not.toMatch(/corrupt|Workspace not found/);
    }

    // Recovery needs no restart.
    await fs.chmod(configFile, 0o600);
    expect((await service.updateTitle(WORKSPACE_ID, "readable again")).success).toBe(true);
    expect((await getInfoRoute(WORKSPACE_ID))?.title).toBe("readable again");
    expect(harness.config.getConfigLoadError()).toBeNull();
  });

  test("the getInfo route still answers null for a workspace that does not exist", async () => {
    expect(await getInfoRoute("missing")).toBeNull();
  });
});
