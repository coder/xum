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
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { readArtifactBytesOnRuntime } from "./artifactRuntimeStore";
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
 * Pinned workspace files (Artifacts M4, Concept C): the user can open any checkout file in the
 * Artifacts tab. Pins are live (re-read on change, never snapshotted), stored per workspace in
 * `<sessionDir>/pinned-files.json` as POSIX paths relative to the checkout, and read through the
 * same capped, symlink-refusing readers as artifacts (hidden segments allowed: users pick files
 * such as `.github/workflows/ci.yml` by hand).
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
      return { error: "Only files inside the workspace checkout can be pinned" };
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
    (p) => typeof parseArtifactRelativePath(p, { allowHidden: true }) !== "string"
  );
}

async function updatePinnedPaths(
  sessionDir: string,
  update: (paths: string[]) => string[]
): Promise<void> {
  await storeLocks.withLock(sessionDir, async () => {
    const next = update(await readPinnedPaths(sessionDir));
    await fs.mkdir(sessionDir, { recursive: true });
    await writeFileAtomic(storePath(sessionDir), JSON.stringify({ paths: next }, null, 2));
  });
}

export async function addPinnedPath(sessionDir: string, relPath: string): Promise<void> {
  await updatePinnedPaths(sessionDir, (paths) =>
    paths.includes(relPath) ? paths : [...paths, relPath]
  );
}

export async function removePinnedPath(sessionDir: string, relPath: string): Promise<void> {
  await updatePinnedPaths(sessionDir, (paths) => paths.filter((p) => p !== relPath));
}

async function statPinned(
  location: Exclude<CheckoutLocation, { kind: "unavailable" }>,
  relPath: string
): Promise<{ size: number; modifiedMs: number } | null> {
  try {
    if (location.kind === "host") {
      const stat = await fs.stat(path.join(location.root, ...relPath.split("/")));
      return stat.isFile() ? { size: stat.size, modifiedMs: stat.mtimeMs } : null;
    }
    const stat = await location.runtime.stat(`${location.root.replace(/\/+$/, "")}/${relPath}`);
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
  const paths = await readPinnedPaths(sessionDirFor(context, input.workspaceId));
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
 * checkout root: resolve it against `execRoot` so the stored path is still checkout-relative.
 */
function resolvePinInput(
  location: Exclude<CheckoutLocation, { kind: "unavailable" }>,
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
 * Null when `relPath` is a regular file the pinned-file reader can open (same containment and
 * symlink rules as readPinnedFile), else why it cannot be pinned. A tiny cap keeps this a probe:
 * a larger file reports `too_large`, which still proves it is readable.
 */
async function checkPinnable(
  location: Exclude<CheckoutLocation, { kind: "unavailable" }>,
  relPath: string
): Promise<string | null> {
  const options = PINNED_READ_OPTIONS;
  const outcome =
    location.kind === "runtime"
      ? await readArtifactBytesOnRuntime(
          location.runtime,
          location.root,
          relPath,
          1,
          undefined,
          options
        )
      : await readArtifactBytesFromDir(
          await realHostRoot(location.root),
          relPath,
          1,
          hostReadOptions(location)
        );
  switch (outcome.status) {
    case "ok":
    case "too_large":
      return null;
    case "missing":
      return `Not a readable file in the checkout: ${relPath}`;
    case "invalid":
      return outcome.error;
  }
}

export async function pinFile(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string; relativeTo?: "tool-cwd" | "checkout" | null }
): Promise<Outcome<{ path: string }>> {
  assertArtifactsEnabled(context);
  const location = await resolveForPinned(context, input.workspaceId);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  const relPath = toPinnedRelativePath(
    location.root,
    resolvePinInput(location, input.path, input.relativeTo)
  );
  if (typeof relPath !== "string") return { success: false, error: relPath.error };
  const sessionDir = sessionDirFor(context, input.workspaceId);
  // Pins persist until unpinned: refuse missing files, folders and symlinks up front instead of
  // storing a pin that can never be read. Re-pinning an existing pin stays a no-op.
  if (!(await readPinnedPaths(sessionDir)).includes(relPath)) {
    let refusal: string | null;
    try {
      refusal = await checkPinnable(location, relPath);
    } catch (error) {
      return unreachableError(error);
    }
    if (refusal != null) return { success: false, error: refusal };
  }
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
  if (location.kind === "runtime") {
    try {
      const bytes = await readArtifactBytesOnRuntime(
        location.runtime,
        location.root,
        input.path,
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
      await realHostRoot(location.root),
      input.path,
      MAX_ARTIFACT_READ_BYTES,
      hostReadOptions(location)
    ),
    MAX_ARTIFACT_READ_BYTES
  );
}
