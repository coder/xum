import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { McpAppResultStore } from "@/node/services/mcpAppResultStore";

// #6772: the MCP server manager's apps gate is wired in the core service layer
// (`di/layers/core.ts`). Unit tests inject `isEnabled`, so only the real wiring shows which
// experiment it reads. The manager returns the stored model contexts of MCP App views only while
// its gate is on, which makes the gate visible from outside.
describe("MCP server manager apps gate", () => {
  let env: TestEnvironment;
  const workspaceId = "ws-mcp-apps-gate";

  beforeAll(async () => {
    env = await createTestEnvironment();
    // Same layout as the core layer's store: <sessionsDir>/<workspaceId>. The store refuses
    // writes for a workspace without a session dir.
    await fs.mkdir(path.join(env.config.sessionsDir, workspaceId), { recursive: true });
    const store = new McpAppResultStore(
      (id) => path.join(env.config.sessionsDir, id),
      env.config.rootDir
    );
    await store.setModelContext(workspaceId, {
      toolCallId: "call-1",
      serverName: "charts",
      toolName: "show_chart",
      text: "Q3 revenue chart",
    });
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("follows the mcp-apps experiment, not Artifacts", async () => {
    const experiments = env.services.experimentsService;
    const manager = env.services.mcpServerManager;

    await experiments.setOverride(EXPERIMENT_IDS.ARTIFACTS, true);
    await experiments.setOverride(EXPERIMENT_IDS.MCP_APPS, false);
    expect(await manager.getMcpAppModelContexts(workspaceId)).toEqual([]);

    await experiments.setOverride(EXPERIMENT_IDS.ARTIFACTS, false);
    await experiments.setOverride(EXPERIMENT_IDS.MCP_APPS, true);
    const contexts = await manager.getMcpAppModelContexts(workspaceId);
    expect(contexts.map((context) => context.text)).toEqual(["Q3 revenue chart"]);
  });
});
