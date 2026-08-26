import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isErrnoWithCode } from "@/node/utils/fs";

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

export async function replacePrivateRunConfigFile(
  filePath: string,
  contents: string | undefined
): Promise<void> {
  const existing = await fs.lstat(filePath).catch((error: unknown) => {
    if (isErrnoWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Run config file must not be a symbolic link: ${filePath}`);
  }
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new Error(`Run config path must be a regular file: ${filePath}`);
    }
    // Recreate instead of truncating so hard links are severed. O_EXCL below makes a raced
    // replacement fail closed instead of following it.
    await fs.unlink(filePath);
  }

  if (contents === undefined) {
    return;
  }

  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`Run config path must be a regular file: ${filePath}`);
    }
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}
