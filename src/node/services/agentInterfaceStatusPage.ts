import {
  AGENT_INTERFACE_STATUS_ARTIFACT,
  ARTIFACT_THEME_VARIABLES,
} from "@/common/constants/artifacts";
import type { ArtifactsLocation } from "./artifactsOperations";
import { writeArtifactAtLocation } from "./artifactsOperations";
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
  the chat transcript. Replace the placeholder with your status, progress and results, and edit
  this file in place to keep it current.
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

/**
 * At turn start: whether the Agent interface view is active this turn (both flags on, neither a
 * side chat nor a compaction, and XUM_SCRATCH_DIR set, so the agent can edit what was seeded),
 * seeding the status page first when it is active and the page does not exist yet. Side chats
 * keep their transcript: they cannot write files, and on narrow layouts they fill the main pane.
 * A compaction must answer with a tool-free summary (builtinAgents/compact.md), which guidance to
 * edit the page would contaminate. Never overwrites (the agent owns the page once it exists) and
 * never throws: a failed seed is logged and the turn goes on.
 */
export async function prepareAgentInterfaceStatusPage(args: {
  scratchDirSet: boolean;
  artifactsEnabled: boolean;
  agentInterfaceEnabled: boolean;
  sideChat: boolean;
  compactionRequest: boolean;
  resolveLocation: () => Promise<ArtifactsLocation>;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const active =
    args.scratchDirSet &&
    args.artifactsEnabled &&
    args.agentInterfaceEnabled &&
    !args.sideChat &&
    !args.compactionRequest;
  if (active) await seedStatusPage(args.resolveLocation, args.abortSignal);
  return active;
}

async function seedStatusPage(
  resolveLocation: () => Promise<ArtifactsLocation>,
  abortSignal: AbortSignal | undefined
): Promise<void> {
  try {
    const location = await resolveLocation();
    if (location.kind === "unavailable") return;
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
