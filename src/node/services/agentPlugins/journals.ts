/**
 * Shared crash-recovery journal vocabulary for managed Agent Plugin installs.
 *
 * AgentPluginInstallService writes a journal file into the staging root
 * (`<muxHome>/plugin-staging`, a SIBLING of the managed `plugins` container)
 * before every directory move of an install/update/uninstall, and consumes it
 * only when the mutation's cleanup fully lands. A surviving journal therefore
 * means the managed container may hold unreconciled state (an orphaned
 * promotion, a half-swapped update, a staged-away uninstall).
 *
 * This lives outside installService.ts so discovery.ts can derive
 * journal-based suppression for processes that never construct the install
 * service (headless `mux workflow` resolving plugin:// scripts) without an
 * import cycle: installService imports discovery for container scans.
 */
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { nodeHostFiles } from "@/node/services/hostFiles/nodeHostFiles";

/** Staging dir name under the mux home dir — NOT under ~/.mux/plugins, which discovery scans. */
export const STAGING_DIR_NAME = "plugin-staging";

/** Shared by installer transactions and MCP's final component-policy admission. */
export const MUTATION_LOCK_FILE = "mutation.lock";
/** Renewal cadence for pre-#4415 builds (they reclaim by age); never a takeover threshold. */
const MUTATION_LOCK_STALE_MS = 30 * 60 * 1000;

