import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { electronTest, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv, setXumE2EEnv } from "../env";
import { MOCK_LONG_STREAM_PROMPT } from "../mockAiPrompts";
import {
  renderChatSwitchMarkdownTable,
  summarizeChatSwitches,
  type ChatSwitchLeg,
  type ChatSwitchRecord,
  type ChatSwitchRendererTimings,
  type ChatSwitchServerReplay,
} from "../utils/chatSwitchSummary";
import { addDemoWorkspace, type DemoProjectConfig } from "../utils/demoProject";
import {
  seedWorkspaceHistoryProfile,
  type SeededHistoryProfileSummary,
} from "../utils/historyFixture";
import { readSwitchMilestones, startSwitchMilestones } from "../utils/pageMilestones";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";
import {
  CHAT_SWITCH_MARK_PREFIX,
  CHAT_SWITCH_START_MARK,
} from "../../../src/browser/utils/perf/chatSwitchTiming";
import { ONCHAT_REPLAY_TIMING_LOG_MESSAGE } from "../../../src/node/services/onChatReplayTiming";

/**
 * Chat-switch latency scenario (#4504): leave a chat mid-stream, switch back, and record per
 * switch the renderer User Timing measures (xum:chat-switch:*), DOM timing from the sidebar
 * click, and the server's `onChat replay` phase log line.
 *
 * Each round uses a fresh pair of workspaces in one project: `small` history (A) and `large`
 * history (B). Round: cold-open A, start a long mock stream, cold-open B, start a stream,
 * switch back to A, switch back to B. XUM_E2E_CHAT_SWITCH_ROUNDS (default 3 → 6 switch-backs)
 * sets the round count; XUM_E2E_CHAT_SWITCH_DWELL_MS (default 1000) is how long a chat stays
 * open before the next switch so the one left behind falls behind its stream.
 *
 * Mock AI limitation (why a fresh pair per round): mock streams have no mid-stream replay
 * (MockAiStreamPlayer.replayStream is a no-op and StreamManager.getStreamInfo is undefined for
 * them). The server therefore replays the chat without its live stream (`streamReplayed:
 * false`) and the renderer then shows it as interrupted, so only the FIRST return after leaving
 * a chat mid-stream is representative. That return still exercises the since-mode replay and
 * the stale-transcript skeleton (#4505); the streamReplay phase needs a real provider.
 */

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";
const roundCount = Number(getXumE2EEnv("E2E_CHAT_SWITCH_ROUNDS") ?? "3");
const dwellMs = Number(getXumE2EEnv("E2E_CHAT_SWITCH_DWELL_MS") ?? "1000");
/** Generous: the point is to record the latency, not to gate on it. */
const CAUGHT_UP_BUDGET_MS = 15_000;

/**
 * Documented behavior before #4505: leaving a chat mid-stream marks its cached transcript
 * stale, so switching back shows the hydration skeleton until `caught-up`. #4505 (show cached
 * rows on incremental returns) should flip this to false.
 */
const EXPECT_SKELETON_ON_MID_STREAM_SWITCH_BACK = true;

interface SeededChat {
  config: DemoProjectConfig;
  profile: "small" | "large";
  history: SeededHistoryProfileSummary;
}

interface SeededRound {
  small: SeededChat;
  large: SeededChat;
}

// Set by the workspace fixture override below; every chat must exist before the app launches,
// and the app fixture depends only on `workspace`.
let seededRounds: SeededRound[] | undefined;

async function seedChat(
  workspace: { configRoot: string; demoProject: DemoProjectConfig },
  profile: "small" | "large",
  round: number
): Promise<SeededChat> {
  // Round 0's small chat is the fixture's demo workspace; the rest are added beside it.
  const config =
    profile === "small" && round === 0
      ? workspace.demoProject
      : addDemoWorkspace(workspace.configRoot, workspace.demoProject, `perf-${profile}-${round}`);
  const history = await seedWorkspaceHistoryProfile({ demoProject: config, profile });
  return { config, profile, history };
}

