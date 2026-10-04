import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { isErrnoWithCode } from "@/node/utils/fs";
import { fsyncParentDirectory } from "@/node/utils/writeFileAtomic";

/**
 * This installation's identity: a random UUID under its data root (XUM_ROOT), which names its
 * remote plan namespace on shared SSH hosts (#5174). Two installations that use one SSH host
 * would otherwise keep their plans in one ~/.mux/plans tree, where neither one's guards can see
 * the other's workspaces.
 *
 * Deliberately separate from telemetry_id (absent while telemetry is off) and from machine ids
 * or root-path hashes (two data roots on one machine are two installations). Contract: one data
 * root per identity. A moved root keeps it; a copy that stays usable next to the original must
 * get a fresh one before it accesses remote plans (docs/agents/plan-mode.mdx). The migration
 * flag and lock are local to a root, so two roots with one identity can restore each other's
 * cleared plans (formal/plan-storage MC_mig_boundary_shared_uuid). Xum does not detect copies:
 * path or host fingerprints would misclassify moves.
 */
export const INSTALLATION_ID_FILE = "installation_id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The identity file exists but is not a UUID, or cannot be read. Never replaced by a fresh one:
 * a new identity would orphan every remote plan of this installation, so remote plan writes and
 * deletes refuse until the user repairs or removes the file.
 */
export class InstallationIdentityError extends Error {
  constructor(
    readonly filePath: string,
    detail: string
  ) {
    super(
      `This Xum installation's identity file ${filePath} is unusable (${detail}). ` +
        "Remote plan files on SSH hosts are keyed by it, so Xum will not read, write or delete " +
        "them until it is fixed: restore the file from a backup, or delete it to start a new " +
        "identity (plans written under the old identity stay on the hosts but are no longer used)."
    );
    this.name = "InstallationIdentityError";
  }
}

async function readInstallationId(filePath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return undefined;
    throw new InstallationIdentityError(
      filePath,
      error instanceof Error ? error.message : String(error)
    );
  }
  const id = raw.trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw new InstallationIdentityError(filePath, "its content is not a UUID");
  }
  return id;
}

/**
 * Load the installation identity under `rootDir`, creating it on first use. Backends sharing one
 * root all end with the same UUID: the file only ever appears complete (written to a private temp
 * file, then hard-linked into place, which fails if another backend's link won), and every caller
 * returns what it reads back from the final path.
 */
export async function loadOrCreateInstallationId(rootDir: string): Promise<string> {
  // Read on every call, never cached: a file the user deleted or restored (the documented
  // recovery) takes effect at once, so backends sharing the root never use two identities.
  const filePath = path.join(rootDir, INSTALLATION_ID_FILE);
  let id = await readInstallationId(filePath);
  if (id === undefined) {
    await fs.mkdir(rootDir, { recursive: true });
    const tempPath = path.join(rootDir, `.${INSTALLATION_ID_FILE}.${randomUUID()}.tmp`);
    // Flushed before it is published, and the directory entry after: a crash right after this
    // returns must not leave an empty or missing file, which would mint a new identity and
    // orphan every remote plan written under this one.
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${randomUUID()}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(tempPath, filePath);
    } catch (error) {
      // Another backend created it first: its identity wins (read back below).
      if (!isErrnoWithCode(error, "EEXIST")) {
        throw new InstallationIdentityError(
          filePath,
          `could not create it: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      await fs.rm(tempPath, { force: true });
    }
    await fsyncParentDirectory(filePath);
    id = await readInstallationId(filePath);
    if (id === undefined) {
      throw new InstallationIdentityError(filePath, "it vanished right after it was created");
    }
  }
  return id;
}
