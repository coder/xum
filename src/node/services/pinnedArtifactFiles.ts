import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { PinnedArtifactFiles } from "@/common/orpc/schemas/artifacts";
import { isDevcontainerRuntime, isDockerRuntime, isSSHRuntime } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { readArtifactBytesOnRuntime, resolveRealDirOnRuntime } from "./artifactRuntimeStore";
import {
  hostSupportsDescriptorPaths,
  parseArtifactRelativePath,
  readArtifactBytesFromDir,
  toArtifactReadOutcome,
  type ArtifactReadOutcome,
} from "./artifactStore";
import {
  assertArtifactsEnabled,
  MAX_ARTIFACT_READ_BYTES,
  unreachableError,
  type ArtifactsContext,
} from "./artifactsOperations";

/**
 * Pinned workspace files (Artifacts M4, Concept C): the user can open any file in the Artifacts
 * tab. Pins are live (re-read on change, never snapshotted), stored per workspace in
 * `<sessionDir>/pinned-files.json`, and read through the same capped, symlink-refusing readers as
 * artifacts (hidden segments allowed: users pick files such as `.github/workflows/ci.yml` by hand).
 * A checkout file is stored as a POSIX path relative to the checkout, so the pin survives a
 * checkout move. A file outside the checkout (a plan, a skill or a scratch file that a tool read)
 * is stored by its absolute path on the checkout's host: file tool cards offer "Open as artifact"
 * for every path, and refusing those was a dead button.
 */

export const PINNED_FILES_FILE_NAME = "pinned-files.json";

const PinnedFilesStoreSchema = z.object({ paths: z.array(z.string()) });

const storeLocks = new MutexMap<string>();

type PinnedWorkspaceMetadata = Pick<
  FrontendWorkspaceMetadata,
  "runtimeConfig" | "projectPath" | "name" | "namedWorkspacePath"
> &
  Partial<Pick<FrontendWorkspaceMetadata, "projects" | "id">>;

/**
 * Where the checkout lives: this host's fs, or the runtime's (SSH host, Docker container).
 * `execRoot` is where tools run (the checkout, or a sub-project dir inside it).
 * `containerWritable`: a dev container writes the checkout through its bind mount, so host reads
 * must verify opened files by descriptor and never fall back to pathname checks (artifactStore).
 */
export type CheckoutLocation =
  | { kind: "host"; root: string; execRoot: string; containerWritable?: true }
  | { kind: "runtime"; runtime: Runtime; root: string; execRoot: string }
  | { kind: "unavailable"; reason: string };

export const PINNED_FILES_MULTI_PROJECT_REASON =
  "Pinned files are not available in multi-project workspaces.";

export const PINNED_FILES_DEVCONTAINER_REASON =
  "Pinned files are not available for dev container workspaces on this host.";

export const PINNED_FILES_DEVCONTAINER_OUTSIDE_REASON =
  "Dev container workspaces can pin only files inside the workspace checkout.";

const OUTSIDE_CHECKOUT_ERROR = "Only files inside the workspace checkout can be pinned";

/**
 * A stored pin outside the checkout: an absolute path (POSIX on a runtime host, native here).
 * Checkout-relative pins never match: their parser refuses a leading slash, backslashes and
 * drive letters.
 */
function isOutsidePinPath(storedPath: string): boolean {
  return (
    !storedPath.includes("\0") && (storedPath.startsWith("/") || path.win32.isAbsolute(storedPath))
  );
}

