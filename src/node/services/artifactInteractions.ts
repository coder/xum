/**
 * Artifact interactions (Artifacts M5b): messages a user sends from an artifact, and the
 * artifact's persisted `window.xum.state`.
 *
 * Delivery is restart-safe, like task guidance (taskPendingGuidance): each confirmed send is first
 * written as a pending record (`<sessionDir>/artifact-interactions.json`), then dispatched through
 * WorkspaceService.sendMessage with the "tool-end" queue mode (lands at the next tool boundary
 * mid-turn, starts a turn when idle). The record is deleted only once the message is accepted
 * (its user row is durable). On startup, pending records are re-sent; a record whose id already
 * appears in history (crash between acceptance and deletion) is dropped instead.
 */
import { randomUUID } from "crypto";
import * as path from "path";
import { z } from "zod";
import {
  ARTIFACT_JSON_MAX_BYTES,
  ARTIFACT_SEND_TEXT_MAX_CHARS,
  ARTIFACT_STATE_SUMMARY_MAX_CHARS,
  isJsonValue,
  jsonByteLength,
} from "@/common/constants/artifactInteractions";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { ArtifactInteractionMetadata, MuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import * as fs from "fs/promises";
import type { ORPCContext } from "@/node/orpc/context";
import { assertArtifactsEnabled, type ArtifactsContext } from "./artifactsOperations";
import { parseArtifactRelativePath } from "./artifactStore";
import {
  getArtifactId,
  readArtifactIndex,
  readArtifactState,
  writeArtifactState,
} from "./artifactVersionStore";
import { log } from "./log";
import type { HistoryService } from "./historyService";
import type { SendMessageInternalOptions } from "./taskWorkspaceSeam";
import type { WorkspaceService } from "./workspaceService";

export const ARTIFACT_INTERACTIONS_FILE_NAME = "artifact-interactions.json";
/** Queue dedupe key prefix; the suffix is the pending record id. */
export const ARTIFACT_INTERACTION_DEDUPE_PREFIX = "artifact-interaction:";
/** History rows scanned on replay for already-delivered ids (pending records are recent). */
const REPLAY_HISTORY_SCAN_MESSAGES = 200;

const PendingRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  artifactPath: z.string().min(1),
  artifactTitle: z.string(),
  version: z.number().int().nonnegative(),
  text: z.string(),
  data: z.unknown().optional(),
  createdAtMs: z.number(),
  /** Stored so replay keeps the original dispatch mode. */
  queueDispatchMode: z.literal("tool-end"),
});
export type PendingArtifactInteraction = z.infer<typeof PendingRecordSchema>;

// Records are validated one by one (below), so one record this version cannot read (corrupt,
// or written by another app version) does not discard the user's other confirmed sends.
const PendingFileSchema = z.object({
  version: z.literal(1),
  pending: z.array(z.unknown()),
});

/** Serializes read-modify-write of one session's pending file (one backend owns a session dir). */
const pendingLocks = new MutexMap<string>();

function pendingFilePath(sessionDir: string): string {
  return path.join(sessionDir, ARTIFACT_INTERACTIONS_FILE_NAME);
}

/** Pending records; a missing file is empty, a corrupt one is moved aside (self-healing). */
export async function readPendingArtifactInteractions(
  sessionDir: string
): Promise<PendingArtifactInteraction[]> {
  const filePath = pendingFilePath(sessionDir);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let records: unknown[];
  try {
    records = PendingFileSchema.parse(JSON.parse(text)).pending;
  } catch (error) {
    log.warn("Corrupt artifact interactions file; moving it aside", {
      filePath,
      error: getErrorMessage(error),
    });
    await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => undefined);
    return [];
  }
  const pending: PendingArtifactInteraction[] = [];
  for (const record of records) {
    const parsed = PendingRecordSchema.safeParse(record);
    if (parsed.success) pending.push(parsed.data);
  }
  if (pending.length < records.length) {
    log.warn("Skipping unreadable artifact interaction records", {
      filePath,
      skipped: records.length - pending.length,
    });
  }
  return pending;
}

async function updatePending(
  sessionDir: string,
  update: (pending: PendingArtifactInteraction[]) => PendingArtifactInteraction[]
): Promise<void> {
  await pendingLocks.withLock(sessionDir, async () => {
    const next = update(await readPendingArtifactInteractions(sessionDir));
    if (next.length === 0) {
      await fs.rm(pendingFilePath(sessionDir), { force: true });
      return;
    }
    await fs.mkdir(sessionDir, { recursive: true });
    await writeFileAtomic(
      pendingFilePath(sessionDir),
      JSON.stringify({ version: 1, pending: next }, null, 2)
    );
  });
}

