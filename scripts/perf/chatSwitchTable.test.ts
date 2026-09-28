import { describe, expect, test } from "bun:test";
import {
  renderChatSwitchMarkdownTable,
  summarizeChatSwitches,
  type ChatSwitchLeg,
  type ChatSwitchRecord,
  type ChatSwitchTransport,
} from "../../tests/e2e/utils/chatSwitchSummary";
import { parseHistoryProfilesFromEnv } from "../../tests/e2e/utils/historyFixture";

function record(
  leg: ChatSwitchLeg,
  caughtUpMs: number,
  transport?: ChatSwitchTransport
): ChatSwitchRecord {
  return {
    index: 0,
    leg,
    ...(transport ? { transport } : {}),
    workspaceId: "ws",
    historyProfile: "small",
    round: 0,
    targetMidStream: false,
    renderer: {
      clickToStartMs: null,
      skeletonShownMs: null,
      skeletonHiddenMs: null,
      firstRowMs: null,
      caughtUpMs,
      caughtUpReplay: null,
    },
    dom: {} as ChatSwitchRecord["dom"],
    server: [],
  };
}

describe("chat-switch summary by transport", () => {
  const records = [
    record("switch-back-large", 100),
    record("switch-back-large", 300, "in-process"),
    record("switch-back-large", 1_000, "server-window"),
    record("switch-back-large", 3_000, "server-window"),
  ];

  test("keeps in-process medians in the legacy shape and splits server-window medians", () => {
    const summary = summarizeChatSwitches(records);
    // Records without a transport (pre-#4846 runs) count as in-process.
    expect(summary.medians["switch-back-large"]?.["renderer.caughtUpMs"]).toBe(200);
    expect(summary.medians["switch-back-large"]?.count).toBe(2);
    expect(summary.mediansByTransport["in-process"]).toEqual(summary.medians);
    expect(
      summary.mediansByTransport["server-window"]?.["switch-back-large"]?.["renderer.caughtUpMs"]
    ).toBe(2_000);
  });

  test("renders one column per leg and transport", () => {
    const [header, , ...rows] = renderChatSwitchMarkdownTable(records).split("\n");
    expect(header).toBe(
      "| metric (median) | switch-back-large · in-process | switch-back-large · server-window |"
    );
    expect(rows.find((row) => row.startsWith("| renderer.caughtUpMs |"))).toBe(
      "| renderer.caughtUpMs | 200 | 2000 |"
    );
  });

  test("an in-process-only run has no server-window column or medians", () => {
    const inProcessOnly = records.slice(0, 2);
    expect(
      summarizeChatSwitches(inProcessOnly).mediansByTransport["server-window"]
    ).toBeUndefined();
    expect(renderChatSwitchMarkdownTable(inProcessOnly)).not.toContain("server-window");
  });
});

describe("history profiles", () => {
  test("the xl profile is opt-in: the default list skips it, an explicit request accepts it", () => {
    expect(parseHistoryProfilesFromEnv(undefined)).not.toContain("xl");
    expect(parseHistoryProfilesFromEnv("large,xl")).toEqual(["large", "xl"]);
  });
});