export async function resolveCheckoutLocation(
  metadata: PinnedWorkspaceMetadata,
  createRuntime: (metadata: PinnedWorkspaceMetadata) => Runtime = createRuntimeForWorkspace
): Promise<CheckoutLocation> {
  // A multi-project workspace has several checkouts; a single relative path is ambiguous there.
  if ((metadata.projects?.length ?? 0) > 1) {
    return { kind: "unavailable", reason: PINNED_FILES_MULTI_PROJECT_REASON };
  }
  const runtime = createRuntime(metadata);
  const root = resolveWorkspaceRootPath(metadata, runtime);
  const execRoot = resolveWorkspaceExecutionPath(metadata, runtime);
  if (isSSHRuntime(metadata.runtimeConfig) || isDockerRuntime(metadata.runtimeConfig)) {
    return { kind: "runtime", runtime, root, execRoot };
  }
  if (isDevcontainerRuntime(metadata.runtimeConfig)) {
    // The container can swap folders in its bind-mounted checkout while the host reads it, and
    // pathname checks can be raced from there (artifactStore). Only hosts with descriptor paths
    // (Linux) can read it safely; elsewhere pins are refused (reading inside the container would
    // need it started).
    if (!(await hostSupportsDescriptorPaths())) {
      return { kind: "unavailable", reason: PINNED_FILES_DEVCONTAINER_REASON };
    }
    return { kind: "host", root, execRoot, containerWritable: true };
  }
  // Local and worktree checkouts live on this host.
  return { kind: "host", root, execRoot };
}

/**
 * Map a user-supplied path (relative to the checkout, or absolute inside it) to the stored
 * checkout-relative POSIX path, or an error string.
 */
export function toPinnedRelativePath(root: string, inputPath: string): string | { error: string } {
  // The exact bytes: `.env ` and `.env` are different files (Review keeps edge whitespace).
  if (inputPath.trim().length === 0) return { error: "No file path given" };
  const trimmed = inputPath;
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  let relPath = trimmed.replace(/\\/g, "/");
  if (path.isAbsolute(trimmed) || trimmed.startsWith("/")) {
    const rootPosix = normalizedRoot.replace(/\\/g, "/");
    if (!relPath.startsWith(`${rootPosix}/`)) {
      return { error: OUTSIDE_CHECKOUT_ERROR };
    }
    relPath = relPath.slice(rootPosix.length + 1);
  }
  relPath = relPath.replace(/^\.\//, "");
  const segments = parseArtifactRelativePath(relPath, { allowHidden: true });
  if (typeof segments === "string") return { error: segments };
  return segments.join("/");
}

function storePath(sessionDir: string): string {
  return path.join(sessionDir, PINNED_FILES_FILE_NAME);
}

/** Read the stored pins; missing or corrupt → [] (self-healing: the next pin rewrites it). */
export async function readPinnedPaths(sessionDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(storePath(sessionDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = PinnedFilesStoreSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })()
  );
  if (!parsed.success) {
    log.warn("Ignoring corrupt pinned-files store", { sessionDir });
    return [];
  }
  // Drop entries a hand edit made invalid instead of failing every read.
  return parsed.data.paths.filter(
    (p) =>
      isOutsidePinPath(p) || typeof parseArtifactRelativePath(p, { allowHidden: true }) !== "string"
  );
}

async function updatePinnedPaths(
  sessionDir: string,
  update: (paths: string[]) => string[],
  locks: SessionLocks
): Promise<void> {
  await storeLocks.withLock(sessionDir, async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    // The in-process queue orders this backend's writers; the file lock excludes another backend
    // sharing the Xum home (a desktop app alongside `xum server`), whose update could be lost.
    const release = await locks.acquireCrossProcessLock({
      lockPath: `${storePath(sessionDir)}.lock`,
      acquireTimeoutMs: 30_000,
      staleMs: 60_000,
      timeoutMessage: "Another Xum process is updating this workspace's pinned files.",
    });
    await using _fileLock = { [Symbol.asyncDispose]: release };
    const next = update(await readPinnedPaths(sessionDir));
    await writeFileAtomic(storePath(sessionDir), JSON.stringify({ paths: next }, null, 2));
  });
}

export async function addPinnedPath(
  sessionDir: string,
  relPath: string,
  locks: SessionLocks = nodeSessionLocks
): Promise<void> {
  await updatePinnedPaths(
    sessionDir,
    (paths) => (paths.includes(relPath) ? paths : [...paths, relPath]),
    locks
  );
}

