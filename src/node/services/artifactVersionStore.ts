import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  ArtifactPinSchema,
  ArtifactVersionSchema,
  type ArtifactPin,
  type ArtifactVersion,
  type ArtifactVersionSource,
} from "@/common/orpc/schemas/artifacts";
import type { ArtifactKind } from "@/common/utils/artifactKind";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

/**
 * Host store of artifact versions (Artifacts M4):
 * `<sessionDir>/artifact-versions/<artifactId>/{index.json, v1, v2, ...}`.
 *
 * Living in the host session dir gives versions the session lifecycle: they survive file edits,
 * app restarts and the loss of a container or SSH host, and are deleted with the session dir on
 * workspace removal. Bytes are copied in (never referenced), so a version never changes under a
 * reader. The index is append-only; the blob is written before the index entry that names it, so
 * a crash can leave an orphan blob but never an entry without bytes.
 */

export const ARTIFACT_VERSIONS_DIR_NAME = "artifact-versions";
const INDEX_FILE_NAME = "index.json";
const INDEX_LOCK_FILE_NAME = "index.lock";

const StoredVersionSchema = ArtifactVersionSchema.extend({
  /**
   * Source file mtime when copied; lets turn-end snapshots skip unchanged files unread. Kept only
   * when unambiguous (see unambiguousSourceModifiedMs).
   */
  sourceModifiedMs: z.number().optional(),
});
export type StoredArtifactVersion = z.infer<typeof StoredVersionSchema>;

const ArtifactIndexSchema = z.object({
  id: z.string(),
  path: z.string(),
  pin: ArtifactPinSchema.nullable(),
  /**
   * Last publish (artifact tool or attach_file), including a deduped one that added no version:
   * any publish during a turn suppresses that turn's end snapshot.
   */
  lastPublishedAtMs: z.number().optional(),
  versions: z.array(StoredVersionSchema),
});
export type ArtifactVersionIndex = z.infer<typeof ArtifactIndexSchema>;

/** Serializes writers per artifact dir (process-local; one backend owns a session dir). */
const indexLocks = new MutexMap<string>();

/**
 * Stable, filesystem-safe id for an artifact path: a readable slug plus a short hash of the exact
 * path, so different paths that slug alike ("a b.md", "a-b.md") never share versions.
 */
export function getArtifactId(relPath: string): string {
  assert(relPath.length > 0, "artifact path must not be empty");
  const slug = relPath
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha256").update(relPath).digest("hex").slice(0, 10);
  return `${slug || "artifact"}-${hash}`;
}

function isValidArtifactId(artifactId: string): boolean {
  return /^[a-z0-9._-]{1,80}$/.test(artifactId) && !artifactId.startsWith(".");
}

export function getArtifactVersionsRoot(sessionDir: string): string {
  return path.join(sessionDir, ARTIFACT_VERSIONS_DIR_NAME);
}

function artifactDir(sessionDir: string, artifactId: string): string {
  assert(isValidArtifactId(artifactId), `invalid artifact id: ${artifactId}`);
  return path.join(getArtifactVersionsRoot(sessionDir), artifactId);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read an artifact's index. Missing → null. A corrupt index is renamed aside (self-healing: the
 * next publish starts a fresh history instead of failing forever) and reported as null.
 */
export async function readArtifactIndex(
  sessionDir: string,
  artifactId: string
): Promise<ArtifactVersionIndex | null> {
  if (!isValidArtifactId(artifactId)) return null;
  const indexPath = path.join(artifactDir(sessionDir, artifactId), INDEX_FILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return ArtifactIndexSchema.parse(JSON.parse(text));
  } catch (error) {
    log.warn("Corrupt artifact version index; moving it aside", {
      indexPath,
      error: getErrorMessage(error),
    });
    await fs.rename(indexPath, `${indexPath}.corrupt-${Date.now()}`).catch(() => undefined);
    return null;
  }
}

