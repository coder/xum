import type { SwitchMilestones } from "./pageMilestones";

/**
 * Chat-switch perf records (#4504) and their aggregation. Shared by perf.chatSwitch.spec.ts
 * (writes `chatSwitch` into perf-summary.json) and scripts/perf/chatSwitchTable.ts (prints the
 * before/after markdown table from any number of those files).
 */

export const CHAT_SWITCH_LEGS = [
  "cold-open-small",
  "cold-open-large",
  "cold-open-xl",
  "switch-back-small",
  "switch-back-large",
  "switch-back-xl",
] as const;
export type ChatSwitchLeg = (typeof CHAT_SWITCH_LEGS)[number];

/**
 * Which window measured the switch (#4846): the desktop's local window (in-process backend) or
 * a desktop window connected to a running `xum server` over its WebSocket.
 */
export const CHAT_SWITCH_TRANSPORTS = ["in-process", "server-window"] as const;
export type ChatSwitchTransport = (typeof CHAT_SWITCH_TRANSPORTS)[number];

/** Renderer User Timing (xum:chat-switch:*), ms from WorkspaceStore.setActiveWorkspaceId. */
export interface ChatSwitchRendererTimings {
  /** ms from the row click until setActiveWorkspaceId marked the switch start. */
  clickToStartMs: number | null;
  skeletonShownMs: number | null;
  skeletonHiddenMs: number | null;
  firstRowMs: number | null;
  caughtUpMs: number | null;
  caughtUpReplay: string | null;
}

/** One `onChat replay` server log line (see src/node/services/onChatReplayTiming.ts). */
export interface ChatSwitchServerReplay {
  workspaceId: string;
  requestedMode?: string;
  replayMode?: string;
  downgradeReason?: string;
  epochRowCount?: number;
  sentRowCount?: number;
  historyBytesRead?: number;
  streamReplayed?: boolean;
  historyReplayStatus?: string;
  totalMs: number;
  phasesMs: Record<string, number>;
}

export interface ChatSwitchRecord {
  index: number;
  leg: ChatSwitchLeg;
  /** Missing in runs recorded before #4846; read those as in-process. */
  transport?: ChatSwitchTransport;
  workspaceId: string;
  historyProfile: string;
  /** Round (workspace pair) this switch belongs to. */
  round: number;
  /** Whether the target chat was streaming (per the sidebar) when the user switched to it. */
  targetMidStream: boolean;
  renderer: ChatSwitchRendererTimings;
  dom: SwitchMilestones;
  server: ChatSwitchServerReplay[];
}

type ChatSwitchMediansByLeg = Partial<Record<ChatSwitchLeg, ChatSwitchLegMedians>>;

export interface ChatSwitchPerfSummary {
  switches: ChatSwitchRecord[];
  /** In-process medians only, the same shape as before #4846 so nightly compares need no shim. */
  medians: ChatSwitchMediansByLeg;
  mediansByTransport: Partial<Record<ChatSwitchTransport, ChatSwitchMediansByLeg>>;
}

export type ChatSwitchLegMedians = Record<string, number | null> & { count: number };

function median(values: readonly (number | null | undefined)[]): number | null {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/** Flatten a record into the metric columns reported in tables. */
function metricsOf(record: ChatSwitchRecord): Record<string, number | null> {
  // A switch normally produces exactly one replay; sum if a retry produced more.
  const server = record.server;
  const sum = (pick: (replay: ChatSwitchServerReplay) => number | undefined) =>
    server.length === 0 ? null : server.reduce((total, replay) => total + (pick(replay) ?? 0), 0);
  const phaseNames = new Set(server.flatMap((replay) => Object.keys(replay.phasesMs)));
  const phases: Record<string, number | null> = {};
  for (const phase of phaseNames) {
    phases[`server.${phase}Ms`] = sum((replay) => replay.phasesMs[phase]);
  }
  return {
    "renderer.clickToStartMs": record.renderer.clickToStartMs,
    "renderer.skeletonShownMs": record.renderer.skeletonShownMs,
    "renderer.skeletonHiddenMs": record.renderer.skeletonHiddenMs,
    "renderer.firstRowMs": record.renderer.firstRowMs,
    "renderer.caughtUpMs": record.renderer.caughtUpMs,
    "dom.firstRowFromClickMs": record.dom.firstRowMs,
    "dom.skeletonHiddenFromClickMs": record.dom.skeletonHiddenMs,
    "dom.longestTaskMs": record.dom.longestTaskMs,
    "server.totalMs": sum((replay) => replay.totalMs),
    ...phases,
    "server.sentRowCount": sum((replay) => replay.sentRowCount),
    "server.epochRowCount": sum((replay) => replay.epochRowCount),
    "server.historyBytesRead": sum((replay) => replay.historyBytesRead),
  };
}

function transportOf(record: ChatSwitchRecord): ChatSwitchTransport {
  return record.transport ?? "in-process";
}

function mediansByLeg(records: readonly ChatSwitchRecord[]): ChatSwitchMediansByLeg {
  const result: ChatSwitchMediansByLeg = {};
  for (const leg of CHAT_SWITCH_LEGS) {
    const legMetrics = records.filter((record) => record.leg === leg).map(metricsOf);
    if (legMetrics.length === 0) continue;
    const names = new Set(legMetrics.flatMap((metrics) => Object.keys(metrics)));
    const medians: ChatSwitchLegMedians = { count: legMetrics.length };
    for (const name of names) {
      medians[name] = median(legMetrics.map((metrics) => metrics[name]));
    }
    result[leg] = medians;
  }
  return result;
}

export function summarizeChatSwitches(
  records: readonly ChatSwitchRecord[]
): Pick<ChatSwitchPerfSummary, "medians" | "mediansByTransport"> {
  const mediansByTransport: ChatSwitchPerfSummary["mediansByTransport"] = {};
  for (const transport of CHAT_SWITCH_TRANSPORTS) {
    const transportRecords = records.filter((record) => transportOf(record) === transport);
    if (transportRecords.length > 0) mediansByTransport[transport] = mediansByLeg(transportRecords);
  }
  return { medians: mediansByTransport["in-process"] ?? {}, mediansByTransport };
}

/**
 * Markdown table: one row per metric, one column per leg × transport (medians over all
 * records), so each leg's in-process and server-window columns sit side by side.
 */
export function renderChatSwitchMarkdownTable(records: readonly ChatSwitchRecord[]): string {
  const { mediansByTransport } = summarizeChatSwitches(records);
  const columns = CHAT_SWITCH_LEGS.flatMap((leg) =>
    CHAT_SWITCH_TRANSPORTS.flatMap((transport) => {
      const medians = mediansByTransport[transport]?.[leg];
      return medians ? [{ label: `${leg} · ${transport}`, medians }] : [];
    })
  );
  const metricNames = [...new Set(columns.flatMap((column) => Object.keys(column.medians)))];
  const format = (value: number | null | undefined) => (value == null ? "–" : String(value));
  const lines = [
    `| metric (median) | ${columns.map((column) => column.label).join(" | ")} |`,
    `| --- | ${columns.map(() => "---:").join(" | ")} |`,
    ...metricNames.map(
      (name) => `| ${name} | ${columns.map((column) => format(column.medians[name])).join(" | ")} |`
    ),
  ];
  return lines.join("\n");
}