export async function removePinnedPath(
  sessionDir: string,
  relPath: string,
  locks: SessionLocks = nodeSessionLocks
): Promise<void> {
  await updatePinnedPaths(sessionDir, (paths) => paths.filter((p) => p !== relPath), locks);
}

type AvailableLocation = Exclude<CheckoutLocation, { kind: "unavailable" }>;

/** Absolute by the location's own rules: a drive-letter path is not absolute on a POSIX host. */
function isAbsoluteOn(location: AvailableLocation, filePath: string): boolean {
  return location.kind === "runtime" ? filePath.startsWith("/") : path.isAbsolute(filePath);
}

/** Real path of a folder where the checkout lives, or null when it is missing. */
async function realDirOn(location: AvailableLocation, dir: string): Promise<string | null> {
  if (location.kind === "runtime") return resolveRealDirOnRuntime(location.runtime, dir);
  return fs.realpath(dir).catch(() => null);
}

/**
 * The folder a stored pin is read from and its path below it: the checkout for a checkout pin,
 * the file's own folder for a pin outside the checkout (so the readers still refuse a symlinked
 * file, as they do in the checkout).
 */
function pinTarget(
  location: AvailableLocation,
  storedPath: string
): { root: string; relPath: string } {
  // A hand-edited entry that is not absolute here stays relative, and the readers refuse it.
  if (!isAbsoluteOn(location, storedPath)) return { root: location.root, relPath: storedPath };
  const paths = location.kind === "runtime" ? path.posix : path;
  return { root: paths.dirname(storedPath), relPath: paths.basename(storedPath) };
}

/**
 * Map a pin request to the stored path: checkout-relative inside the checkout, else the file
 * name in its folder's real path. The real path makes one file reached through a symlinked
 * folder one pin (and a checkout pin when the folder is in the checkout), and the runtime
 * readers refuse a symlinked folder. Dev containers refuse outside files: tool paths there name
 * files in the container, while pins are read on this host.
 */
async function toStoredPinPath(
  location: AvailableLocation,
  inputPath: string
): Promise<string | { error: string }> {
  if (!isAbsoluteOn(location, inputPath)) return toPinnedRelativePath(location.root, inputPath);
  const paths = location.kind === "runtime" ? path.posix : path;
  const absolute =
    location.kind === "runtime" ? paths.normalize(inputPath) : paths.resolve(inputPath);
  const relPath = toPinnedRelativePath(location.root, absolute);
  if (typeof relPath === "string" || relPath.error !== OUTSIDE_CHECKOUT_ERROR) return relPath;
  if (location.kind === "host" && location.containerWritable === true) {
    return { error: PINNED_FILES_DEVCONTAINER_OUTSIDE_REASON };
  }
  return await toRealOutsidePinPath(location, absolute);
}

/**
 * An outside file's stored path: its name in its folder's real path, or the checkout pin when
 * that real folder is in the checkout.
 */
async function toRealOutsidePinPath(
  location: AvailableLocation,
  absolute: string
): Promise<string | { error: string }> {
  const paths = location.kind === "runtime" ? path.posix : path;
  const realDir = await realDirOn(location, paths.dirname(absolute));
  if (realDir == null) return { error: `Not a readable file: ${absolute}` };
  const real = paths.join(realDir, paths.basename(absolute));
  const realRoot = await realDirOn(location, location.root);
  const inCheckout = realRoot == null ? null : toPinnedRelativePath(realRoot, real);
  return typeof inCheckout === "string" ? inCheckout : real;
}

async function statPinned(
  location: AvailableLocation,
  storedPath: string
): Promise<{ size: number; modifiedMs: number } | null> {
  const { root, relPath } = pinTarget(location, storedPath);
  try {
    if (location.kind === "host") {
      const stat = await fs.stat(path.join(root, ...relPath.split("/")));
      return stat.isFile() ? { size: stat.size, modifiedMs: stat.mtimeMs } : null;
    }
    const stat = await location.runtime.stat(`${root.replace(/\/+$/, "")}/${relPath}`);
    return stat.isDirectory ? null : { size: stat.size, modifiedMs: stat.modifiedTime.getTime() };
  } catch {
    return null;
  }
}

