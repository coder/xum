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

/**
 * Points the runtime user's global roots at an empty folder: HOME (~/.agents/skills), XUM_ROOT
 * (the Xum home) and os.homedir() (~/.agents/plugins; Bun's os.homedir() ignores a HOME change).
 * A test that discovers skills, agents, workflows or plugins otherwise also reads whatever the
 * host has installed, and each installed skill adds shell containment probes.
 *
 * Call it from beforeAll and call restore from afterAll. It changes process-wide state, so it
 * cannot nest.
 */
export function isolateHostHome(prefix: string): IsolatedHostHome {
  const home = new DisposableTempDir(prefix);
  const previousHome = process.env.HOME;
  const previousXumRoot = process.env.XUM_ROOT;
  const xumRoot = path.join(home.path, ".xum");
  process.env.HOME = home.path;
  process.env.XUM_ROOT = xumRoot;
  const homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path);
  return {
    homePath: home.path,
    xumRoot,
    restore() {
      homedirSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXumRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousXumRoot;
      home[Symbol.dispose]();
    },
  };
}