export interface RecordArtifactVersionParams {
  sessionDir: string;
  /** POSIX path relative to the artifacts dir. */
  relPath: string;
  bytes: Buffer;
  source: ArtifactVersionSource;
  label: string | null;
  kind?: ArtifactKind;
  /** Undefined keeps the current pin; null clears it. */
  pin?: ArtifactPin | null;
  sourceModifiedMs?: number;
  nowMs?: number;
  /** Checked under the index lock: an aborted publish writes nothing. */
  abortSignal?: AbortSignal;
}

export const ARTIFACT_PUBLISH_INTERRUPTED = "Publish was interrupted";

/**
 * The source mtime worth recording, or undefined. Runtime stat reports whole seconds, so a
 * same-size rewrite within the second of the mtime keeps it: an mtime is trusted (and the
 * turn-end fast path may skip the file unread) only when the bytes were read at least 1 s later.
 */
function unambiguousSourceModifiedMs(
  sourceModifiedMs: number | undefined,
  nowMs: number
): number | undefined {
  return sourceModifiedMs != null && nowMs >= sourceModifiedMs + 1000
    ? sourceModifiedMs
    : undefined;
}

export interface RecordArtifactVersionResult {
  artifactId: string;
  /** The new version, or the latest one when the bytes were unchanged. */
  version: StoredArtifactVersion;
  created: boolean;
  pin: ArtifactPin | null;
}

/** Append a version unless the bytes equal the latest version's (content-hash dedupe). */
export async function recordArtifactVersion(
  params: RecordArtifactVersionParams
): Promise<RecordArtifactVersionResult> {
  const artifactId = getArtifactId(params.relPath);
  const dir = artifactDir(params.sessionDir, artifactId);
  return indexLocks.withLock(dir, async () => {
    await using _fileLock = await acquireIndexFileLock(dir, params.abortSignal);
    const existing = await readArtifactIndex(params.sessionDir, artifactId);
    const index: ArtifactVersionIndex = existing ?? {
      id: artifactId,
      path: params.relPath,
      pin: null,
      versions: [],
    };
    const nextPin = params.pin === undefined ? index.pin : params.pin;
    const nowMs = params.nowMs ?? Date.now();
    const lastPublishedAtMs = params.source === "turn-end" ? index.lastPublishedAtMs : nowMs;
    const sha256 = sha256Hex(params.bytes);
    const latest = index.versions.at(-1);
    const sourceModifiedMs = unambiguousSourceModifiedMs(params.sourceModifiedMs, nowMs);
    if (params.abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
    if (latest?.sha256 === sha256) {
      // Same bytes: no new version, but presentation and snapshot metadata follow the latest
      // publish (an explicit kind override, the file's current mtime).
      const { sourceModifiedMs: _previousModifiedMs, ...latestRest } = latest;
      const refreshed: StoredArtifactVersion = {
        ...latestRest,
        ...(params.kind != null ? { kind: params.kind } : {}),
        ...(sourceModifiedMs != null ? { sourceModifiedMs } : {}),
      };
      const metadataChanged =
        refreshed.kind !== latest.kind || refreshed.sourceModifiedMs !== latest.sourceModifiedMs;
      if (
        metadataChanged ||
        nextPin !== index.pin ||
        lastPublishedAtMs !== index.lastPublishedAtMs
      ) {
        await writeIndex(dir, {
          ...index,
          pin: nextPin,
          lastPublishedAtMs,
          versions: [...index.versions.slice(0, -1), refreshed],
        });
      }
      return { artifactId, version: refreshed, created: false, pin: nextPin };
    }
    const entry: StoredArtifactVersion = {
      version: (latest?.version ?? 0) + 1,
      label: params.label,
      source: params.source,
      createdAtMs: nowMs,
      sha256,
      size: params.bytes.length,
      path: params.relPath,
      ...(params.kind != null ? { kind: params.kind } : {}),
      ...(sourceModifiedMs != null ? { sourceModifiedMs } : {}),
    };
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, `v${entry.version}`), params.bytes);
    // Cancelled while the blob was written: the index commit is what publishes the version, so
    // stop before it. The orphan blob is overwritten by the next version with this number.
    if (params.abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
    await writeIndex(dir, {
      ...index,
      path: params.relPath,
      pin: nextPin,
      ...(lastPublishedAtMs != null ? { lastPublishedAtMs } : {}),
      versions: [...index.versions, entry],
    });
    return { artifactId, version: entry, created: true, pin: nextPin };
  });
}

