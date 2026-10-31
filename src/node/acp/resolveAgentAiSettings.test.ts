import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { Config } from "@/node/config";
import {
  listAgentDefinitions,
  type AgentDefinitionsContext,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { nodeRuntimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";
import { DisposableTempDir } from "@/node/services/tempDir";

import { resolveAgentAiSettings } from "./resolveAgentAiSettings";
import type { ORPCClient } from "./serverConnection";

/** The two calls the ACP resolver makes, served by the real agents.list over a temp project. */
function clientFor(projectPath: string, config: Config): ORPCClient {
  const context: AgentDefinitionsContext = {
    config,
    aiService: {
      getWorkspaceMetadata: () => {
        throw new Error("Unexpected workspace lookup");
      },
      runtimeFactory: nodeRuntimeFactory,
    },
    initStateManager: {
      waitForInit: () => {
        throw new Error("Unexpected workspace initialization");
      },
    },
  };
  return {
    config: { getConfig: () => Promise.resolve(config.loadConfigOrDefault()) },
    agents: {
      list: (input: { includeDisabled?: boolean }) =>
        listAgentDefinitions(context, { projectPath, includeDisabled: input.includeDisabled }),
    },
  } as unknown as ORPCClient;
}

describe("ACP resolveAgentAiSettings with ai.settingsBase (Cursor model: fast)", () => {
  test("an agent with settingsBase explore takes Explore's Settings model, not Exec's", async () => {
    using project = new DisposableTempDir("acp-settings-base");
    using home = new DisposableTempDir("acp-settings-base-home");
    const agentsRoot = path.join(project.path, ".xum", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });
    await fs.writeFile(
      path.join(agentsRoot, "ci-watcher.md"),
      "---\nname: ci-watcher\nbase: exec\nai:\n  settingsBase: explore\n---\nWatch CI.\n"
    );
    const config = new Config(home.path);
    const agentAiDefaults: AgentAiDefaults = {
      explore: { modelString: "custom:m-explore" },
      exec: { modelString: "custom:m-exec" },
    };
    await config.editConfig((cfg) => ({ ...cfg, agentAiDefaults }));

    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = home.path;
    try {
      const resolved = await resolveAgentAiSettings(clientFor(project.path, config), "ci-watcher");
      expect(resolved.model).toBe("custom:m-explore");
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });
});