function removePending(sessionDir: string, id: string): Promise<void> {
  return updatePending(sessionDir, (pending) => pending.filter((record) => record.id !== id));
}

/** Attribute values come from file paths and labels, so they are escaped like XML. */
export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The model-facing text. The body is JSON, so `</artifact_interaction>` inside the text cannot
 * close the tag early (JSON escapes `<` as `\u003c`).
 */
export function buildArtifactInteractionText(record: PendingArtifactInteraction): string {
  const body = JSON.stringify(
    record.data === undefined ? { text: record.text } : { text: record.text, data: record.data }
  ).replace(/</g, "\\u003c");
  return (
    `<artifact_interaction artifact="${escapeXmlAttribute(record.artifactPath)}"` +
    ` title="${escapeXmlAttribute(record.artifactTitle)}" version="${record.version}"` +
    ` action="send">${body}</artifact_interaction>`
  );
}

export function buildArtifactInteractionMetadata(
  record: PendingArtifactInteraction
): ArtifactInteractionMetadata {
  return {
    id: record.id,
    artifactPath: record.artifactPath,
    title: record.artifactTitle,
    version: record.version,
    action: "send",
    text: record.text,
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
}

/**
 * Which version an interaction refers to, and its title. `version: null` means the live file: it
 * resolves to the latest stored version, or 0 when the file has none yet.
 */
export async function resolveArtifactInteractionTarget(
  sessionDir: string,
  relPath: string,
  version: number | null
): Promise<{ artifactId: string; version: number; title: string }> {
  const artifactId = getArtifactId(relPath);
  const index = await readArtifactIndex(sessionDir, artifactId);
  const latest = index?.versions.at(-1);
  const resolved = version ?? latest?.version ?? 0;
  const label = index?.versions.find((entry) => entry.version === resolved)?.label;
  return { artifactId, version: resolved, title: label ?? path.posix.basename(relPath) };
}

function validateJsonPayload(value: unknown, what: string): string | null {
  if (!isJsonValue(value)) return `${what} must be JSON`;
  const size = jsonByteLength(value) ?? Infinity;
  if (size > ARTIFACT_JSON_MAX_BYTES) {
    return `${what} is ${size} bytes; the limit is ${ARTIFACT_JSON_MAX_BYTES}`;
  }
  return null;
}

export interface ArtifactInteractionDeps {
  sessionsDir: string;
  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions,
    internal?: SendMessageInternalOptions
  ): Promise<Result<void, unknown>>;
  getDefaultSendOptions(workspaceId: string): Promise<SendMessageOptions>;
  getLastMessages(workspaceId: string, n: number): Promise<MuxMessage[]>;
  now?: () => number;
  newId?: () => string;
}

function sessionDirOf(deps: Pick<ArtifactInteractionDeps, "sessionsDir">, workspaceId: string) {
  assert(workspaceId.length > 0 && !workspaceId.includes("/"), "invalid workspace id");
  return path.join(deps.sessionsDir, workspaceId);
}

/**
 * Dispatch through the normal send path, also on startup replay: an idle workspace starts a turn
 * and a busy one queues it for the next tool boundary. (Restoring it straight into the queue, as
 * task guidance does, parked it on an idle workspace until something else dispatched the queue.)
 */
