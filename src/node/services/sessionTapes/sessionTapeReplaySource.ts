/**
 * Desktop replay source for session tapes (perf harness `perf.tapeReplay`): serves a recorded
 * tape as a workspace's `workspace.onChat` stream instead of the live session, so the real
 * transport and the real renderer path (WorkspaceStore -> aggregator -> React) see the recorded
 * events.
 *
 * Configuration: `XUM_REPLAY_TAPES` (legacy `MUX_REPLAY_TAPES`) is a JSON object mapping
 * workspace ids to absolute tape paths. Unset or blank: nothing here does any work. Set (even
 * unparseable): the whole process is in replay mode, which is read-only:
 * - The WorkspaceService funnels that start turns or rewrite history refuse with
 *   SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE for every workspace: send, resume, truncate/clear,
 *   reset, replace (Start Here) and ask-user answers. Other writes (plan-review snapshots and
 *   thread state, ...) are not guarded: they touch the workspace's own chat.jsonl, never the
 *   tape. Map only scratch workspaces (the perf harness uses a fresh root).
 * - Provider model creation refuses (ProviderModelFactory, evaluationModelFactory), so no
 *   background service (status, title, compaction, memory, ...) can reach a provider.
 *
 * Replay mode does not take the app's other background network offline (git remote queries,
 * `gh`, Coder CLI probes): the harness does that (`make perf-tape-replay`, see
 * tests/e2e/scenarios/perf.tapeReplay.spec.ts).
 *
 * Contract for a mapped workspace (the router branches here before touching the session):
 * - No AgentSession, tool or provider code runs; events come only from the tape.
 * - Served only after desktop main blocked the renderer's network egress
 *   (`markSessionTapeReplayEgressBlocked`), so recorded URLs (images in markdown, ...) are never
 *   fetched. `xum server` and browser mode always refuse.
 * - Only fresh full subscriptions, each with the whole tape (no resumable replay). `since` and
 *   `live` are refused: their client keeps rows a delta would not reset. Reload to replay again.
 * - Only tapes with exactly one successful `caught-up` (a recorded, complete history replay).
 * - Only gap-free tapes recorded for the mapped workspace (header `workspaceIdHash`): `closed`
 *   tapes, and `stopped` ones (finalized by the save command or at quit; complete up to the stop,
 *   so a turn in progress at the stop stays in progress). Rejected and truncated tapes are
 *   refused; the offline tools still describe them.
 * - Refusals are terminal (`SESSION_TAPE_REPLAY_REFUSAL_DATA`): the renderer shows them instead
 *   of retrying. There is never a fallback to the live session.
 * - Events play at their recorded offsets; the subscription then stays open until the client
 *   aborts, so the renderer does not resubscribe and replay the tape again. The only change to a
 *   recorded event: `caught-up.hasOlderHistory` is set to false, so the renderer never pages older
 *   rows in from the live workspace history.
 * Unmapped workspaces take the normal path. An unparseable map cannot tell which workspaces are
 * mapped, so it treats every workspace as mapped (and refused) rather than silently going live.
 * An invalid entry refuses only its own workspace.
 */
import * as path from "node:path";
import { ORPCError } from "@orpc/server";
import { resolveXumEnvironmentValue } from "@/common/compat/xumEnv";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import {
  isSessionTapeReplayConfigured,
  isSessionTapeReplayEgressBlocked,
  replaySessionTape,
  SESSION_TAPE_REPLAY_REFUSAL_DATA,
} from "@/common/utils/sessionTapes/sessionTapeReplay";
import { log } from "@/node/services/log";
import { readSessionTapeFile } from "./sessionTapeFile";
import { hashSessionTapeWorkspaceId } from "./sessionTapeRecorder";

/** Refusal of sends, resumes, history changes and provider model creation in replay mode. */
export const SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE =
  "Session tape replay mode (XUM_REPLAY_TAPES) is read-only: sending, history changes and model calls are disabled.";

/** Whether this process is in session tape replay mode (any non-blank XUM_REPLAY_TAPES). */
export function isSessionTapeReplayMode(): boolean {
  return isSessionTapeReplayConfigured(process.env);
}

/** Workspace id -> absolute tape path, or why that entry cannot be used. */
type ReplayTapeMap = ReadonlyMap<string, string | Error>;

/** Parsed once per distinct env value (in practice once per process). */
let cachedConfig: { raw: string; map: ReplayTapeMap | Error } | undefined;

/**
 * UNC and device paths (`\\server\share`, `//server/share`, `\\?\UNC\...`) open network
 * shares on Windows: stat/read would be SMB egress (and could send the user's credentials).
 */
