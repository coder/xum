import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { HeartbeatToolCall } from "@/browser/features/Tools/HeartbeatToolCall";

// Isolated previews of the heartbeat tool-call card — one cell per story in
// HeartbeatToolCall.stories.tsx, named to match the story exports so compare pairs them,
// rendered with the same inline args/result/status. Hand-authored (not generated) because
// the stories import meta.tsx → the whole app graph, which is over the bundle cap (see
// .design-sync/NOTES.md "UI primitives / previews").

const TASK_PROMPT =
  "Check the CI run for the auth refactor. If it's green, open the PR; if it's red, " +
  "summarize the first failure and stop.";
const DEFAULT_BODY =
  "Check in on the current state of this workspace — review any pending work, check for stale " +
  "context, and determine if any action is needed. If everything looks good, briefly confirm the " +
  "workspace status.";

// Mirrors the stories' decorator chain (theme + tooltip provider, dark background, max-w-2xl).
// `width` reproduces a story-level narrow wrapper (CustomMessageWrapping renders at 375px).
const Shell = (props: { width?: string; children: React.ReactNode }) => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        {props.width ? <div style={{ width: props.width }}>{props.children}</div> : props.children}
      </div>
    </div>
  </MuxPreviewShell>
);

export const ScheduledEnabled = () => (
  <Shell>
    <HeartbeatToolCall
      args={{
        action: "set",
        enabled: true,
        intervalMs: 30 * 60_000,
        contextMode: "normal",
        message: TASK_PROMPT,
      }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "set",
        configured: true,
        settings: {
          enabled: true,
          intervalMs: 30 * 60_000,
          contextMode: "normal",
          message: TASK_PROMPT,
        },
        summary: "Heartbeat is enabled for this workspace at 30 minutes.",
      }}
    />
  </Shell>
);

export const CustomMessageWrapping = () => (
  <Shell width="375px">
    <HeartbeatToolCall
      args={{ action: "set", enabled: true, intervalMs: 1_800_000 }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "set",
        configured: true,
        settings: {
          enabled: true,
          intervalMs: 1_800_000,
          contextMode: "normal",
          message:
            "Poll the deploy and report status.\n" +
            "Logs: https://ci.example.com/runs/0123456789abcdef0123456789abcdef/jobs/deploy-prod-us-east-1/raw?download=true\n" +
            "If it failed, summarize the first error and stop.",
        },
        summary: "Heartbeat is enabled for this workspace at 30 minutes.",
      }}
    />
  </Shell>
);

export const LongCadenceCompact = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "set", enabled: true, intervalMs: 2 * 3_600_000, contextMode: "compact" }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "set",
        configured: true,
        settings: { enabled: true, intervalMs: 2 * 3_600_000, contextMode: "compact" },
        summary: "Heartbeat is enabled for this workspace at 2 hours.",
      }}
    />
  </Shell>
);

export const ReadReset = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "get" }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "get",
        configured: true,
        settings: {
          enabled: true,
          intervalMs: 3_600_000,
          contextMode: "reset",
          message: DEFAULT_BODY,
        },
        summary: "Heartbeat is enabled for this workspace at 1 hour.",
      }}
    />
  </Shell>
);

export const Paused = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "set", enabled: false }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "set",
        configured: true,
        settings: {
          enabled: false,
          intervalMs: 30 * 60_000,
          contextMode: "normal",
          message: DEFAULT_BODY,
        },
        summary: "Heartbeat is disabled for this workspace at 30 minutes.",
      }}
    />
  </Shell>
);

export const ReadNotConfigured = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "get" }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "get",
        configured: false,
        settings: null,
        summary: "No heartbeat settings are configured for this workspace.",
      }}
    />
  </Shell>
);

export const Cleared = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "unset" }}
      status="completed"
      defaultExpanded
      result={{
        success: true,
        action: "unset",
        configured: false,
        settings: null,
        summary: "Heartbeat settings removed for this workspace.",
      }}
    />
  </Shell>
);

export const Executing = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "set", enabled: true, intervalMs: 30 * 60_000 }}
      status="executing"
      defaultExpanded
    />
  </Shell>
);

export const ErrorResult = () => (
  <Shell>
    <HeartbeatToolCall
      args={{ action: "set", enabled: true, intervalMs: 30 * 60_000 }}
      status="failed"
      defaultExpanded
      result={{
        success: false,
        error: "Failed to update heartbeat settings: workspace configuration is unavailable.",
      }}
    />
  </Shell>
);

export const Interrupted = () => (
  <Shell>
    <HeartbeatToolCall
      args={{
        action: "set",
        enabled: true,
        intervalMs: 2 * 3_600_000,
        contextMode: "compact",
        message: "Watch the long-running migration and report when it finishes.",
      }}
      status="interrupted"
      defaultExpanded
    />
  </Shell>
);
