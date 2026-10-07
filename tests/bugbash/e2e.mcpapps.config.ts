/**
 * The bug-bash config with the MCP Apps seed (`startApp.ts --mcp-apps`, mcpapps/seed.ts), extra
 * explorer context about it, and the MCP Apps e2e suite (mcpapps/*.e2e.ts). Everything else
 * comes from e2e.config.ts. Run it with `make mcp-apps-e2e`, or explore with
 * `make bug-bash BUGBASH_ARGS="--config tests/bugbash/e2e.mcpapps.config.ts
 * --charters tests/bugbash/mcpapps/charters.txt"`.
 *
 * Paused on the host (hostPause.ts, #5714): the suite drives every flow with `agent.act`, so a
 * model picks its actions. Every e2e command with this config, also `run`, refuses as it loads.
 */
import type { E2EConfig } from "e2e";
import base from "./e2e.config";
import { modelDrivenRefusal } from "./hostPause";

const paused = modelDrivenRefusal("the MCP Apps suite (agent.act, e2e.mcpapps.config.ts)");
if (paused != null) throw new Error(paused);

const mcpContext = [
  "MCP Apps setup for this run: the 'Bug bash playground' chat already holds MCP tool calls from",
  "the 'demo-app' server (mcp-app-prototype). 'demo_app_show_dice_board' calls declare an",
  "interactive view: expanding such a tool card shows the view inline, and a 'Show input/output'",
  "toggle under it shows the raw JSON. 'Open in Artifacts' opens the same view in the Artifacts",
  "tab, whose picker lists it under 'App views'. The 4d6 call kept its result; the 2d20 call's",
  "result record is missing on purpose, so its view says the result is no longer available; the",
  "50d6 call failed; 'demo_app_get_server_time' has no view. View buttons: Re-roll (no prompt),",
  "Server time (asks for consent), Put result in composer (asks), Open MCP Apps spec (asks,",
  "opens an external link). Only the dice view is interactive; it runs in a sandboxed frame.",
  "Interaction state inside a view (a re-roll) is not shared between the card and Artifacts.",
  "Tutorial popovers can cover controls: dismiss them with Skip.",
].join(" ");

const agents = Object.fromEntries(
  Object.entries(base.agents).map(([name, agent]) => [
    name,
    { ...agent, context: `${agent.context} ${mcpContext}` },
  ])
) as typeof base.agents;

const targets = base.targets.map((target) => ({
  ...target,
  app: {
    ...target.app,
    command: {
      ...target.app.command,
      args: ["startApp.ts", "--port", "{port}", "--mcp-apps"],
    },
  },
})) as typeof base.targets;

export default {
  ...base,
  // The MCP Apps suite; `e2e explore` charters ignore this glob.
  tests: "mcpapps/**/*.e2e.ts",
  // Serial: every test shares one seeded app. In one run with 4 workers a view's re-roll
  // (tools/call) never answered while the same click works alone; the cause is not known.
  workers: 1,
  agents,
  targets,
} satisfies E2EConfig;