export function acquirePluginMutationLock(
  rootDir: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<() => Promise<void>> {
  return acquireCrossProcessLock({
    lockPath: path.join(rootDir, STAGING_DIR_NAME, MUTATION_LOCK_FILE),
    acquireTimeoutMs: options.timeoutMs,
    staleMs: MUTATION_LOCK_STALE_MS,
    signal: options.signal,
    timeoutMessage:
      "Another Mux process is currently modifying plugins. Wait for it to finish and try again.",
  });
}

/**
 * Mutation-epoch handshake file in the staging root. The install service
 * rewrites it with a fresh random token immediately BEFORE deleting any
 * journal, so a mutation whose entire journal lifetime (create → consume)
 * fits between a scanner's two journal checks still leaves a visible trace:
 * the journal file alone cannot betray a transaction that finished before
 * the post-scan check. Bump-before-delete makes "journal gone" imply "epoch
 * already changed" for any mutation that ran during the scan window.
 */
export const MUTATION_EPOCH_FILE = "mutation-epoch";

/**
 * Stable sentinel returned when the mutation epoch exists but cannot be read
 * (non-ENOENT failure). Stable identity prevents sweep-per-serve consumers
 * from manufacturing perpetual mutation changes; consumers fail closed for
 * plugin content explicitly via isMutationEpochUnreadable.
 */
export const MUTATION_EPOCH_UNREADABLE_TOKEN = "xum-plugin-epoch-unreadable";

export function isMutationEpochUnreadable(token: string | undefined): boolean {
  return token === MUTATION_EPOCH_UNREADABLE_TOKEN;
}

export const PROMOTION_JOURNAL_PREFIX = "promotion-";
export const UPDATE_JOURNAL_PREFIX = "update-";
export const UNINSTALL_JOURNAL_PREFIX = "uninstall-";

export const JOURNAL_PREFIXES = [
  PROMOTION_JOURNAL_PREFIX,
  UPDATE_JOURNAL_PREFIX,
  UNINSTALL_JOURNAL_PREFIX,
] as const;

export function isJournalName(entry: string): boolean {
  return JOURNAL_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

/**
 * Whether the staging root SIBLING of the given container holds any recovery
 * journals. Fail-closed: an unreadable staging root (non-ENOENT) reports
 * true, because "cannot tell" must not release discovery over a container
 * that may hold unreconciled trees.
 */
export async function containerHasUnreconciledJournals(containerPath: string): Promise<boolean> {
  const stagingRoot = path.join(path.dirname(containerPath), STAGING_DIR_NAME);
  try {
    return (await nodeHostFiles.promises.readdir(stagingRoot)).some(
      (entry) => isJournalName(entry) && entry.endsWith(".json")
    );
  } catch (error) {
    // hasErrorCode, not `instanceof Error`: under babel-jest's vm sandbox,
    // fs errors come from another realm and fail instanceof, which would
    // misreport every missing staging root as "has journals".
    return !hasErrorCode(error, "ENOENT");
  }
}

/**
 * Snapshot of a container's mutation-visibility state, read twice by the
 * discovery gate (before and after a container scan) to detect mutations
 * that overlap the scan.
 */
export interface ContainerMutationState {
  /**
   * Recovery journals, or a pending post-update sign-out (#6122). Fail-closed: an unreadable
   * staging root or record reports true.
   */
  hasJournals: boolean;
  /**
   * Epoch token; `undefined` when the epoch file has never been written (a
   * stable state). An unreadable epoch file yields the stable
   * MUTATION_EPOCH_UNREADABLE_TOKEN; discovery suppresses that state
   * explicitly rather than relying on manufactured token changes.
   */
  epoch: string | undefined;
}

/**
 * Read the current mutation epoch token; `undefined` when never written. An
 * unreadable file yields a stable failure sentinel: discovery and MCP serving
 * suppress plugin content explicitly while unrelated MCP servers remain
 * usable. Also consumed by MCPServerManager as its cross-process plugin
 * invalidation signal: a sibling process's install/update/uninstall bumps
 * this token, telling every manager to retire cached plugin server instances
 * before serving them again.
 */
export async function readMutationEpochToken(stagingRoot: string): Promise<string | undefined> {
  try {
    return await nodeHostFiles.promises.readFile(path.join(stagingRoot, MUTATION_EPOCH_FILE), "utf-8");
  } catch (error) {
    // hasErrorCode, not `instanceof Error`: under babel-jest's vm sandbox,
    // fs errors come from another realm and fail instanceof — every missing
    // epoch file would otherwise be misclassified as unreadable, suppressing
    // plugin content even though no epoch file was ever written.
    return hasErrorCode(error, "ENOENT") ? undefined : MUTATION_EPOCH_UNREADABLE_TOKEN;
  }
}

export async function readContainerMutationState(
  containerPath: string
): Promise<ContainerMutationState> {
  const stagingRoot = path.join(path.dirname(containerPath), STAGING_DIR_NAME);
  const hasJournals = (
    await Promise.all([
      containerHasUnreconciledJournals(containerPath),
      containerHasPendingSignOuts(containerPath),
    ])
  ).includes(true);
  return { hasJournals, epoch: await readMutationEpochToken(stagingRoot) };
}

/**
 * Credential URLs that plugin updates still have to sign out (#6122), next to the container.
 * While the record exists, every discovery gate (also headless processes that never build the
 * install service) keeps the managed container closed: a plugin server must not connect with
 * its old sign-in's tokens.
 */
export const PENDING_SIGN_OUTS_FILE_NAME = "plugin-sign-outs-pending.json";

/** One stat. Fail-closed: a record that cannot be stat'ed counts as pending. */
export async function containerHasPendingSignOuts(containerPath: string): Promise<boolean> {
  try {
    await nodeHostFiles.promises.stat(pendingSignOutsPath(containerPath));
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

function pendingSignOutsPath(containerPath: string): string {
  return path.join(path.dirname(containerPath), PENDING_SIGN_OUTS_FILE_NAME);
}

/**
 * The record's state for a diagnostic (#6627). It reads the file, because a record that can be
 * stat'ed but not read (a directory, missing read permission) still fails every sign-out pass.
 */
export async function pendingSignOutsRecordState(
  containerPath: string
): Promise<{ kind: "absent" } | { kind: "present" } | { kind: "unreadable"; code: string }> {
  try {
    // Not a regular file (a FIFO would block readFile): unreadable, without reading it.
    if (!(await nodeHostFiles.promises.stat(pendingSignOutsPath(containerPath))).isFile())
      return { kind: "unreadable", code: "not a regular file" };
    await nodeHostFiles.promises.readFile(pendingSignOutsPath(containerPath));
    return { kind: "present" };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { kind: "absent" };
    // fs errors come from another realm under the Jest VM: read `code` without instanceof.
    const code: unknown =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return { kind: "unreadable", code: typeof code === "string" ? code : "unknown error" };
  }
}

/**
 * Rewrite the epoch file with a fresh random token. MUST be awaited before
 * deleting a journal (see MUTATION_EPOCH_FILE); a failure must be treated as
 * a failed journal consumption (keep the journal) or the finished-inside-the-
 * scan-window race reopens. Written atomically via temp + rename so a
 * concurrent scanner can never observe a torn token that happens to match
 * its earlier read.
 */
export async function bumpContainerMutationEpoch(stagingRoot: string): Promise<void> {
  const token = randomUUID();
  const tempPath = path.join(stagingRoot, `.${MUTATION_EPOCH_FILE}-${token}.tmp`);
  await nodeHostFiles.promises.writeFile(tempPath, token, "utf-8");
  try {
    await nodeHostFiles.promises.rename(tempPath, path.join(stagingRoot, MUTATION_EPOCH_FILE));
  } catch (error) {
    await nodeHostFiles.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
