import * as fs from "fs";
import { ensurePrivateDirSync } from "@/node/utils/fs";

type RunSessionRootEnv = Readonly<Record<string, string | undefined>>;

export function prepareRunSessionRootOverride(
  env: RunSessionRootEnv,
  realConfigRoot: string
): string | undefined {
  const envSessionRoot = (env.XUM_RUN_SESSION_ROOT ?? env.MUX_RUN_SESSION_ROOT)?.trim();
  if (!envSessionRoot) {
    return undefined;
  }

  ensurePrivateDirSync(envSessionRoot);
  if (
    fs.existsSync(realConfigRoot) &&
    fs.realpathSync(envSessionRoot) === fs.realpathSync(realConfigRoot)
  ) {
    throw new Error(
      "XUM_RUN_SESSION_ROOT / MUX_RUN_SESSION_ROOT must not resolve to the Xum config root"
    );
  }

  return envSessionRoot;
}

export function writePrivateRunConfigFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}