function isNetworkPath(tapePath: string): boolean {
  return /^[\\/]{2}/.test(tapePath);
}

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
  for (const [rawWorkspaceId, tapePath] of Object.entries(parsed)) {
    // Keys and lookups use the trimmed id the session layer resolves, so a padded id cannot
    // miss its mapping and reach the workspace's live session.
    const workspaceId = rawWorkspaceId.trim();
    // A bad entry still names its workspace: refuse only that one, not the whole map.
    map.set(
      workspaceId,
      typeof tapePath === "string" && path.isAbsolute(tapePath) && !isNetworkPath(tapePath)
        ? tapePath
        : new Error(
            `XUM_REPLAY_TAPES: the tape path for ${workspaceId} must be an absolute local path`
          )
    );
  }
  return map;
}

function readReplayTapeMap(): ReplayTapeMap | Error | undefined {
  if (!isSessionTapeReplayMode()) return undefined;
  const raw = resolveXumEnvironmentValue("REPLAY_TAPES", process.env) ?? "";
  if (cachedConfig?.raw !== raw) cachedConfig = { raw, map: parseReplayTapeMap(raw) };
  return cachedConfig.map;
}

export interface SessionTapeReplay {
  /**
   * Validate the whole tape, then push its events at their recorded offsets and wait for the
   * abort. Rejects with an ORPCError carrying `SESSION_TAPE_REPLAY_REFUSAL_DATA` (message shown
   * by the client) when the replay cannot be served.
   */
  play(push: (event: WorkspaceChatMessage) => void, signal?: AbortSignal): Promise<void>;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  // Without a signal nothing could end the wait (the router always passes one).
  if (signal === undefined || signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}

function refuseReplay(workspaceId: string, message: string): never {
  log.warn("Session tape replay refused", { workspaceId, error: message });
  throw new ORPCError("PRECONDITION_FAILED", { message, data: SESSION_TAPE_REPLAY_REFUSAL_DATA });
}

/** Why this subscription cannot be served before reading the tape, if anything. */
function getUpfrontRefusal(
  entry: string | Error,
  mode: OnChatMode | undefined
): string | undefined {
  if (entry instanceof Error) return entry.message;
  if (!isSessionTapeReplayEgressBlocked())
    return "session tape replay requires the desktop app's egress block";
  if (mode !== undefined && mode.type !== "full") {
    return `Session tape replay serves only fresh full subscriptions (got "${mode.type}"); reload to replay the tape again`;
  }
  return undefined;
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
  const workspaceId = input.workspaceId.trim();
  const entry = map instanceof Error ? map : map.get(workspaceId);
  if (entry === undefined) return undefined;

  return {
    play: async (push, signal) => {
      // Checked when playback starts, so the error surfaces from the subscription's iterator.
      const refusal = getUpfrontRefusal(entry, input.mode);
      if (refusal !== undefined || entry instanceof Error) {
        refuseReplay(workspaceId, refusal ?? "no tape mapped");
      }
      // Truncated tapes load (flagged) so the refusal can say why replay will not serve them.
      const result = await readSessionTapeFile(entry, { allowTruncated: true });
      if (result.status === "rejected") {
        const where = result.line === undefined ? "" : ` (line ${result.line})`;
        refuseReplay(workspaceId, `Session tape ${entry} rejected: ${result.reason}${where}`);
      }
      if (result.status === "truncated") {
        refuseReplay(
          workspaceId,
          `Session tape ${entry} is truncated (size cap hit): replay serves only gap-free tapes`
        );
      }
      // A path mix-up would otherwise render another session's transcript (history rows do
      // not carry a workspace id).
      if (result.header.workspaceIdHash !== hashSessionTapeWorkspaceId(workspaceId)) {
        refuseReplay(workspaceId, `Session tape ${entry} was recorded for another workspace`);
      }
      // A full replay hydrates on its one caught-up. A tape finalized before it (switched away
      // or saved while history was loading) would leave the renderer hydrating forever, and a
      // failed history read makes the renderer retry the same tape without end.
      const caughtUp = result.events.filter(({ event }) => event.type === "caught-up");
      if (
        caughtUp.length !== 1 ||
        caughtUp[0].event.type !== "caught-up" ||
        caughtUp[0].event.historyReplayStatus !== "complete"
      ) {
        refuseReplay(
          workspaceId,
          `Session tape ${entry} has no single successful caught-up: it did not record a complete history replay`
        );
      }
      for await (const event of replaySessionTape(result, { pacing: "recorded", signal })) {
        // Windowed recordings can say (or, when the flag is absent, let the client infer) that
        // older history exists; paging it in would load the live workspace's chat.jsonl, not
        // the tape. An explicit false keeps the replay to the recorded window.
        push(event.type === "caught-up" ? { ...event, hasOlderHistory: false } : event);
      }
      // Stay open until the client aborts, so the renderer does not resubscribe and replay.
      await waitForAbort(signal);
    },
  };
}
