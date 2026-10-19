/**
 * e2e (TesterArmy) config for the Electron stories (tests/stories/electron): user stories of
 * what only Xum Electron has, which an agent drives (`agent.act`, `agent.assert`), with exact
 * checks on the outcome. `make test-stories` runs it as a sandbox job of its own, beside the web
 * stories (e2e.config.ts), with its own deadline, budget and output folder (stories-electron-*).
 *
 * Paused on the host like the web stories (hostPause.ts, #5714). In the sandbox job, entry.ts
 * starts Xvfb (BUGBASH_ELECTRON=1) and the target's app is `startApp.ts --electron`: it seeds
 * XUM_ROOT, writes the control file (../bugbash/appControl.ts) and serves the built renderer on
 * the app URL's port. The browser provider (electronProvider.ts) then starts one Xum Electron per
 * attempt on that root, with an allowlisted env: the mock AI, and agent tools, terminals and
 * project automation off.
 */
// First import: the pause refuses before ../bugbash/e2e.config.ts runs (hostPause.ts).
import "./hostPause";
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import base from "../bugbash/e2e.config";
import { xumElectron } from "./electronProvider";
import { model, storyCache, storyContext } from "./storyConfig";

const [webTarget] = base.targets;
if (webTarget.name !== "web")
  throw new Error(`the bug-bash config's first target is ${webTarget.name}`);
const command = webTarget.app.command;

export default {
  ...base,
  // e2e makes this config's folder (tests/stories) the project root.
  tests: "electron/**/*.e2e.ts",
  targets: [
    {
      name: "electron",
      // The window size is Electron's own, on the Xvfb screen (entry.ts).
      engine: web({ browser: xumElectron() }),
      app: {
        // A free port: e2e polls it, and startApp.ts serves the renderer on it once seeded.
        url: "http://127.0.0.1:0",
        command: {
          ...command,
          args: ["../bugbash/startApp.ts", "--port", "{port}", "--electron"],
          // As in e2e.config.ts: without the marker, startApp.ts would hand Electron no kill
          // switch, and the provider refuses to start it (electronEnvRefusal).
          env: { ...command.env, BUGBASH_MODEL_DRIVEN: "1" },
        },
      },
    },
  ],
  retries: 0,
  // Serial: every story shares one seeded root, and Electron holds a single-instance lock on it.
  workers: 1,
  agents: {
    default: {
      ...base.agents.default,
      model,
      context: storyContext("Here it runs as the desktop app, in its own window."),
    },
  },
  ...storyCache(),
} satisfies E2EConfig;
