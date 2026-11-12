import { describe, expect, test } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import {
  BACKGROUND_WORK_WAKE_OPENINGS,
  LAYOUT_TURN_END_NUDGE,
  STATUS_PAGE_TURN_END_NUDGE,
  TODO_TURN_END_NUDGE,
  TURN_END_NUDGE_SEPARATOR,
} from "@/common/utils/machineTurnPrompts";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { isMachineRow } from "./machineRows";

type UserRow = DisplayedMessage & { type: "user" };

function prompt(content: string, fields: Partial<UserRow> = {}): UserRow {
  return {
    type: "user",
    id: "row",
    historyId: "history-row",
    content,
    historySequence: 1,
    isSynthetic: true,
    ...fields,
  };
}

const REPORT = formatSubagentReportEnvelope({
  taskId: "task-1",
  agentType: "explore",
  status: "completed",
  title: "Done",
  reportMarkdown: "Body",
});

describe("isMachineRow", () => {
  // Each of these gets a machine presentation from the renderer, so each folds with the work.
  test.each([
    [
      "a wake-up for finished sub-agents",
      `${BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted} Go on.`,
    ],
    ["the TODO nudge", TODO_TURN_END_NUDGE],
    ["the status page nudge", STATUS_PAGE_TURN_END_NUDGE],
    ["the layout nudge", LAYOUT_TURN_END_NUDGE],
    [
      "nudges joined into one continuation",
      [TODO_TURN_END_NUDGE, LAYOUT_TURN_END_NUDGE].join(TURN_END_NUDGE_SEPARATOR),
    ],
    ["a sub-agent's report", REPORT],
  ])("treats %s as a step of the work", (_name, content) => {
    expect(isMachineRow(prompt(content))).toBe(true);
  });

  test("only counts a prompt the backend wrote", () => {
    // A user who types or pastes the same text keeps their bubble.
    expect(isMachineRow(prompt(TODO_TURN_END_NUDGE, { isSynthetic: false }))).toBe(false);
    expect(isMachineRow(prompt(REPORT, { isSynthetic: undefined }))).toBe(false);
    // Any other synthetic prompt starts a turn the way a typed one does.
    expect(isMachineRow(prompt("Continue working toward the goal."))).toBe(false);
    expect(isMachineRow(undefined)).toBe(false);
  });

  test("counts rows the aggregator marked, whatever they say", () => {
    const warning = prompt("anything", {
      isSynthetic: false,
      contextBudgetWarning: { contextTokens: 800, maxTokens: 1000, final: false, handoff: false },
    });
    expect(isMachineRow(warning)).toBe(true);
  });
});
