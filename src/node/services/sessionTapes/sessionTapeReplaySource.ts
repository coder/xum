/**
 * Backend replay source for session tapes (perf harnesses): serves a recorded tape as a
 * workspace's `workspace.onChat` stream instead of the live session, so the real transport and
 * the real renderer path (WorkspaceStore -> aggregator -> React) see the recorded events.
 *
 * Configuration: `XUM_REPLAY_TAPES` (legacy `MUX_REPLAY_TAPES`) is a JSON object mapping
 * workspace ids to absolute tape paths. It is honored only together with `XUM_MOCK_AI=1`, so a
 * normal app never serves a tape. Workspace ids inside the tape are not rewritten: the harness
 * maps the workspace id the tape was recorded for.
 *
 * Contract for a mapped workspace (the router branches here before touching the session):
 * - No AgentSession, AIService, tool or provider code runs; events come only from the tape.
 * - Only fresh full subscriptions are served, each with the whole tape (no resumable replay).
 *   A `since` request (the renderer resubscribes that way when the user re-enters the
 *   workspace) is refused: its client keeps rows it would not reset, and a stopped tape may end
 *   before the `caught-up` that would make it replace them. Reload the page to replay again;
 *   perf harnesses start each run with a fresh renderer. `since`, `live`, a missing
 *   `XUM_MOCK_AI=1`, a relative tape path, an unreadable or rejected tape (see the loader) fail
 *   the subscription with a terminal refusal (`SESSION_TAPE_REPLAY_REFUSAL_DATA`) that the
 *   renderer shows instead of retrying. There is never a fallback to the live session.
 * - Truncated tapes are refused too: replay serves complete tapes only. `tapeInfo
 *   --allow-truncated` can still describe them.
 * - Events play at their recorded offsets; the subscription then stays open until the client
 *   aborts, so the renderer does not resubscribe and replay the tape again.
 * - Sends, resumes, the listed history changes (clear, truncate, reset, Start Here, answers) and
 *   sidebar status generation are refused for a mapped workspace (see
 *   `isSessionTapeReplayWorkspace`), so a replayed workspace never starts a live turn from the
 *   UI. Other workspace actions and backend services that reach the session directly (startup
 *   recovery, heartbeats, crashed workflow-run resume, task recovery, held inputs) are not
 *   guarded. Map only scratch fixture workspaces in a fresh harness root with no persisted run,
 *   task, heartbeat or interrupted-stream state for the mapped ids, never a workspace whose real
 *   history matters.
 * Unmapped workspaces take the normal path. An unparseable `XUM_REPLAY_TAPES` cannot tell which
 * workspaces are mapped, so it treats every workspace as mapped (and refused) rather than
 * silently going live. An invalid entry refuses only its own workspace.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ORPCError } from "@orpc/server";
import { resolveXumEnvironmentValue } from "@/common/compat/xumEnv";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import { getErrorMessage } from "@/common/utils/errors";
import {
  isFinalizedSessionTapeFileName,
  loadSessionTape,
  type SessionTapeLoadOptions,
  type SessionTapeLoadResult,
} from "@/common/utils/sessionTapes/sessionTapeLoader";
import {
  replaySessionTape,
  SESSION_TAPE_REPLAY_REFUSAL_DATA,
} from "@/common/utils/sessionTapes/sessionTapeReplay";
import { log } from "@/node/services/log";

/** Read and validate a tape file. Names not ending in `.jsonl` (temp files) are rejected unread. */
export async function readSessionTapeFile(
  filePath: string,
  options?: SessionTapeLoadOptions
): Promise<SessionTapeLoadResult> {
  if (!isFinalizedSessionTapeFileName(path.basename(filePath))) {
    return { status: "rejected", reason: "not a finalized tape (the name must end in .jsonl)" };
  }
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return { status: "rejected", reason: `unreadable: ${getErrorMessage(error)}` };
  }
  return loadSessionTape(text, options);
}

/** Workspace id -> absolute tape path, or why that entry cannot be used. */
type ReplayTapeMap = ReadonlyMap<string, string | Error>;

/** Parsed once per distinct env value (in practice once per process). */
let cachedConfig: { raw: string; map: ReplayTapeMap | Error } | undefined;