/**
 * The in-process queue (indexLocks) orders this backend's own writers; this file lock then
 * excludes another backend sharing the Xum home (a desktop app alongside `xum server`), whose
 * read-modify-write could otherwise drop a version or pair its index with this one's blob.
 */
async function acquireIndexFileLock(
  dir: string,
  abortSignal: AbortSignal | undefined
): Promise<AsyncDisposable> {
  // Checked first: acquiring creates the artifact dir, and a cancelled publish writes nothing.
  if (abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
  try {
    const release = await acquireCrossProcessLock({
      lockPath: path.join(dir, INDEX_LOCK_FILE_NAME),
      acquireTimeoutMs: 30_000,
      staleMs: 60_000,
      timeoutMessage: "Another Xum process is recording a version of this artifact.",
      signal: abortSignal,
    });
    return { [Symbol.asyncDispose]: release };
  } catch (error) {
    if (abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
    throw error;
  }
}

async function writeIndex(dir: string, index: ArtifactVersionIndex): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, INDEX_FILE_NAME), JSON.stringify(index, null, 2));
}

/** Every artifact index in the session dir (unreadable entries are skipped). */
/**
 * Ids of artifacts with a directory here: stored versions, saved state, or both. One readdir, so
 * callers can skip per-artifact reads for everything else.
 */
export async function listStoredArtifactIds(sessionDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(getArtifactVersionsRoot(sessionDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter(isValidArtifactId);
}

export async function listArtifactIndexes(sessionDir: string): Promise<ArtifactVersionIndex[]> {
  const ids = await listStoredArtifactIds(sessionDir);
  const indexes = await Promise.all(ids.map((name) => readArtifactIndex(sessionDir, name)));
  return indexes.filter((index): index is ArtifactVersionIndex => index != null);
}

/**
 * True when anything was published (artifact tool or attach_file) at or after `sinceMs`. The
 * turn-end snapshot rule keys on this, so no in-memory per-turn state is needed and the rule
 * holds across restarts.
 */
export function hasPublishSince(indexes: ArtifactVersionIndex[], sinceMs: number): boolean {
  return indexes.some((index) => (index.lastPublishedAtMs ?? -Infinity) >= sinceMs);
}

/** Public view of a stored version (drops internal bookkeeping fields). */
export function toPublicVersion(version: StoredArtifactVersion): ArtifactVersion {
  const { sourceModifiedMs: _sourceModifiedMs, ...rest } = version;
  return rest;
}

export async function readArtifactVersionBytes(
  sessionDir: string,
  artifactId: string,
  version: number
): Promise<{ version: StoredArtifactVersion; bytes: Buffer } | null> {
  const index = await readArtifactIndex(sessionDir, artifactId);
  const entry = index?.versions.find((v) => v.version === version);
  if (!entry) return null;
  try {
    const bytes = await fs.readFile(path.join(artifactDir(sessionDir, artifactId), `v${version}`));
    return { version: entry, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * `window.xum.setState` storage (Artifacts M5b): `v<N>.state.json` beside the version's bytes,
 * latest write wins. Version 0 holds the state of an artifact that has no stored version yet.
 */
function artifactStatePath(sessionDir: string, artifactId: string, version: number): string {
  assert(Number.isInteger(version) && version >= 0, "state version must be a non-negative integer");
  return path.join(artifactDir(sessionDir, artifactId), `v${version}.state.json`);
}

/** Saved state, or null when none (or unreadable: a corrupt file is treated as no state). */
export async function readArtifactState(
  sessionDir: string,
  artifactId: string,
  version: number
): Promise<unknown> {
  if (!isValidArtifactId(artifactId)) return null;
  let text: string;
  try {
    text = await fs.readFile(artifactStatePath(sessionDir, artifactId, version), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Callers validate the state (JSON, size cap) first. */
export async function writeArtifactState(
  sessionDir: string,
  artifactId: string,
  version: number,
  state: unknown
): Promise<void> {
  const filePath = artifactStatePath(sessionDir, artifactId, version);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(state));
}
