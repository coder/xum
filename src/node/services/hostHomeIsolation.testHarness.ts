import * as os from "node:os";
import * as path from "node:path";
import { spyOn } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";

export interface IsolatedHostHome {
  /** The empty folder that HOME and os.homedir() name. */
  readonly homePath: string;
  /** XUM_ROOT: the Xum home inside homePath. */
  readonly xumRoot: string;
  restore(): void;
}

// Windows expands "~" from USERPROFILE and every other platform from HOME.
const HOME_ENV_NAMES = ["HOME", "USERPROFILE"] as const;

/**
 * Points the runtime user's global roots at an empty folder: HOME or USERPROFILE (~/.agents/skills),
 * XUM_ROOT (the Xum home) and os.homedir() (~/.agents/plugins; Bun's os.homedir() ignores a HOME
 * change). A test that discovers skills, agents, workflows or plugins otherwise also reads whatever
 * the host has installed, and each installed skill adds shell containment probes.
 *
 * Call it from beforeAll and call restore from afterAll. It changes process-wide state, so it
 * cannot nest.
 */
export function isolateHostHome(prefix: string): IsolatedHostHome {
  const home = new DisposableTempDir(prefix);
  const xumRoot = path.join(home.path, ".xum");
  const previous = new Map<string, string | undefined>(
    [...HOME_ENV_NAMES, "XUM_ROOT"].map((name) => [name, process.env[name]])
  );
  for (const name of HOME_ENV_NAMES) process.env[name] = home.path;
  process.env.XUM_ROOT = xumRoot;
  const homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path);
  return {
    homePath: home.path,
    xumRoot,
    restore() {
      homedirSpy.mockRestore();
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      home[Symbol.dispose]();
    },
  };
}