function parseReplayTapeMap(raw: string): ReplayTapeMap | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Error("XUM_REPLAY_TAPES is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Error("XUM_REPLAY_TAPES must be a JSON object of workspace id -> tape path");
  }
  const map = new Map<string, string | Error>();
  for (const [workspaceId, tapePath] of Object.entries(parsed)) {
    // A bad entry still names its workspace: refuse only that one, not the whole map.
    map.set(
      workspaceId,
      typeof tapePath === "string" && path.isAbsolute(tapePath)
        ? tapePath
        : new Error(`XUM_REPLAY_TAPES: the tape path for ${workspaceId} must be absolute`)
    );
  }
  return map;
}

function readReplayTapeMap(): ReplayTapeMap | Error | undefined {
  const raw = resolveXumEnvironmentValue("REPLAY_TAPES", process.env);
  if (raw === undefined || raw.trim() === "") return undefined;
  if (cachedConfig?.raw !== raw) cachedConfig = { raw, map: parseReplayTapeMap(raw) };
  return cachedConfig.map;
}

/**
 * Refusal of sends, resumes and history changes in a workspace that
 * `isSessionTapeReplayWorkspace` claims.
 */
export const SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE =
  "This workspace replays a session tape (XUM_REPLAY_TAPES); sending and history changes are disabled.";

/**
 * Whether `XUM_REPLAY_TAPES` claims this workspace: it is mapped (valid entry or not), or the
 * map is unparseable. Independent of the tape's state and of `XUM_MOCK_AI`: a claimed workspace
 * never runs live, so callers refuse turns and skip provider work (status generation) for it.
 */
export function isSessionTapeReplayWorkspace(workspaceId: string): boolean {
  const map = readReplayTapeMap();
  return map !== undefined && (map instanceof Error || map.has(workspaceId));
}

export interface SessionTapeReplay {
  /**
   * Validate the whole tape, then push its events at their recorded offsets. Rejects with an
   * ORPCError carrying `SESSION_TAPE_REPLAY_REFUSAL_DATA` (message shown by the client) when
   * the replay cannot be served; resolves after the last event or on abort.
   */
  play(push: (event: WorkspaceChatMessage) => void, signal?: AbortSignal): Promise<void>;
}

function refuseReplay(workspaceId: string, message: string): never {
  log.warn("Session tape replay refused", { workspaceId, error: message });
  throw new ORPCError("PRECONDITION_FAILED", { message, data: SESSION_TAPE_REPLAY_REFUSAL_DATA });
}

/**
 * The tape replay for this onChat subscription, or undefined when the workspace is not mapped
 * (normal live subscription). Never touches the workspace's session.
 */
export function getSessionTapeReplay(input: {
  workspaceId: string;
  mode?: OnChatMode;
}): SessionTapeReplay | undefined {
  const map = readReplayTapeMap();
  if (map === undefined) return undefined;
  const { workspaceId } = input;
  const entry = map instanceof Error ? map : map.get(workspaceId);
  if (entry === undefined) return undefined;
  const tapePath = entry instanceof Error ? undefined : entry;

  // Checked when playback starts, so the error surfaces from the subscription's iterator.
  let refusal: string | undefined;
  if (entry instanceof Error) {
    refusal = entry.message;
  } else if (resolveXumEnvironmentValue("MOCK_AI", process.env) !== "1") {
    // Extra guard: only mock-AI harness runs may replace a workspace's chat with a tape.
    refusal = "XUM_REPLAY_TAPES requires XUM_MOCK_AI=1";
  } else if (input.mode !== undefined && input.mode.type !== "full") {
    // See the module comment: no resumable replay. Reloading the page subscribes afresh.
    refusal = `Session tape replay serves only fresh full subscriptions (got "${input.mode.type}"); reload to replay the tape again`;
  }

  return {
    play: async (push, signal) => {
      if (refusal !== undefined || tapePath === undefined) {
        refuseReplay(workspaceId, refusal ?? "no tape mapped");
      }
      // Truncated tapes load (flagged) so the refusal can say why replay will not serve them.
      const result = await readSessionTapeFile(tapePath, { allowTruncated: true });
      if (result.status === "rejected") {
        const where = result.line === undefined ? "" : ` (line ${result.line})`;
        refuseReplay(workspaceId, `Session tape ${tapePath} rejected: ${result.reason}${where}`);
      }
      if (result.status === "truncated") {
        refuseReplay(
          workspaceId,
          `Session tape ${tapePath} is truncated (size cap hit): replay serves only complete tapes`
        );
      }
      if (result.status === "stopped") {
        log.info("Session tape ends at an explicit stop, not at the end of its subscription", {
          workspaceId,
          tapePath,
        });
      }
      for await (const event of replaySessionTape(result, { pacing: "recorded", signal })) {
        push(event);
      }
    },
  };
}
