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
 * - Only fresh full subscriptions are served (no resumable replay). `since`/`live`, a missing
 *   `XUM_MOCK_AI=1`, an unreadable or rejected tape (see the loader) fail the subscription with
 *   a clear error. There is never a fallback to the live session.
 * - Events play at their recorded offsets; the subscription then stays open until the client
 *   aborts, so the renderer does not resubscribe and replay the tape again.
 * Unmapped workspaces take the normal path. An unparseable `XUM_REPLAY_TAPES` cannot tell which
 * workspaces are mapped, so it fails every onChat subscription rather than silently going live.
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
import { replaySessionTape } from "@/common/utils/sessionTapes/sessionTapeReplay";
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

type ReplayTapeMap = ReadonlyMap<string, string>;

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
  const map = new Map<string, string>();
  for (const [workspaceId, tapePath] of Object.entries(parsed)) {
    if (typeof tapePath !== "string" || !path.isAbsolute(tapePath)) {
      return new Error(`XUM_REPLAY_TAPES: the tape path for ${workspaceId} must be absolute`);
    }
    map.set(workspaceId, tapePath);
  }
  return map;
}

function readReplayTapeMap(): ReplayTapeMap | Error | undefined {
  const raw = resolveXumEnvironmentValue("REPLAY_TAPES", process.env);
  if (raw === undefined || raw.trim() === "") return undefined;
  if (cachedConfig?.raw !== raw) cachedConfig = { raw, map: parseReplayTapeMap(raw) };
  return cachedConfig.map;
}

export interface SessionTapeReplay {
  /**
   * Validate the whole tape, then push its events at their recorded offsets. Rejects with an
   * ORPCError (message visible to the client) when the replay cannot be served; resolves after
   * the last event or on abort.
   */
  play(push: (event: WorkspaceChatMessage) => void, signal?: AbortSignal): Promise<void>;
}

function refuseReplay(workspaceId: string, message: string): never {
  log.warn("Session tape replay refused", { workspaceId, error: message });
  throw new ORPCError("PRECONDITION_FAILED", { message });
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
  const tapePath = map instanceof Error ? undefined : map.get(workspaceId);
  if (!(map instanceof Error) && tapePath === undefined) return undefined;

  // Checked when playback starts, so the error surfaces from the subscription's iterator.
  let refusal: string | undefined;
  if (map instanceof Error) {
    refusal = map.message;
  } else if (resolveXumEnvironmentValue("MOCK_AI", process.env) !== "1") {
    // Extra guard: only mock-AI harness runs may replace a workspace's chat with a tape.
    refusal = "XUM_REPLAY_TAPES requires XUM_MOCK_AI=1";
  } else if (input.mode !== undefined && input.mode.type !== "full") {
    // A since/live subscription resumes client state the tape cannot continue.
    refusal = `Session tape replay serves only full subscriptions (got "${input.mode.type}")`;
  }

  return {
    play: async (push, signal) => {
      if (refusal !== undefined || tapePath === undefined) {
        refuseReplay(workspaceId, refusal ?? "no tape mapped");
      }
      const result = await readSessionTapeFile(tapePath);
      if (result.status === "rejected") {
        const where = result.line === undefined ? "" : ` (line ${result.line})`;
        refuseReplay(workspaceId, `Session tape ${tapePath} rejected: ${result.reason}${where}`);
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
