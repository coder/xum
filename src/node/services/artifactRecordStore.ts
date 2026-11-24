import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  ArtifactKindSchema,
  ArtifactPinSchema,
  type ArtifactPin,
} from "@/common/orpc/schemas/artifacts";
import { getArtifactKind, type ArtifactKind } from "@/common/utils/artifactKind";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

// Named for the version blobs older builds kept here: renaming it would orphan every saved
// `window.xum.setState`. Their `index.json` and `v<N>` blobs are not read.
export const ARTIFACT_STORE_DIR_NAME = "artifact-versions";
const RECORD_FILE_NAME = "record.json";
const RECORD_LOCK_FILE_NAME = "record.lock";

const ArtifactRecordSchema = z.object({
  /** POSIX path relative to the artifacts dir. */
  path: z.string(),
  title: z.string(),
  /** Kind override from the `artifact` tool; absent means "from the extension". */
  kind: ArtifactKindSchema.optional(),
  pin: ArtifactPinSchema.nullable(),
  publishedAtMs: z.number(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

/** Serializes writers per artifact dir (process-local; one backend owns a session dir). */
const recordLocks = new MutexMap<string>();

/**
 * Stable, filesystem-safe id for an artifact path: a readable slug plus a short hash of the exact
 * path, so different paths that slug alike ("a b.md", "a-b.md") never share a record.
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

export function getArtifactStoreRoot(sessionDir: string): string {
  return path.join(sessionDir, ARTIFACT_STORE_DIR_NAME);
}

function artifactDir(sessionDir: string, artifactId: string): string {
  assert(isValidArtifactId(artifactId), `invalid artifact id: ${artifactId}`);
  return path.join(getArtifactStoreRoot(sessionDir), artifactId);
}

/**
 * Read an artifact's record. Missing → null. A corrupt record is renamed aside (self-healing:
 * the next publish starts a fresh one instead of failing forever) and reported as null.
 */
export async function readArtifactRecord(
  sessionDir: string,
  artifactId: string
): Promise<ArtifactRecord | null> {
  if (!isValidArtifactId(artifactId)) return null;
  const recordPath = path.join(artifactDir(sessionDir, artifactId), RECORD_FILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(recordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return ArtifactRecordSchema.parse(JSON.parse(text));
  } catch (error) {
    log.warn("Corrupt artifact record; moving it aside", {
      recordPath,
      error: getErrorMessage(error),
    });
    await fs.rename(recordPath, `${recordPath}.corrupt-${Date.now()}`).catch(() => undefined);
    return null;
  }
}

export async function describeArtifact(
  sessionDir: string,
  relPath: string
): Promise<{ title: string; kind: ArtifactKind }> {
  const record = await readArtifactRecord(sessionDir, getArtifactId(relPath));
  return {
    title: record?.title ?? path.posix.basename(relPath),
    kind: record?.kind ?? getArtifactKind(relPath),
  };
}

export interface RecordArtifactPublishParams {
  sessionDir: string;
  /** POSIX path relative to the artifacts dir. */
  relPath: string;
  title: string;
  kind?: ArtifactKind;
  /** Undefined keeps the current pin. */
  pin?: ArtifactPin;
  nowMs?: number;
  /** Checked under the record lock: an aborted publish writes nothing. */
  abortSignal?: AbortSignal;
  /** The session locks (phase 4); every caller today keeps the Node layer. */
  locks?: SessionLocks;
}

export const ARTIFACT_PUBLISH_INTERRUPTED = "Publish was interrupted";

export async function recordArtifactPublish(
  params: RecordArtifactPublishParams
): Promise<ArtifactRecord> {
  const artifactId = getArtifactId(params.relPath);
  const dir = artifactDir(params.sessionDir, artifactId);
  return recordLocks.withLock(dir, async () => {
    await using _fileLock = await acquireRecordFileLock(dir, params.abortSignal, params.locks);
    const existing = await readArtifactRecord(params.sessionDir, artifactId);
    const record: ArtifactRecord = {
      path: params.relPath,
      title: params.title,
      ...(params.kind != null ? { kind: params.kind } : {}),
      pin: params.pin ?? existing?.pin ?? null,
      publishedAtMs: params.nowMs ?? Date.now(),
    };
    await fs.mkdir(dir, { recursive: true });
    if (params.abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
    await writeFileAtomic(path.join(dir, RECORD_FILE_NAME), JSON.stringify(record, null, 2));
    return record;
  });
}

/**
 * The in-process queue (recordLocks) orders this backend's own writers; this file lock then
 * excludes another backend sharing the Xum home (a desktop app alongside `xum server`), whose
 * read-modify-write could otherwise drop the other's pin.
 */
async function acquireRecordFileLock(
  dir: string,
  abortSignal: AbortSignal | undefined,
  locks: SessionLocks = nodeSessionLocks
): Promise<AsyncDisposable> {
  // Checked first: acquiring creates the artifact dir, and a cancelled publish writes nothing.
  if (abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
  try {
    const release = await locks.acquireCrossProcessLock({
      lockPath: path.join(dir, RECORD_LOCK_FILE_NAME),
      acquireTimeoutMs: 30_000,
      staleMs: 60_000,
      timeoutMessage: "Another Xum process is publishing this artifact.",
      signal: abortSignal,
    });
    return { [Symbol.asyncDispose]: release };
  } catch (error) {
    if (abortSignal?.aborted) throw new Error(ARTIFACT_PUBLISH_INTERRUPTED);
    throw error;
  }
}

/**
 * Ids of artifacts with a directory here: a record, saved state, or both. One readdir, so
 * callers can skip per-artifact reads for everything else.
 */
export async function listStoredArtifactIds(sessionDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(getArtifactStoreRoot(sessionDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter(isValidArtifactId);
}

/** Listing entries as the tab shows them: a published kind replaces the extension's. */
export function withPublishedKinds<T extends { path: string; kind: ArtifactKind }>(
  entries: T[],
  records: ArtifactRecord[]
): T[] {
  const kindByPath = new Map(records.flatMap((r) => (r.kind != null ? [[r.path, r.kind]] : [])));
  return entries.map((entry) => ({ ...entry, kind: kindByPath.get(entry.path) ?? entry.kind }));
}

export async function listArtifactRecords(sessionDir: string): Promise<ArtifactRecord[]> {
  const ids = await listStoredArtifactIds(sessionDir);
  const records = await Promise.all(ids.map((id) => readArtifactRecord(sessionDir, id)));
  return records.filter((record): record is ArtifactRecord => record != null);
}

/** Older builds also wrote `v<N>.state.json` per version: those files stay on disk, unread. */
function artifactStatePath(sessionDir: string, artifactId: string): string {
  return path.join(artifactDir(sessionDir, artifactId), "state.json");
}

/** Saved state, or null when none (or unreadable: a corrupt file is treated as no state). */
export async function readArtifactState(sessionDir: string, artifactId: string): Promise<unknown> {
  if (!isValidArtifactId(artifactId)) return null;
  let text: string;
  try {
    text = await fs.readFile(artifactStatePath(sessionDir, artifactId), "utf8");
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
  state: unknown
): Promise<void> {
  const filePath = artifactStatePath(sessionDir, artifactId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(state));
}