function sessionDirFor(context: ArtifactsContext, workspaceId: string): string {
  return path.join(context.config.sessionsDir, workspaceId);
}

async function resolveForPinned(
  context: ArtifactsContext,
  workspaceId: string
): Promise<CheckoutLocation | null> {
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata) return null;
  return resolveCheckoutLocation(metadata);
}

type Outcome<T> = { success: true; data: T } | { success: false; error: string };

export async function listPinnedFiles(
  context: ArtifactsContext,
  input: { workspaceId: string }
): Promise<Outcome<PinnedArtifactFiles>> {
  assertArtifactsEnabled(context);
  const location = await resolveForPinned(context, input.workspaceId);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") {
    return { success: true, data: { available: false, reason: location.reason } };
  }
  // The store keeps any absolute entry; list only those absolute here (a hand-edited `C:/x.md`
  // on a POSIX host would list as a pin that never reads).
  const paths = (await readPinnedPaths(sessionDirFor(context, input.workspaceId))).filter(
    (p) =>
      isAbsoluteOn(location, p) ||
      typeof parseArtifactRelativePath(p, { allowHidden: true }) !== "string"
  );
  const files = await Promise.all(
    paths.map(async (relPath) => {
      const stat = await statPinned(location, relPath);
      return {
        path: relPath,
        kind: getArtifactKind(relPath),
        size: stat?.size ?? null,
        modifiedMs: stat?.modifiedMs ?? null,
      };
    })
  );
  return { success: true, data: { available: true, files } };
}

/**
 * A relative path from a file tool names a file under the tool cwd (a sub-project dir), not the
 * checkout root: resolve it against `execRoot` before it is mapped to the stored path.
 */
