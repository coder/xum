import {
  AGENT_INTERFACE_STATUS_ARTIFACT,
  ARTIFACT_THEME_VARIABLES,
} from "@/common/constants/artifacts";
import { createHash } from "node:crypto";
import type { CompletedMessagePart } from "@/common/types/stream";
import type { ArtifactsLocation, AvailableArtifactsLocation } from "./artifactsOperations";
import { readArtifactBytesAtLocation, writeArtifactAtLocation } from "./artifactsOperations";
import { isSuccessfulToolResult } from "./aiServiceEventGuards";
import { log } from "./log";

const THEME_VARIABLE_NAMES = Object.keys(ARTIFACT_THEME_VARIABLES)
  .map((key) => `--xum-${key}`)
  .join(", ");

/**
 * The status page the host seeds for the Agent interface view (artifacts-agent-interface). It is
 * self-contained (no network), follows the Xum theme through the `--xum-*` variables the
 * artifact bridge sets, and falls back to its own palette outside Xum.
 */
export const AGENT_INTERFACE_STATUS_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent status</title>
<!--
  Xum seeded this page for the Agent interface view: the user sees it in the main pane instead of
  the chat transcript. Replace the placeholder now, before long-running steps, with your status,
  plan and progress. Edit this file in place at each milestone, and before you end a turn make it
  show the results and anything that waits on the user.
  Theme variables Xum sets on the root element (always give a fallback):
  ${THEME_VARIABLE_NAMES}.
  The root element also carries data-xum-theme (light or dark) and data-xum-theme-name
  (light, dark, flexoki-light or flexoki-dark).