const test = electronTest.extend({
  workspace: async ({ workspace }, use) => {
    expect(Number.isInteger(roundCount) && roundCount > 0).toBe(true);
    const rounds: SeededRound[] = [];
    for (let round = 0; round < roundCount; round++) {
      rounds.push({
        small: await seedChat(workspace, "small", round),
        large: await seedChat(workspace, "large", round),
      });
    }
    seededRounds = rounds;

    // The per-replay server line logs at debug unless the replay is slow; the app fixture
    // copies process.env into the Electron environment, so set it before launch.
    const originalLogLevels = {
      XUM_LOG_LEVEL: process.env.XUM_LOG_LEVEL,
      MUX_LOG_LEVEL: process.env.MUX_LOG_LEVEL,
    };
    setXumE2EEnv(process.env, "LOG_LEVEL", "debug");
    try {
      await use(workspace);
    } finally {
      seededRounds = undefined;
      for (const [key, value] of Object.entries(originalLogLevels)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  },
});

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

/** Parses `onChat replay` lines from the backend log files, oldest first. */
function readServerReplays(logsDir: string, workspaceId: string): ChatSwitchServerReplay[] {
  if (!fs.existsSync(logsDir)) return [];
  // Rotation renames mux.log → mux.1.log → mux.2.log…; read oldest first.
  const logFiles = fs
    .readdirSync(logsDir)
    .filter((name) => /^mux(\.\d+)?\.log$/.test(name))
    .sort((left, right) => rotationIndex(right) - rotationIndex(left));
  const marker = ` ${ONCHAT_REPLAY_TIMING_LOG_MESSAGE} {`;
  const replays: ChatSwitchServerReplay[] = [];
  for (const logFile of logFiles) {
    for (const line of fs.readFileSync(path.join(logsDir, logFile), "utf-8").split("\n")) {
      const markerIndex = line.indexOf(marker);
      if (markerIndex === -1) continue;
      const replay = JSON.parse(
        line.slice(markerIndex + marker.length - 1)
      ) as ChatSwitchServerReplay;
      if (replay.workspaceId === workspaceId) replays.push(replay);
    }
  }
  return replays;
}

function rotationIndex(fileName: string): number {
  const match = /^mux\.(\d+)\.log$/.exec(fileName);
  return match ? Number(match[1]) : 0;
}

async function readRendererTimings(
  page: Page,
  workspaceId: string,
  clickAt: number | null
): Promise<ChatSwitchRendererTimings & { measured: string[] }> {
  const timeline = await page.evaluate(
    ({ prefix, startMark, workspaceId }) => {
      const start = performance.getEntriesByName(startMark, "mark")[0] as
        | PerformanceMark
        | undefined;
      const startDetail = start?.detail as { workspaceId?: string } | undefined;
      const measures: Record<string, { duration: number; replay: string | null }> = {};
      if (startDetail?.workspaceId === workspaceId) {
        for (const entry of performance.getEntriesByType("measure")) {
          if (!entry.name.startsWith(prefix)) continue;
          const detail = (entry as PerformanceMeasure).detail as
            | { workspaceId?: string; replay?: string }
            | undefined;
          if (detail?.workspaceId !== workspaceId) continue;
          measures[entry.name.slice(prefix.length)] = {
            duration: entry.duration,
            replay: detail.replay ?? null,
          };
        }
      }
      return { startAt: start?.startTime ?? null, measures };
    },
    { prefix: CHAT_SWITCH_MARK_PREFIX, startMark: CHAT_SWITCH_START_MARK, workspaceId }
  );
  const duration = (name: string) => timeline.measures[name]?.duration ?? null;
  return {
    clickToStartMs:
      timeline.startAt !== null && clickAt !== null ? timeline.startAt - clickAt : null,
    skeletonShownMs: duration("skeleton-shown"),
    skeletonHiddenMs: duration("skeleton-hidden"),
    firstRowMs: duration("first-row"),
    caughtUpMs: duration("caught-up"),
    caughtUpReplay: timeline.measures["caught-up"]?.replay ?? null,
    measured: Object.keys(timeline.measures),
  };
}

test.describe("chat switch performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: switch back to chats left mid-stream", async ({ ui, page, workspace }, testInfo) => {
    expect(Number.isFinite(dwellMs) && dwellMs >= 0).toBe(true);
    test.setTimeout(120_000 + roundCount * 60_000);
    const rounds = seededRounds;
    if (!rounds) {
      throw new Error("Chat-switch workspaces were not seeded");
    }
    const logsDir = path.join(workspace.configRoot, "logs");
    const stopButton = page.getByRole("button", { name: "Stop streaming" });
    const switches: ChatSwitchRecord[] = [];

    const switchTo = async (
      chat: SeededChat,
      round: number,
      leg: ChatSwitchLeg,
      targetMidStream: boolean
    ) => {
      const workspaceId = chat.config.workspaceId;
      const rowSelector = `[data-workspace-id="${workspaceId}"]`;
      const consumedReplays = readServerReplays(logsDir, workspaceId).length;
      const measuredNames = async () =>
        (await readRendererTimings(page, workspaceId, null)).measured;

      if (targetMidStream) {
        // Inactive rows show server-side activity, so this proves the chat is still streaming
        // right before the switch. (After the switch the mock's missing replay makes the
        // chat look interrupted; see the file comment.)
        await expect(page.locator(`div[role="button"]${rowSelector}`)).toContainText("streaming");
      }
      await startSwitchMilestones(page, rowSelector);
      await ui.projects.openWorkspaceById(workspaceId);
      await expect.poll(measuredNames, { timeout: CAUGHT_UP_BUDGET_MS }).toContain("caught-up");
      await expect(page.getByTestId("transcript-hydration-placeholder")).toHaveCount(0);
      await expect(page.getByTestId("message-window")).toHaveAttribute("data-loaded", "true", {
        timeout: 20_000,
      });
      await expect.poll(measuredNames).toContain("first-row");

      const dom = await readSwitchMilestones(page);
      const { measured: _measured, ...renderer } = await readRendererTimings(
        page,
        workspaceId,
        dom.clickAt
      );
      // Log writes are async; wait for this switch's replay line.
      await expect
        .poll(() => readServerReplays(logsDir, workspaceId).length, { timeout: 10_000 })
        .toBeGreaterThan(consumedReplays);
      const server = readServerReplays(logsDir, workspaceId).slice(consumedReplays);

      switches.push({
        index: switches.length,
        round,
        leg,
        workspaceId,
        historyProfile: chat.profile,
        targetMidStream,
        renderer,
        dom,
        server,
      });
    };

    const startLongStream = async () => {
      await ui.chat.sendMessage(MOCK_LONG_STREAM_PROMPT);
      await expect(stopButton).toBeVisible({ timeout: 20_000 });
    };

    await resetReactProfileSamples(page);
    const runLabel = "chat-switch-mid-stream";
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      for (const [round, chats] of rounds.entries()) {
        await switchTo(chats.small, round, "cold-open-small", false);
        await startLongStream();
        await switchTo(chats.large, round, "cold-open-large", false);
        await startLongStream();
        // Stay on the current chat so the one left behind falls behind its stream, like a
        // user reading one chat while the other keeps working.
        await page.waitForTimeout(dwellMs);
        await switchTo(chats.small, round, "switch-back-small", true);
        await page.waitForTimeout(dwellMs);
        await switchTo(chats.large, round, "switch-back-large", true);
      }
    });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: { small: rounds[0].small.history, large: rounds[0].large.history },
      chatSwitch: { switches, medians: summarizeChatSwitches(switches) },
    });
    testInfo.annotations.push({ type: "perf-artifact", description: artifactDirectory });
    // eslint-disable-next-line no-console
    console.log(`[chat-switch] medians\n${renderChatSwitchMarkdownTable(switches)}`);

    const switchBacks = switches.filter((record) => record.targetMidStream);
    expect(switchBacks).toHaveLength(roundCount * 2);
    for (const record of switches) {
      const label = `switch #${record.index} (${record.leg})`;
      expect(record.renderer.caughtUpMs, `${label} reached caught-up`).not.toBeNull();
      expect(record.renderer.caughtUpMs ?? Infinity, label).toBeLessThan(CAUGHT_UP_BUDGET_MS);
      expect(record.server.length, `${label} has a server replay line`).toBeGreaterThan(0);
    }
    for (const record of switchBacks) {
      expect(
        record.renderer.skeletonShownMs !== null,
        `switch #${record.index} (${record.leg}) skeleton shown on mid-stream switch-back`
      ).toBe(EXPECT_SKELETON_ON_MID_STREAM_SWITCH_BACK);
    }
  });
});
