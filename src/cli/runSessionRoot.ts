import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

type RunSessionRootEnv = Readonly<Record<string, string | undefined>>;

function assertDirectoryNotSymlinked(
  rootPath: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Run session root must be a real directory: ${rootPath}`);
  }
}

async function hardenRunSessionRoot(rootPath: string): Promise<string> {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const created = await fs.lstat(rootPath);
  assertDirectoryNotSymlinked(rootPath, created);

  if (process.platform === "win32") {
    await fs.chmod(rootPath, 0o700);
    return fs.realpath(rootPath);
  }

  const handle = await fs.open(
    rootPath,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) {
      throw new Error(`Run session root must be a directory: ${rootPath}`);
    }
    await handle.chmod(0o700);
    const canonical = await fs.realpath(rootPath);
    const current = await fs.lstat(rootPath);
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`Run session root was replaced while being secured: ${rootPath}`);
    }
    return canonical;
  } finally {
    await handle.close();
  }
}

export async function prepareRunSessionRootOverride(
  env: RunSessionRootEnv,
  realConfigRoot: string
): Promise<string | undefined> {
  const envSessionRoot = (env.XUM_RUN_SESSION_ROOT ?? env.MUX_RUN_SESSION_ROOT)?.trim();
  if (!envSessionRoot) {
    return undefined;
  }

  const sessionRootCanonical = await hardenRunSessionRoot(envSessionRoot);
  // A missing real config root cannot be aliased; ignore ENOENT from realpath.
  const realConfigRootCanonical = await fs.realpath(realConfigRoot).catch(() => undefined);
  if (realConfigRootCanonical !== undefined && sessionRootCanonical === realConfigRootCanonical) {
    throw new Error(
      "XUM_RUN_SESSION_ROOT / MUX_RUN_SESSION_ROOT must not resolve to the Xum config root"
    );
  }

  return envSessionRoot;
}

export async function writePrivateRunConfigFile(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: 0o600 });
}