-->
<style>
  :root {
    color-scheme: light dark;
    --fallback-bg: #ffffff;
    --fallback-bg-secondary: #f4f6f8;
    --fallback-fg: #1f2328;
    --fallback-muted: #656d76;
    --fallback-border: #d0d7de;
    --fallback-accent: #0969da;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fallback-bg: #1e1e1e;
      --fallback-bg-secondary: #252526;
      --fallback-fg: #e6e6e6;
      --fallback-muted: #9da5b4;
      --fallback-border: #3c3c3c;
      --fallback-accent: #4aa3ff;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    min-height: 100%;
    background: var(--xum-surface, var(--fallback-bg));
    color: var(--xum-fg, var(--fallback-fg));
    font-family: var(--xum-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: 14px;
    line-height: 1.5;
  }
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  h1 {
    margin: 0 0 16px;
    padding-bottom: 8px;
    font-size: 20px;
    font-weight: 600;
    border-bottom: 1px solid var(--xum-border, var(--fallback-border));
  }
  .card {
    padding: 12px 16px;
    background: var(--xum-bg-secondary, var(--fallback-bg-secondary));
    border: 1px solid var(--xum-border, var(--fallback-border));
    border-left: 3px solid var(--xum-accent, var(--fallback-accent));
    border-radius: var(--xum-radius, 6px);
    color: var(--xum-muted, var(--fallback-muted));
    overflow-wrap: anywhere;
  }
</style>
</head>
<body>
<main>
  <h1>Agent status</h1>
  <p class="card">Waiting for the agent to publish its status.</p>
</main>
</body>
</html>
`;

/** Bigger pages are fingerprinted by their size instead of their bytes. */
const STATUS_PAGE_SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** The turn-end read runs after the stream ended, outside its abort signal. */
const STATUS_PAGE_TURN_END_READ_TIMEOUT_MS = 10_000;

/** The view's state for one turn, kept from turn start to turn end for the status page nudge. */
export interface AgentInterfaceStatusPageTurn {
  resolveLocation: (abortSignal?: AbortSignal) => Promise<ArtifactsLocation>;
  /** The page's fingerprint after seeding, or null when it could not be read. */
  startFingerprint: string | null;
}

/**
 * At turn start: the Agent interface view's turn state when the view is active this turn (both
 * flags on, neither a side chat nor a compaction, and XUM_SCRATCH_DIR set, so the agent can edit
 * what was seeded), or null when it is not. When active, the status page is seeded first if it
 * does not exist yet, then fingerprinted. Side chats keep their transcript: they cannot write
 * files, and on narrow layouts they fill the main pane. A compaction must answer with a tool-free
 * summary (builtinAgents/compact.md), which guidance to edit the page would contaminate. Never
 * overwrites (the agent owns the page once it exists) and never throws: a failed seed or read is
 * logged and the turn goes on.
 */
export async function prepareAgentInterfaceStatusPage(args: {
  scratchDirSet: boolean;
  artifactsEnabled: boolean;
  agentInterfaceEnabled: boolean;
  sideChat: boolean;
  compactionRequest: boolean;
  resolveLocation: (abortSignal?: AbortSignal) => Promise<ArtifactsLocation>;
  abortSignal?: AbortSignal;
}): Promise<AgentInterfaceStatusPageTurn | null> {
  const active =
    args.scratchDirSet &&
    args.artifactsEnabled &&
    args.agentInterfaceEnabled &&
    !args.sideChat &&
    !args.compactionRequest;
  if (!active) return null;
  const location = await resolveStatusPageLocation(args.resolveLocation, args.abortSignal);
  if (location != null) await seedStatusPage(location, args.abortSignal);
  const page = location == null ? null : await readStatusPage(location, args.abortSignal);
  return {
    resolveLocation: args.resolveLocation,
    startFingerprint: page?.kind === "page" ? page.fingerprint : null,
  };
}

/**
 * At turn end: whether the status page the user sees needs the turn-end nudge. True when the page
 * is missing (it is seeded again) or still the seeded placeholder, or when the turn made a
 * successful tool call (it did work) and left the page as it was at turn start. False when the
 * view was inactive this turn, and when the page cannot be read or is not a regular file: a nudge
 * must never rest on a guess.
 */
export async function needsStatusPageTurnEndNudge(input: {
  turn: AgentInterfaceStatusPageTurn | undefined;
  parts: readonly CompletedMessagePart[];
}): Promise<boolean> {
  if (input.turn == null) return false;
  const abortSignal = AbortSignal.timeout(STATUS_PAGE_TURN_END_READ_TIMEOUT_MS);
  const location = await resolveStatusPageLocation(input.turn.resolveLocation, abortSignal);
  if (location == null) return false;
  let page = await readStatusPage(location, abortSignal);
  if (page.kind === "missing") {
    // Seed it again so the nudge's in-place edit has a page to edit. A folder, symlink or other
    // non-regular file at the path also reads as missing, but the createOnly seed leaves it, so
    // it still reads as missing below and gets no nudge.
    await seedStatusPage(location, abortSignal);
    page = await readStatusPage(location, abortSignal);
  }
  if (page.kind !== "page") return false;
  return (
    page.placeholder ||
    (page.fingerprint === input.turn.startFingerprint && madeSuccessfulToolCall(input.parts))
  );
}

function isSuccessfulToolCall(call: { state: string; output?: unknown }): boolean {
  return call.state === "output-available" && isSuccessfulToolResult(call.output);
}

function madeSuccessfulToolCall(parts: readonly CompletedMessagePart[]): boolean {
  return parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      (isSuccessfulToolCall(part) ||
        // Programmatic tool calling runs tools inside code_execution.
        part.nestedCalls?.some(isSuccessfulToolCall) === true)
  );
}

async function resolveStatusPageLocation(
  resolveLocation: (abortSignal?: AbortSignal) => Promise<ArtifactsLocation>,
  abortSignal: AbortSignal | undefined
): Promise<AvailableArtifactsLocation | null> {
  try {
    const location = await resolveLocation(abortSignal);
    if (location.kind !== "unavailable") return location;
    log.debug("The agent interface status page has no artifacts location", {
      reason: location.reason,
    });
  } catch (error) {
    log.debug("Resolving the agent interface status page location failed", { error });
  }
  return null;
}

async function seedStatusPage(
  location: AvailableArtifactsLocation,
  abortSignal: AbortSignal | undefined
): Promise<void> {
  try {
    // createOnly: a page that exists, or that the agent writes meanwhile, is left as it is.
    await writeArtifactAtLocation(
      location,
      AGENT_INTERFACE_STATUS_ARTIFACT,
      AGENT_INTERFACE_STATUS_TEMPLATE,
      { createOnly: true, abortSignal }
    );
  } catch (error) {
    log.debug("Seeding the agent interface status page failed", { error });
  }
}

type StatusPageRead =
  | { kind: "page"; fingerprint: string; placeholder: boolean }
  | { kind: "missing" }
  | { kind: "unreadable" };

const TEMPLATE_BYTES = Buffer.from(AGENT_INTERFACE_STATUS_TEMPLATE, "utf8");

async function readStatusPage(
  location: AvailableArtifactsLocation,
  abortSignal: AbortSignal | undefined
): Promise<StatusPageRead> {
  try {
    const outcome = await readArtifactBytesAtLocation(
      location,
      AGENT_INTERFACE_STATUS_ARTIFACT,
      STATUS_PAGE_SNAPSHOT_MAX_BYTES,
      abortSignal
    );
    switch (outcome.status) {
      case "ok":
        return {
          kind: "page",
          fingerprint: createHash("sha256").update(outcome.bytes).digest("hex"),
          placeholder: outcome.bytes.equals(TEMPLATE_BYTES),
        };
      case "too_large":
        // Size only, not mtime: a touch must not count as an update at any size, as for hashed
        // pages. The tradeoff is that an edit that keeps an oversize page's size looks unchanged.
        return {
          kind: "page",
          fingerprint: `too-large:${outcome.size}`,
          placeholder: false,
        };
      case "missing":
        return { kind: "missing" };
      case "invalid":
        log.debug("The agent interface status page is not readable", { error: outcome.error });
        return { kind: "unreadable" };
    }
  } catch (error) {
    log.debug("Reading the agent interface status page failed", { error });
    return { kind: "unreadable" };
  }
}
