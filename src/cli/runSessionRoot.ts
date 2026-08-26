import * as fs from "node:fs/promises";
import { ensurePrivateDir } from "@/node/utils/fs";

type RunSessionRootEnv = Readonly<Record<string, string | undefined>>;

export async function prepareRunSessionRootOverride(
  env: RunSessionRootEnv,
  realConfigRoot: string
): Promise<string | undefined> {
  const envSessionRoot = (env.XUM_RUN_SESSION_ROOT ?? env.MUX_RUN_SESSION_ROOT)?.trim();
  if (!envSessionRoot) {
    return undefined;
  }

  await ensurePrivateDir(envSessionRoot);
  // A missing real config root cannot be aliased; ignore ENOENT from realpath.
  const realConfigRootCanonical = await fs.realpath(realConfigRoot).catch(() => undefined);
  if (
    realConfigRootCanonical !== undefined &&
    (await fs.realpath(envSessionRoot)) === realConfigRootCanonical
  ) {
    throw new Error(
      "XUM_RUN_SESSION_ROOT / MUX_RUN_SESSION_ROOT must not resolve to the Xum config root"
    );
  }

  return envSessionRoot;
}

export async function writePrivateRunConfigFile(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: 0o600 });
}
