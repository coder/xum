/**
 * e2e (TesterArmy) config for the story suite: user stories that an agent drives through the
 * Xum UI (`agent.act`, `agent.assert`), with exact checks on the outcome. Run it with
 * `make test-stories`.
 *
 * Paused on the host (hostPause.ts, #5714): a model picks the actions, so every e2e command with
 * this config, also `run`, refuses as it loads, except inside the bug-bash sandbox with a provider
 * proxy for the job. There the one agent gets BUGBASH_MODEL through that proxy, and the app AI
 * stays the mock. The app, its seed and the env it gets come from ../bugbash/e2e.config.ts.
 */
// First import: the pause refuses before ../bugbash/e2e.config.ts runs (hostPause.ts).
import "./hostPause";
import type { E2EConfig } from "e2e";
import base from "../bugbash/e2e.config";
import { judge, model, storyCache, storyContext } from "./storyConfig";

const [web] = base.targets;
if (web.name !== "web") throw new Error(`the bug-bash config's first target is ${web.name}`);

export default {
  ...base,
  // The stories; e2e makes this config's folder (tests/stories) the project root. The Electron
  // stories run in a job of their own (e2e.electron.config.ts).
  tests: ["**/*.e2e.ts", "!electron/**/*.e2e.ts"],
  targets: [
    {
      ...web,
      app: {
        ...web.app,
        command: {
          ...web.app.command,
          // startApp.ts lives in tests/bugbash. A path, not a cwd: the app log path
          // (BUGBASH_APP_LOG) stays relative to this folder, so it comes back with the output.
          args: ["../bugbash/startApp.ts", "--port", "{port}"],
          // e2e gives the app only `command.env`, and this config loads only in a model-driven
          // sandbox job (hostPause.ts). Without this marker startApp.ts would leave agent tools,
          // terminals and project automation on while the agent drives the app (S3).
          env: { ...web.app.command.env, BUGBASH_MODEL_DRIVEN: "1" },
        },
      },
    },
  ],
  retries: 0,
  // Serial: every story shares one seeded app.
  workers: 1,
  agents: { default: { ...base.agents.default, model, judge, context: storyContext() } },
  ...storyCache(),
} satisfies E2EConfig;
