import type { SwitchMilestones } from "./pageMilestones";

/**
 * Chat-switch perf records (#4504) and their aggregation. Shared by perf.chatSwitch.spec.ts
 * (writes `chatSwitch` into perf-summary.json) and scripts/perf/chatSwitchTable.ts (prints the
 * before/after markdown table from any number of those files).
 */

export const CHAT_SWITCH_LEGS = [
  "cold-open-small",
  "cold-open-large",
  "switch-back-small",
  "switch-back-large",
] as const;
export type ChatSwitchLeg = (typeof CHAT_SWITCH_LEGS)[number];

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

export interface ChatSwitchPerfSummary {
  switches: ChatSwitchRecord[];
  medians: Partial<Record<ChatSwitchLeg, ChatSwitchLegMedians>>;
}

export type ChatSwitchLegMedians = Record<string, number | null> & { count: number };

function median(values: ReadonlyArray<number | null | undefined>): number | null {
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

export function summarizeChatSwitches(
  records: readonly ChatSwitchRecord[]
): Partial<Record<ChatSwitchLeg, ChatSwitchLegMedians>> {
  const result: Partial<Record<ChatSwitchLeg, ChatSwitchLegMedians>> = {};
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

/** Markdown table: one row per metric, one column per leg (medians over all records). */
export function renderChatSwitchMarkdownTable(records: readonly ChatSwitchRecord[]): string {
  const summary = summarizeChatSwitches(records);
  const legs = CHAT_SWITCH_LEGS.filter((leg) => summary[leg] !== undefined);
  const metricNames = [...new Set(legs.flatMap((leg) => Object.keys(summary[leg] ?? {})))];
  const format = (value: number | null | undefined) => (value == null ? "–" : String(value));
  const lines = [
    `| metric (median) | ${legs.join(" | ")} |`,
    `| --- | ${legs.map(() => "---:").join(" | ")} |`,
    ...metricNames.map(
      (name) => `| ${name} | ${legs.map((leg) => format(summary[leg]?.[name])).join(" | ")} |`
    ),
  ];
  return lines.join("\n");
}
