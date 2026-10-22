/**
 * #6426: a PluginFs over a remote checkout's listing held in memory, so discovery and the plugin
 * readers apply their unchanged rules without host files. Paths are POSIX paths of the remote
 * host. Symlinks resolve inside the listing only: a link whose target is outside the listing's
 * root, or was not resolvable remotely, behaves like a missing path (ENOENT), so it can never
 * reach outside the checkout.
 */
import * as path from "node:path";
import assert from "@/common/utils/assert";
import {
  PluginGitPathError,
  type PluginFileReadArgs,
  type PluginFileReadResult,
  type PluginFs,
  type PluginFsDirent,
  type PluginFsStat,
} from "./discovery";

export type MemoryNode =
  | { kind: "dir" }
  | { kind: "file"; bytes: Buffer }
  /** `target`: the remote realpath of the link, or null when it is outside the root or dangling. */
  | { kind: "symlink"; target: string | null };

/** Same bound as Linux (MAXSYMLINKS) on symlink hops in one resolution. */
const MAX_SYMLINK_HOPS = 40;

/**
 * An absolute, normalized POSIX path other than "/": no `.`, `..` or empty segment, and no NUL,
 * tab or newline (the listing's separators).
 */
export function isCanonicalRemotePath(remote: string): boolean {
  return (
    remote.startsWith("/") &&
    remote !== "/" &&
    !remote.endsWith("/") &&
    !/[\0\t\n]/.test(remote) &&
    path.posix.normalize(remote) === remote
  );
}

export function isInsideRoot(root: string, remote: string): boolean {
  return remote === root || remote.startsWith(root + "/");
}

function fsError(code: string, remote: string): Error {
  return Object.assign(new Error(`${code}: ${remote}`), { code });
}

function statOf(node: MemoryNode): PluginFsStat {
  return {
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => node.kind === "symlink",
    size: node.kind === "file" ? node.bytes.length : 0,
  };
}

/** Like node:fs/promises, a failure rejects; it never throws synchronously. */
function later<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}

function splitPath(remote: string): string[] {
  return remote.split("/").filter((name) => name !== "" && name !== ".");
}

function childPath(current: string, name: string): string {
  return name === ".." ? path.posix.dirname(current) : path.posix.join(current, name);
}

/** True when resolution must follow `node`: a symlink that is not the leaf of an lstat. */
function followsLink(
  node: MemoryNode,
  isLeaf: boolean,
  followLeaf: boolean
): node is Extract<MemoryNode, { kind: "symlink" }> {
  return node.kind === "symlink" && (!isLeaf || followLeaf);
}

function hasCode(error: unknown, code: string): boolean {
  return (error as { code?: string } | null)?.code === code;
}

/**
 * The PluginFs of `nodes` (remote path -> node; every ancestor of a node must be a "dir" node,
 * except "/"). `root` is the checkout root; `modifiedTime` is reported for every file.
 */
class MemoryPluginFs implements PluginFs {
  private readonly children = new Map<string, string[]>();

  constructor(
    private readonly nodes: ReadonlyMap<string, MemoryNode>,
    private readonly root: string,
    private readonly modifiedTime: Date
  ) {
    for (const remote of nodes.keys()) {
      const parent = path.posix.dirname(remote);
      assert(parent === "/" || nodes.get(parent)?.kind === "dir", `memory fs: no parent ${remote}`);
      const siblings = this.children.get(parent) ?? [];
      siblings.push(path.posix.basename(remote));
      this.children.set(parent, siblings);
    }
  }

  private nodeOf(remote: string): MemoryNode {
    const node = remote === "/" ? { kind: "dir" as const } : this.nodes.get(remote);
    if (node === undefined) throw fsError("ENOENT", remote);
    return node;
  }

  /** A link's target; a link outside the root or unresolvable remotely is missing. */
  private linkTarget(node: { target: string | null }, remote: string): string {
    if (node.target === null || !isInsideRoot(this.root, node.target)) {
      throw fsError("ENOENT", remote);
    }
    return node.target;
  }

