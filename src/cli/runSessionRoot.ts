import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { isErrnoWithCode } from "@/node/utils/fs";

type RunSessionRootEnv = Readonly<Record<string, string | undefined>>;

export class PreparedRunSessionRoot implements AsyncDisposable {
  constructor(
    readonly path: string,
    readonly canonicalPath: string,
    private readonly handle: fs.FileHandle | undefined,
    private readonly device: number,
    private readonly inode: number
  ) {}

  async resolveConfigFilePath(filePath: string): Promise<string> {
    if (path.resolve(path.dirname(filePath)) !== path.resolve(this.path)) {
      throw new Error(`Run config file must be inside the secured session root: ${filePath}`);
    }

    // The proc fd path stays attached to the opened directory inode even if its original
    // pathname is replaced before credential files are written.
    if (process.platform === "linux" && this.handle !== undefined) {
      return path.join("/proc/self/fd", String(this.handle.fd), path.basename(filePath));
    }

    if (process.platform === "win32") {
      const current = await fs.lstat(this.path);
      if (current.isSymbolicLink() || current.dev !== this.device || current.ino !== this.inode) {
        throw new Error(`Run session root was replaced before writing config: ${this.path}`);
      }
      return filePath;
    }

    const currentHandle = await fs.open(
      this.path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const current = await currentHandle.stat();
      if (!current.isDirectory() || current.dev !== this.device || current.ino !== this.inode) {
        throw new Error(`Run session root was replaced before writing config: ${this.path}`);
      }
    } finally {
      await currentHandle.close();
    }
    return filePath;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.handle?.close();
  }
}

function assertDirectoryNotSymlinked(
  rootPath: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Run session root must be a real directory: ${rootPath}`);
  }
}

async function hardenRunSessionRoot(rootPath: string): Promise<PreparedRunSessionRoot> {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const created = await fs.lstat(rootPath);
  assertDirectoryNotSymlinked(rootPath, created);

  if (process.platform === "win32") {
    await fs.chmod(rootPath, 0o700);
    return new PreparedRunSessionRoot(
      rootPath,
      await fs.realpath(rootPath),
      undefined,
      created.dev,
      created.ino
    );
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
    return new PreparedRunSessionRoot(rootPath, canonical, handle, opened.dev, opened.ino);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function prepareRunSessionRootOverride(
  env: RunSessionRootEnv,
  realConfigRoot: string
): Promise<PreparedRunSessionRoot | undefined> {
  const envSessionRoot = (env.XUM_RUN_SESSION_ROOT ?? env.MUX_RUN_SESSION_ROOT)?.trim();
  if (!envSessionRoot) {
    return undefined;
  }

  const preparedRoot = await hardenRunSessionRoot(envSessionRoot);
  // A missing real config root cannot be aliased; ignore ENOENT from realpath.
  const realConfigRootCanonical = await fs.realpath(realConfigRoot).catch(() => undefined);
  if (
    realConfigRootCanonical !== undefined &&
    preparedRoot.canonicalPath === realConfigRootCanonical
  ) {
    await preparedRoot[Symbol.asyncDispose]();
    throw new Error(
      "XUM_RUN_SESSION_ROOT / MUX_RUN_SESSION_ROOT must not resolve to the Xum config root"
    );
  }

  return preparedRoot;
}

export async function replacePrivateRunConfigFile(
  filePath: string,
  contents: string | undefined,
  preparedRoot?: PreparedRunSessionRoot
): Promise<void> {
  const resolvedFilePath =
    preparedRoot === undefined ? filePath : await preparedRoot.resolveConfigFilePath(filePath);
  const existing = await fs.lstat(resolvedFilePath).catch((error: unknown) => {
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
    await fs.unlink(resolvedFilePath);
  }

  if (contents === undefined) {
    return;
  }

  const handle = await fs.open(
    resolvedFilePath,
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