function resolvePinInput(
  location: AvailableLocation,
  inputPath: string,
  relativeTo: "tool-cwd" | "checkout" | null | undefined
): string {
  // Not trimmed: edge whitespace is part of the file name (see toPinnedRelativePath).
  const trimmed = inputPath;
  if (relativeTo !== "tool-cwd" || path.isAbsolute(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }
  return location.kind === "runtime"
    ? path.posix.join(location.execRoot, trimmed.replace(/\\/g, "/"))
    : path.join(location.execRoot, trimmed);
}

/** Pinned files may be hidden, and their root is the checkout, not an `artifacts` folder. */
const PINNED_READ_OPTIONS = { allowHidden: true, requireArtifactsBasename: false } as const;

function hostReadOptions(location: Extract<CheckoutLocation, { kind: "host" }>) {
  return { ...PINNED_READ_OPTIONS, requireDescriptorPaths: location.containerWritable === true };
}

/**
 * The host checkout root as the reader should see it. The configured path is trusted and is
 * often itself a symlink (a linked project dir), which the reader's root check refuses; paths
 * below the root keep the symlink refusal. A missing root stays as is and reads as missing.
 */
async function realHostRoot(root: string): Promise<string> {
  return fs.realpath(root).catch(() => root);
}

/**
 * Null when `storedPath` is a regular file the pinned-file reader can open (same containment and
 * symlink rules as readPinnedFile), else why it cannot be pinned. A tiny cap keeps this a probe:
 * a larger file reports `too_large`, which still proves it is readable.
 */
async function checkPinnable(
  location: AvailableLocation,
  storedPath: string
): Promise<string | null> {
  const options = PINNED_READ_OPTIONS;
  const { root, relPath } = pinTarget(location, storedPath);
  const outcome =
    location.kind === "runtime"
      ? await readArtifactBytesOnRuntime(location.runtime, root, relPath, 1, undefined, options)
      : await readArtifactBytesFromDir(
          await realHostRoot(root),
          relPath,
          1,
          hostReadOptions(location)
        );
  switch (outcome.status) {
    case "ok":
    case "too_large":
      return null;
    case "missing":
      return `Not a readable file: ${storedPath}`;
    case "invalid":
      return outcome.error;
  }
}

/**
 * The stored entry that already names the file of `storedPath`, or null. An outside pin stored
 * before pins used real folder paths can hold an alias of the same file, so absolute entries
 * are compared by their real form too: re-pinning the alias must not add a second entry.
 */
async function findExistingPin(
  location: AvailableLocation,
  pinned: readonly string[],
  storedPath: string
): Promise<string | null> {
  if (pinned.includes(storedPath)) return storedPath;
  // Only an outside pin's folder is resolved, so an alias keeps the file name: resolve just the
  // entries with that name (usually none). On SSH each resolution is one exec.
  const paths = location.kind === "runtime" ? path.posix : path;
  const name = paths.basename(storedPath);
  const aliases = pinned.filter((p) => isAbsoluteOn(location, p) && paths.basename(p) === name);
  const real = await Promise.all(
    aliases.map((p) =>
      toStoredPinPath(location, p).catch((error: unknown) => {
        // A failed resolution only means no match: the pin is added as a new entry.
        log.debug("Could not resolve a stored pin", { error: getErrorMessage(error) });
        return null;
      })
    )
  );
  const index = real.indexOf(storedPath);
  return index < 0 ? null : aliases[index];
}

export async function pinFile(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string; relativeTo?: "tool-cwd" | "checkout" | null }
): Promise<Outcome<{ path: string }>> {
  assertArtifactsEnabled(context);
  const location = await resolveForPinned(context, input.workspaceId);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  let relPath: string | { error: string };
  try {
    relPath = await toStoredPinPath(
      location,
      resolvePinInput(location, input.path, input.relativeTo)
    );
  } catch (error) {
    return unreachableError(error);
  }
  if (typeof relPath !== "string") return { success: false, error: relPath.error };
  const sessionDir = sessionDirFor(context, input.workspaceId);
  // Re-pinning an existing pin stays a no-op and opens the stored entry.
  const existing = await findExistingPin(location, await readPinnedPaths(sessionDir), relPath);
  if (existing != null) return { success: true, data: { path: existing } };
  // Pins persist until unpinned: refuse missing files, folders and symlinks up front instead of
  // storing a pin that can never be read.
  let refusal: string | null;
  try {
    refusal = await checkPinnable(location, relPath);
  } catch (error) {
    return unreachableError(error);
  }
  if (refusal != null) return { success: false, error: refusal };
  await addPinnedPath(sessionDir, relPath);
  return { success: true, data: { path: relPath } };
}

export async function unpinFile(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string }
): Promise<Outcome<void>> {
  assertArtifactsEnabled(context);
  if (!(await context.workspaceService.getInfo(input.workspaceId))) {
    return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  }
  await removePinnedPath(sessionDirFor(context, input.workspaceId), input.path);
  return { success: true, data: undefined };
}

export async function readPinnedFile(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string }
): Promise<ArtifactReadOutcome> {
  assertArtifactsEnabled(context);
  const location = await resolveForPinned(context, input.workspaceId);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  // Only pinned paths are readable: this route must not become a general checkout reader.
  const pinned = await readPinnedPaths(sessionDirFor(context, input.workspaceId));
  if (!pinned.includes(input.path)) {
    return { success: false, error: `File is not pinned: ${input.path}` };
  }
  const options = PINNED_READ_OPTIONS;
  const { root, relPath } = pinTarget(location, input.path);
  if (location.kind === "runtime") {
    try {
      const bytes = await readArtifactBytesOnRuntime(
        location.runtime,
        root,
        relPath,
        MAX_ARTIFACT_READ_BYTES,
        undefined,
        options
      );
      return toArtifactReadOutcome(input.path, bytes, MAX_ARTIFACT_READ_BYTES);
    } catch (error) {
      log.debug("Pinned file read failed", { error: getErrorMessage(error) });
      return unreachableError(error);
    }
  }
  return toArtifactReadOutcome(
    input.path,
    await readArtifactBytesFromDir(
      await realHostRoot(root),
      relPath,
      MAX_ARTIFACT_READ_BYTES,
      hostReadOptions(location)
    ),
    MAX_ARTIFACT_READ_BYTES
  );
}