  /** The realpath of `remote`; with `followLeaf` false, a final symlink is not followed. */
  private resolve(remote: string, followLeaf = true): string {
    if (!remote.startsWith("/")) throw fsError("ENOENT", remote);
    const pending = splitPath(remote);
    let current = "/";
    let hops = 0;
    for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
      const next = childPath(current, name);
      const node = this.nodeOf(next);
      if (followsLink(node, pending.length === 0, followLeaf)) {
        if (++hops > MAX_SYMLINK_HOPS) throw fsError("ELOOP", remote);
        pending.unshift(...splitPath(this.linkTarget(node, remote)));
        current = "/";
      } else if (pending.length > 0 && node.kind !== "dir") {
        throw fsError("ENOTDIR", remote);
      } else {
        current = next;
      }
    }
    return current;
  }

  /** resolveRealPathAllowMissing: the realpath of the longest existing prefix, plus the rest. */
  private resolveAllowMissing(remote: string): string {
    const missing: string[] = [];
    for (let current = remote; ; current = path.posix.dirname(current)) {
      try {
        return path.posix.join(this.resolve(current), ...missing);
      } catch (error) {
        if (!hasCode(error, "ENOENT") || current === "/") throw error;
        missing.unshift(path.posix.basename(current));
      }
    }
  }

  realpath(remote: string): Promise<string> {
    return later(() => this.resolve(remote));
  }

  stat(remote: string): Promise<PluginFsStat> {
    return later(() => statOf(this.nodeOf(this.resolve(remote))));
  }

  lstat(remote: string): Promise<PluginFsStat> {
    return later(() => statOf(this.nodeOf(this.resolve(remote, false))));
  }

  readdir(dir: string): Promise<PluginFsDirent[]> {
    return later(() => {
      const real = this.resolve(dir);
      if (this.nodeOf(real).kind !== "dir") throw fsError("ENOTDIR", dir);
      return (this.children.get(real) ?? []).map((name) => ({
        name,
        ...statOf(this.nodeOf(path.posix.join(real, name))),
      }));
    });
  }

  ensureContained(
    containmentRoot: string,
    candidate: string,
    options?: { allowMissing?: boolean }
  ): Promise<string> {
    return later(() => {
      const rootReal = this.resolve(containmentRoot);
      const candidateReal =
        options?.allowMissing === true
          ? this.resolveAllowMissing(candidate)
          : this.resolve(candidate);
      if (!isInsideRoot(rootReal, candidateReal)) {
        throw new Error("Path resolves outside containment root after symlink resolution.");
      }
      return candidateReal;
    });
  }

  /** readPluginFileWithinRootCapped's rules; a snapshot cannot change, so no identity recheck. */
  readFileCapped(args: PluginFileReadArgs): Promise<PluginFileReadResult> {
    const { filePath, pluginRoot, maxBytes, label } = args;
    return later(() => {
      const real = this.resolve(filePath);
      const node = this.nodeOf(real);
      if (node.kind !== "file") throw new Error(`${label} is not a regular file: ${filePath}`);
      if (this.resolve(pluginRoot) !== pluginRoot) {
        throw new Error(`${label} cannot be read: the plugin root is not canonical: ${pluginRoot}`);
      }
      if (!isInsideRoot(pluginRoot, real)) {
        throw new Error("Path resolves outside containment root after symlink resolution.");
      }
      if (path.posix.relative(pluginRoot, real).split("/")[0].toLowerCase() === ".git") {
        throw new PluginGitPathError();
      }
      if (node.bytes.length > maxBytes) {
        throw new Error(`${label} is too large (${node.bytes.length} bytes; max ${maxBytes})`);
      }
      // A view of the snapshot's bytes, not a copy.
      const bytes = node.bytes;
      return {
        content: bytes.toString("utf8"),
        bytes,
        byteSize: bytes.length,
        modifiedTime: this.modifiedTime,
      };
    });
  }
}

export function createMemoryPluginFs(
  nodes: ReadonlyMap<string, MemoryNode>,
  root: string,
  modifiedTime: Date
): PluginFs {
  return new MemoryPluginFs(nodes, root, modifiedTime);
}
