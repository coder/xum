/**
 * Host files and host paths outside the session dirs, as two services (phase 5).
 *
 * HostFiles serves the file calls that agent-loop files make today on skills, plugins, agent
 * files, AGENTS.md, the config tools and the skills catalog clone. It is not SessionFiles:
 * phase 2's golden files and fs trace pin the session dirs only. HostPaths gives the three host
 * folders those callers start from. Agent-loop files may not import node:fs, node:os or
 * getXumHome (local/no-host-imports), so later PRs move them onto these services.
 *
 * Add a member only when a moved caller needs it. Type-only imports keep this module free of
 * runtime dependencies, so di/tags.ts can import it without a cycle.
 */
import type * as nodeFsPromises from "node:fs/promises";
import type { Options as WriteFileAtomicOptions } from "@/node/utils/writeFileAtomic";

export interface HostFiles {
  readonly promises: Pick<
    typeof nodeFsPromises,
    | "access"
    // constants and open: plugin discovery reads a file through one handle with O_NONBLOCK, so
    // a FIFO cannot hang it and the bytes come from the inode it checked (discovery.ts).
    | "constants"
    | "lstat"
    | "mkdir"
    | "mkdtemp"
    | "open"
    | "readdir"
    | "readFile"
    | "realpath"
    | "rename"
    | "rm"
    | "stat"
    | "unlink"
    | "writeFile"
  >;
  writeFileAtomic(
    path: string,
    data: string | Buffer,
    options?: WriteFileAtomicOptions
  ): Promise<void>;
  // Sync on purpose: configReadWrite.ts writes the providers file with writeFileAtomic.sync.
  writeFileAtomicSync(path: string, data: string | Buffer, options?: WriteFileAtomicOptions): void;
}

export interface HostPaths {
  /** The Xum home: XUM_ROOT, or ~/.xum (getXumHome). */
  xumHome(): string;
  /** The user's home folder (os.homedir). */
  userHome(): string;
  /** The temp folder (os.tmpdir). */
  tmpDir(): string;
}
