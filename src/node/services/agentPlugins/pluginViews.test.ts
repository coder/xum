import { describe, expect, test } from "bun:test";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0, type AgentPluginViewContribution } from "./manifest";
import { AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0, createAgentPluginsMcpProvider } from "./mcpConfig";
import { attachPluginViewServers, discoverPluginViews } from "./pluginViews";

async function writePlugin(
  root: string,
  name: string,
  views: AgentPluginViewContribution[],
  serverNames: string[]
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name, contributes: { views } })
  );
  await fs.writeFile(
    path.join(root, "mcp.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
      mcpServers: Object.fromEntries(
        serverNames.map((serverName) => [serverName, { type: "stdio", command: "node" }])
      ),
    })
  );
}

const view = (id: string, server: string): AgentPluginViewContribution => ({
  id,
  title: `View ${id}`,
  server,
  resourceUri: `ui://${id}/view`,
});

describe("plugin views", () => {
  test("bind to their own plugin's server keys, which the MCP provider also produces", async () => {
    using tmp = new DisposableTempDir("plugin-views-bind");
    const checkout = path.join(tmp.path, "checkout");
    const xumHome = path.join(tmp.path, "home");
    await writePlugin(
      path.join(checkout, ".xum", "plugins", "review-bot"),
      "review-bot",
      // "shared" is a server only the OTHER plugin has: this view must not reach it.
      [view("settings", "settings"), view("borrow", "shared"), view("missing", "nope")],
      ["settings"]
    );
    await writePlugin(path.join(xumHome, "plugins", "other"), "other", [], ["shared"]);
    const context = { projectRoot: checkout, projectKey: "/projects/review" };

    const views = (await discoverPluginViews({ xumHome, projectTrusted: true, context })).filter(
      (entry) => entry.pluginName === "review-bot"
    );
    expect(views.map((entry) => entry.pluginViewId.split("/")[1])).toEqual([
      "settings",
      "borrow",
      "missing",
    ]);
    const servers = await createAgentPluginsMcpProvider({ xumHome })({
      ...context,
      trusted: true,
    });
    const settingsKey = views[0].serverKey;
    expect(settingsKey).toBe(`plugin:${views[0].pluginViewId.split("/")[0]}:settings`);
    expect(Object.keys(servers)).toContain(settingsKey);

    // Default-disabled: listed, but not enabled until the workspace enables the server.
    const attached = attachPluginViewServers(views, servers, {});
    expect(attached.map((entry) => [entry.serverName, entry.enabled])).toEqual([
      ["settings", false],
    ]);
    expect(
      attachPluginViewServers(views, servers, { enabledServers: [settingsKey] })[0]?.enabled
    ).toBe(true);
    expect(
      attachPluginViewServers(views, servers, {
        enabledServers: [settingsKey],
        disabledServers: [settingsKey],
      })[0]?.enabled
    ).toBe(true);
  });

  test("an untrusted project contributes no views", async () => {
    using tmp = new DisposableTempDir("plugin-views-untrusted");
    const checkout = path.join(tmp.path, "checkout");
    await writePlugin(
      path.join(checkout, ".xum", "plugins", "review-bot"),
      "review-bot",
      [view("settings", "settings")],
      ["settings"]
    );
    const views = await discoverPluginViews({
      xumHome: path.join(tmp.path, "home"),
      projectTrusted: false,
      context: { projectRoot: checkout, projectKey: checkout },
    });
    expect(views.some((entry) => entry.pluginName === "review-bot")).toBe(false);
  });

  test("a server key that is not a plugin server never binds a view", () => {
    const entries = attachPluginViewServers(
      [
        {
          pluginViewId: "0123456789abcdef/settings",
          pluginName: "p",
          title: "Settings",
          serverName: "settings",
          serverKey: "plugin:0123456789abcdef:settings",
          resourceUri: "ui://p/settings",
        },
      ],
      {
        "plugin:0123456789abcdef:settings": {
          transport: "stdio",
          command: "node",
          disabled: false,
        },
      },
      {}
    );
    expect(entries).toEqual([]);
  });
});