async function dispatchPending(
  deps: ArtifactInteractionDeps,
  record: PendingArtifactInteraction
): Promise<Result<void, string>> {
  const sessionDir = sessionDirOf(deps, record.workspaceId);
  const sendOptions = await deps.getDefaultSendOptions(record.workspaceId);
  const result = await deps.sendMessage(
    record.workspaceId,
    buildArtifactInteractionText(record),
    {
      ...sendOptions,
      queueDispatchMode: record.queueDispatchMode,
      muxMetadata: {
        type: "normal",
        artifactInteraction: buildArtifactInteractionMetadata(record),
      },
    },
    {
      artifactInteraction: true,
      queueDedupeKey: `${ARTIFACT_INTERACTION_DEDUPE_PREFIX}${record.id}`,
      // Fires once the user row is durable (immediately when idle, at dispatch when queued), so a
      // restart before then still finds the record and re-sends it.
      onAccepted: () => removePending(sessionDir, record.id),
      // A queued send the user withdrew (Stop, queue clear) or one that failed before its stream
      // started is settled: replaying it on the next startup would resurrect it.
      onCanceled: () => removePending(sessionDir, record.id),
      onAcceptedPreStreamFailure: () => removePending(sessionDir, record.id),
    }
  );
  if (!result.success) {
    // Startup replay keeps the record for the next startup; a live send removes it (its caller
    // reports the error).
    return Err(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
  }
  return Ok(undefined);
}

/** A confirmed send from the Artifacts tab: persist, then dispatch. */
export async function sendArtifactInteraction(
  deps: ArtifactInteractionDeps,
  input: { workspaceId: string; path: string; version: number | null; text: string; data?: unknown }
): Promise<Result<{ id: string }, string>> {
  const segments = parseArtifactRelativePath(input.path);
  if (typeof segments === "string") return Err(segments);
  if (input.text.length === 0 || input.text.length > ARTIFACT_SEND_TEXT_MAX_CHARS) {
    return Err(`Text must be 1-${ARTIFACT_SEND_TEXT_MAX_CHARS} characters`);
  }
  if (input.data !== undefined) {
    const error = validateJsonPayload(input.data, "Data");
    if (error != null) return Err(error);
  }
  const sessionDir = sessionDirOf(deps, input.workspaceId);
  const target = await resolveArtifactInteractionTarget(sessionDir, input.path, input.version);
  const record: PendingArtifactInteraction = {
    id: (deps.newId ?? randomUUID)(),
    workspaceId: input.workspaceId,
    artifactPath: segments.join("/"),
    artifactTitle: target.title,
    version: target.version,
    text: input.text,
    ...(input.data !== undefined ? { data: input.data } : {}),
    createdAtMs: (deps.now ?? Date.now)(),
    queueDispatchMode: "tool-end",
  };
  await updatePending(sessionDir, (pending) => [...pending, record]);
  let dispatched: Result<void, string>;
  try {
    dispatched = await dispatchPending(deps, record);
  } catch (error) {
    // A throw (send options, the send path) is a failed send too: without this the record would
    // stay, the user would retry, and both copies would replay on the next startup.
    dispatched = Err(getErrorMessage(error));
  }
  if (!dispatched.success) {
    // The caller shows this error now, so the record must not be re-sent on the next startup.
    // Only records that were persisted but never reached the send path replay.
    await removePending(sessionDir, record.id);
    return dispatched;
  }
  return Ok({ id: record.id });
}

function deliveredIds(messages: MuxMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const meta = message.metadata?.muxMetadata as
      | { artifactInteraction?: { id?: unknown } }
      | undefined;
    const id = meta?.artifactInteraction?.id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * Startup replay for one workspace. Never throws: a failure leaves the records for next time.
 * Returns how many records were re-sent.
 */
export async function replayPendingArtifactInteractions(
  deps: ArtifactInteractionDeps,
  workspaceId: string
): Promise<number> {
  const sessionDir = sessionDirOf(deps, workspaceId);
  let resent = 0;
  try {
    const pending = await readPendingArtifactInteractions(sessionDir);
    if (pending.length === 0) return 0;
    const delivered = deliveredIds(
      await deps.getLastMessages(workspaceId, REPLAY_HISTORY_SCAN_MESSAGES)
    );
    for (const record of pending) {
      if (delivered.has(record.id)) {
        await removePending(sessionDir, record.id);
        continue;
      }
      const result = await dispatchPending(deps, record);
      if (result.success) resent++;
      else log.warn("Artifact interaction replay failed", { workspaceId, error: result.error });
    }
  } catch (error) {
    log.warn("Artifact interaction replay failed", { workspaceId, error: getErrorMessage(error) });
  }
  return resent;
}

/** Workspaces with a pending file (cheap: one stat per session dir entry). */
export async function listWorkspacesWithPendingInteractions(
  sessionsDir: string
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    try {
      await fs.access(path.join(sessionsDir, name, ARTIFACT_INTERACTIONS_FILE_NAME));
      found.push(name);
    } catch {
      // No pending interactions.
    }
  }
  return found;
}

export async function getArtifactInteractionState(
  sessionsDir: string,
  input: { workspaceId: string; path: string; version: number | null }
): Promise<Result<{ version: number; state: unknown }, string>> {
  const segments = parseArtifactRelativePath(input.path);
  if (typeof segments === "string") return Err(segments);
  const sessionDir = sessionDirOf({ sessionsDir }, input.workspaceId);
  const target = await resolveArtifactInteractionTarget(sessionDir, input.path, input.version);
  return Ok({
    version: target.version,
    state: await readArtifactState(sessionDir, target.artifactId, target.version),
  });
}

export async function setArtifactInteractionState(
  sessionsDir: string,
  input: { workspaceId: string; path: string; version: number | null; state: unknown }
): Promise<Result<{ version: number }, string>> {
  const segments = parseArtifactRelativePath(input.path);
  if (typeof segments === "string") return Err(segments);
  const error = validateJsonPayload(input.state, "State");
  if (error != null) return Err(error);
  const sessionDir = sessionDirOf({ sessionsDir }, input.workspaceId);
  const target = await resolveArtifactInteractionTarget(sessionDir, input.path, input.version);
  await writeArtifactState(sessionDir, target.artifactId, target.version, input.state);
  return Ok({ version: target.version });
}

/** artifact_list's view of the latest version's state: JSON, cut to the summary cap. */
export async function summarizeArtifactState(
  sessionDir: string,
  relPath: string
): Promise<{ version: number; state: string; truncated: boolean } | null> {
  const target = await resolveArtifactInteractionTarget(sessionDir, relPath, null);
  const state = await readArtifactState(sessionDir, target.artifactId, target.version);
  if (state == null) return null;
  const text = JSON.stringify(state);
  const truncated = text.length > ARTIFACT_STATE_SUMMARY_MAX_CHARS;
  return {
    version: target.version,
    state: truncated ? text.slice(0, ARTIFACT_STATE_SUMMARY_MAX_CHARS) : text,
    truncated,
  };
}

/** Production wiring: the real send path, AI-settings resolution and history. */
export function createArtifactInteractionDeps(services: {
  config: { sessionsDir: string };
  workspaceService: Pick<WorkspaceService, "sendMessage" | "getDefaultSendOptions">;
  historyService: Pick<HistoryService, "getLastMessages">;
}): ArtifactInteractionDeps {
  return {
    sessionsDir: services.config.sessionsDir,
    sendMessage: (workspaceId, message, options, internal) =>
      services.workspaceService.sendMessage(workspaceId, message, options, internal),
    getDefaultSendOptions: (workspaceId) =>
      services.workspaceService.getDefaultSendOptions(workspaceId),
    getLastMessages: async (workspaceId, n) => {
      const result = await services.historyService.getLastMessages(workspaceId, n);
      // An unreadable history is not an empty one: replay would re-send records whose user row
      // may already be there. Throwing keeps them for the next startup.
      if (!result.success) throw new Error(`Could not read history: ${result.error}`);
      return result.data;
    },
  };
}

type InteractionRouteContext = ArtifactsContext & Pick<ORPCContext, "historyService">;

async function assertRouteWorkspace(
  context: InteractionRouteContext,
  workspaceId: string
): Promise<string | null> {
  assertArtifactsEnabled(context);
  const metadata = await context.workspaceService.getInfo(workspaceId);
  return metadata == null ? `Workspace not found: ${workspaceId}` : null;
}

export async function sendInteractionRoute(
  context: InteractionRouteContext,
  input: { workspaceId: string; path: string; version: number | null; text: string; data?: unknown }
): Promise<Result<{ id: string }, string>> {
  const missing = await assertRouteWorkspace(context, input.workspaceId);
  if (missing != null) return Err(missing);
  return sendArtifactInteraction(createArtifactInteractionDeps(context), input);
}

export async function getStateRoute(
  context: InteractionRouteContext,
  input: { workspaceId: string; path: string; version: number | null }
): Promise<Result<{ version: number; state: unknown }, string>> {
  const missing = await assertRouteWorkspace(context, input.workspaceId);
  if (missing != null) return Err(missing);
  return getArtifactInteractionState(context.config.sessionsDir, input);
}

export async function setStateRoute(
  context: InteractionRouteContext,
  input: { workspaceId: string; path: string; version: number | null; state: unknown }
): Promise<Result<{ version: number }, string>> {
  const missing = await assertRouteWorkspace(context, input.workspaceId);
  if (missing != null) return Err(missing);
  return setArtifactInteractionState(context.config.sessionsDir, input);
}
