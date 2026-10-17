import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRouterClient } from "@orpc/server";
import { afterEach, describe, expect, test } from "bun:test";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { createConfigStores } from "@/node/config";
import { router } from "@/node/orpc/router";
import { ServiceContainer } from "./serviceContainer";

// #6510 and #6562 removed the MaxListeners caps on AIService and InitStateManager, because every
// live session adds listeners and any fixed cap gave false warnings. The cap also caught a real
// leak, though: a permanent subscriber that adds one listener per call. This test is that guard
// now. It builds the real service graph, records the listener count per event, opens and closes
// several workspaces with turns, and requires every count to return to the recorded one.

const WORKSPACES = 3;
const TURNS_PER_WORKSPACE = 2;

type ListenerCounts = Record<string, number>;

function listenerCounts(emitter: EventEmitter): ListenerCounts {
  const counts: ListenerCounts = {};
  for (const name of emitter.eventNames()) counts[String(name)] = emitter.listenerCount(name);
  return counts;
}

let services: ServiceContainer | undefined;
let tempDir: string | undefined;
afterEach(async () => {
  if (services) {
    await services.dispose();
    await services.shutdown();
    services = undefined;
  }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("ServiceContainer permanent listeners", () => {
  test("opening, using and closing workspaces leaves every AIService and InitStateManager listener count unchanged", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-permanent-listeners-"));
    const projectPath = path.join(tempDir, "project");
    await fs.mkdir(projectPath);
    await promisify(execFile)("git", ["init", "-q", "-b", "main"], { cwd: projectPath });
    const stores = createConfigStores(path.join(tempDir, "root"));
    services = new ServiceContainer(stores);
    await services.initialize();
    services.aiService.enableMockMode();
    const orpc = createRouterClient(router(), { context: services.toORPCContext() });
    const project = await orpc.projects.create({ projectPath });
    if (!project.success) throw new Error(project.error);
    await orpc.projects.setTrust({ projectPath, trusted: true });
    const aiService = services.aiService;
    const initStateManager = services.initStateManager;

    const workspaceWithTurns = async (index: number) => {
      const created = await orpc.workspace.create({
        projectPath,
        branchName: `listeners-${index}`,
        runtimeConfig: { type: "local" },
      });
      if (!created.success) throw new Error(created.error);
      const workspaceId = created.metadata.id;
      for (let turn = 0; turn < TURNS_PER_WORKSPACE; turn++) {
        const ended = new Promise<void>((resolve) => {
          const onEnd = (event: { workspaceId?: string }) => {
            if (event.workspaceId !== workspaceId) return;
            aiService.off("stream-end", onEnd);
            resolve();
          };
          aiService.on("stream-end", onEnd);
        });
        const sent = await orpc.workspace.sendMessage({
          workspaceId,
          message: `turn ${turn}`,
          options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
        });
        expect(sent.success).toBe(true);
        await ended;
        await services!.workspaceService.waitForIdleAndNoQueuedMessages(workspaceId);
      }
      const removed = await orpc.workspace.remove({ workspaceId, options: { force: true } });
      expect(removed.success).toBe(true);
    };

    // One full cycle first, so subscribers that attach once on first use are in the baseline.
    await workspaceWithTurns(0);
    const aiBaseline = listenerCounts(aiService);
    const initBaseline = listenerCounts(initStateManager);
    expect(Object.keys(aiBaseline).length).toBeGreaterThan(0);

    for (let index = 1; index <= WORKSPACES; index++) await workspaceWithTurns(index);

    expect(listenerCounts(aiService)).toEqual(aiBaseline);
    expect(listenerCounts(initStateManager)).toEqual(initBaseline);
  }, 120_000);
});
