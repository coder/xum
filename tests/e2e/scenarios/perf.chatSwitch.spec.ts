import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { electronTest, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv, setXumE2EEnv } from "../env";
import { MOCK_LONG_STREAM_PROMPT } from "../mockAiPrompts";
import {
  CHAT_SWITCH_TRANSPORTS,
  renderChatSwitchMarkdownTable,
  summarizeChatSwitches,
  type ChatSwitchLeg,
  type ChatSwitchRecord,
  type ChatSwitchRendererTimings,
  type ChatSwitchServerReplay,
  type ChatSwitchTransport,
} from "../utils/chatSwitchSummary";
import { addDemoWorkspace, trustDemoProject, type DemoProjectConfig } from "../utils/demoProject";
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
import { createWorkspaceUI, type WorkspaceUI } from "../utils/ui";
import { getFreePort, startXumServer } from "../utils/xumServerProcess";
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
 * Each return replays the chat's live mock stream (`streamReplayed: true`, with a
 * `streamReplay` phase in the server line; #4542) over a stale cached transcript, in since mode
 * (#4505). A fresh pair per round keeps every round's history and stream load identical.
 *
 * Transports (#4846): the rounds run first in the desktop's local window (in-process backend),
 * then in a desktop window connected to a real `xum server` on the same root (its WebSocket
 * transport), each on its own fresh workspaces. That comparison also includes process
 * differences (a separate backend with its own caches), not only the transport.
 *
 * XUM_E2E_CHAT_SWITCH_XL=1 adds one `xl` round per transport (~2.7 MB history, enough to cross
 * the server's 1 MiB WebSocket send window, #4655): cold-open xl, start a stream, leave it for
 * the transport's last small chat (not recorded), and switch back.
 */

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";
const roundCount = Number(getXumE2EEnv("E2E_CHAT_SWITCH_ROUNDS") ?? "3");
const dwellMs = Number(getXumE2EEnv("E2E_CHAT_SWITCH_DWELL_MS") ?? "1000");
const includeXl = getXumE2EEnv("E2E_CHAT_SWITCH_XL") === "1";
/** Generous: the point is to record the latency, not to gate on it. */
const CAUGHT_UP_BUDGET_MS = 15_000;

/**
 * Leaving a chat mid-stream marks its cached transcript stale. A since-mode return keeps those
 * cached rows painted (with the composer-dock shimmer) instead of hiding them behind
 * the hydration skeleton until `caught-up`: the server verifies every row up to the cursor, so
 * the missing content mostly appends after it.
 */
const EXPECT_SKELETON_ON_MID_STREAM_SWITCH_BACK = false;

/**
 * Collapse the rendered `[data-message-id]` sequence into runs of consecutive equal ids and
 * return the ids that appear in more than one run. One message can render several consecutive
 * rows with the same id, so global uniqueness is not the invariant; a duplicated or reordered
 * row after caught-up reconciliation would split a message's rows into separate runs.
 */
function findSplitMessageIds(renderedIds: string[]): string[] {
  const runs: string[] = [];
  for (const id of renderedIds) {
    if (runs[runs.length - 1] !== id) runs.push(id);
  }
  const seen = new Set<string>();
  const split = new Set<string>();
  for (const id of runs) {
    if (seen.has(id)) split.add(id);
    seen.add(id);
  }
  return [...split];
}

type ChatProfile = "small" | "large" | "xl";

interface SeededChat {
  config: DemoProjectConfig;
  profile: ChatProfile;
  history: SeededHistoryProfileSummary;
}

interface SeededRound {
  small: SeededChat;
  large: SeededChat;
}

interface SwitchTarget {
  page: Page;
  ui: WorkspaceUI;
  transport: ChatSwitchTransport;
}

/** One transport's chats. Each transport gets its own, so no workspace is replayed by both. */
interface SeededTransport {
  rounds: SeededRound[];
  xl: SeededChat | null;
}

// Set by the workspace fixture override below; every chat must exist before the app launches,
// and the app fixture depends only on `workspace`.
let seededTransports: Record<ChatSwitchTransport, SeededTransport> | undefined;

async function seedChat(
  workspace: { configRoot: string; demoProject: DemoProjectConfig },
  transport: ChatSwitchTransport,
  profile: ChatProfile,
  round: number
): Promise<SeededChat> {
  // Round 0's in-process small chat is the fixture's demo workspace; the rest are added beside it.
  const namePrefix = transport === "in-process" ? "perf" : "perf-server";
  const config =
    transport === "in-process" && profile === "small" && round === 0
      ? workspace.demoProject
      : addDemoWorkspace(
          workspace.configRoot,
          workspace.demoProject,
          `${namePrefix}-${profile}-${round}`
        );
  const history = await seedWorkspaceHistoryProfile({ demoProject: config, profile });
  // Real workspaces keep session-usage.json current. Without one, the first open rebuilds it
  // from the full history while holding the workspace history lock (~250-320 ms), and the
  // cold-open replay measured that wait instead of the replay itself (#4506).
  fs.writeFileSync(
    path.join(config.sessionsDir, config.workspaceId, "session-usage.json"),
    JSON.stringify({ byModel: {}, version: 1 })
  );
  return { config, profile, history };
}

const test = electronTest.extend({
  workspace: async ({ workspace }, use) => {
    expect(Number.isInteger(roundCount) && roundCount > 0).toBe(true);
    const seedTransport = async (transport: ChatSwitchTransport): Promise<SeededTransport> => {
      const rounds: SeededRound[] = [];
      for (let round = 0; round < roundCount; round++) {
        rounds.push({
          small: await seedChat(workspace, transport, "small", round),
          large: await seedChat(workspace, transport, "large", round),
        });
      }
      const xl = includeXl ? await seedChat(workspace, transport, "xl", roundCount) : null;
      return { rounds, xl };
    };
    seededTransports = {
      "in-process": await seedTransport("in-process"),
      "server-window": await seedTransport("server-window"),
    };
    // Measure the common trusted case (the workspace-creation flow asks for trust). In an
    // untrusted project every executeBash first runs four `git` spawns to discover repo
    // automation drivers. A workspace open fires four executeBash calls (git status, git fetch,
    // gh pr view, gh stack view), so a cold open forked the Electron main process 20 times
    // instead of 4, each blocking it ~8-16 ms inside the replay's history read. Cold-open replay
    // took 2-3x longer than trusted (#4624). That untrusted-path cost is real: #4661.
    trustDemoProject(workspace.demoProject);

    // The per-replay server line logs at debug unless the replay is slow; the app fixture
    // copies process.env into the Electron environment, so set it before launch. `xum server`
    // inherits it too. The desktop stays off server.lock (no API server; the local window uses
    // the in-process MessagePort transport either way) so `xum server` can start on this root.
    const originalEnv = {
      XUM_LOG_LEVEL: process.env.XUM_LOG_LEVEL,
      MUX_LOG_LEVEL: process.env.MUX_LOG_LEVEL,
      XUM_NO_API_SERVER: process.env.XUM_NO_API_SERVER,
    };
    setXumE2EEnv(process.env, "LOG_LEVEL", "debug");
    process.env.XUM_NO_API_SERVER = "1";
    try {
      await use(workspace);
    } finally {
      seededTransports = undefined;
      for (const [key, value] of Object.entries(originalEnv)) {
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

/** The backend keeps partial.json only while the chat's stream is running. */
function partialPath(chat: SeededChat): string {
  return path.join(path.dirname(chat.config.historyPath), "partial.json");
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

  test("perf: switch back to chats left mid-stream", async ({
    app,
    ui,
    page,
    workspace,
  }, testInfo) => {
    expect(Number.isFinite(dwellMs) && dwellMs >= 0).toBe(true);
    test.setTimeout(180_000 + roundCount * 120_000 + (includeXl ? 120_000 : 0));
    const seeded = seededTransports;
    if (!seeded) {
      throw new Error("Chat-switch workspaces were not seeded");
    }
    const logsDir = path.join(workspace.configRoot, "logs");
    const switches: ChatSwitchRecord[] = [];
    // Every server-window switch, recorded or not, must match exactly one replay line.
    const serverWindowSwitchCounts = new Map<string, number>();

    /** Switch to `chat` and wait until it caught up; a null `leg` records nothing. */
    const switchTo = async (
      target: SwitchTarget,
      chat: SeededChat,
      round: number,
      leg: ChatSwitchLeg | null,
      targetMidStream: boolean
    ) => {
      const { page, ui, transport } = target;
      const workspaceId = chat.config.workspaceId;
      const label = `${transport} ${leg ?? "unrecorded switch"} (round ${round})`;
      const rowSelector = `[data-workspace-id="${workspaceId}"]`;
      const consumedReplays = readServerReplays(logsDir, workspaceId).length;
      if (transport === "server-window") {
        serverWindowSwitchCounts.set(
          workspaceId,
          (serverWindowSwitchCounts.get(workspaceId) ?? 0) + 1
        );
      }
      const measuredNames = async () =>
        (await readRendererTimings(page, workspaceId, null)).measured;

      if (targetMidStream) {
        // Inactive rows show server-side activity, and partial.json exists only while the
        // backend stream runs, so the chat is still streaming right before the switch.
        await expect(page.locator(`div[role="button"]${rowSelector}`)).toContainText("streaming");
        expect(fs.existsSync(partialPath(chat)), `${label} target is still streaming`).toBe(true);
      }
      await startSwitchMilestones(page, rowSelector);
      await ui.projects.openWorkspaceById(workspaceId);
      await expect.poll(measuredNames, { timeout: CAUGHT_UP_BUDGET_MS }).toContain("caught-up");
      await expect(page.getByTestId("transcript-hydration-placeholder")).toHaveCount(0);
      await expect(page.getByTestId("message-window")).toHaveAttribute("data-loaded", "true", {
        timeout: 20_000,
      });
      await expect.poll(measuredNames).toContain("first-row");
      const renderedIds = await page
        .getByTestId("message-window")
        .locator("[data-message-id]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-message-id") ?? "")
        );
      expect(renderedIds.length, `${label} renders transcript rows`).toBeGreaterThan(0);
      expect(
        findSplitMessageIds(renderedIds),
        `${label} has no duplicated or reordered rows`
      ).toEqual([]);

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
      if (transport === "server-window") {
        // Only the server window ever opens this workspace, so its lines come from `xum server`.
        expect(server, `${label} matched exactly one server replay line`).toHaveLength(1);
      }
      if (leg === null) return;

      switches.push({
        index: switches.length,
        round,
        leg,
        transport,
        workspaceId,
        historyProfile: chat.profile,
        targetMidStream,
        renderer,
        dom,
        server,
      });
    };

    const runRounds = async (target: SwitchTarget, chats: SeededTransport) => {
      const stopButton = target.page.getByRole("button", { name: "Stop streaming" });
      const startLongStream = async () => {
        await target.ui.chat.sendMessage(MOCK_LONG_STREAM_PROMPT);
        await expect(stopButton).toBeVisible({ timeout: 20_000 });
      };

      for (const [round, pair] of chats.rounds.entries()) {
        await switchTo(target, pair.small, round, "cold-open-small", false);
        await startLongStream();
        await switchTo(target, pair.large, round, "cold-open-large", false);
        await startLongStream();
        // Stay on the current chat so the one left behind falls behind its stream, like a
        // user reading one chat while the other keeps working.
        await target.page.waitForTimeout(dwellMs);
        await switchTo(target, pair.small, round, "switch-back-small", true);
        await target.page.waitForTimeout(dwellMs);
        await switchTo(target, pair.large, round, "switch-back-large", true);
        // Let this round's streams finish so every round is measured under the same backend
        // load (two streams) instead of piling up behind earlier rounds' streams.
        await expect
          .poll(() => [pair.small, pair.large].some((chat) => fs.existsSync(partialPath(chat))), {
            timeout: 60_000,
          })
          .toBe(false);
      }

      if (chats.xl) {
        const xl = chats.xl;
        const round = chats.rounds.length;
        await switchTo(target, xl, round, "cold-open-xl", false);
        await startLongStream();
        await switchTo(target, chats.rounds[chats.rounds.length - 1].small, round, null, false);
        await target.page.waitForTimeout(dwellMs);
        await switchTo(target, xl, round, "switch-back-xl", true);
        // Nothing after this measures xl, so stop its stream instead of waiting it out.
        await stopButton.click();
        await expect.poll(() => fs.existsSync(partialPath(xl)), { timeout: 60_000 }).toBe(false);
      }
    };

    await resetReactProfileSamples(page);
    const runLabel = "chat-switch-mid-stream";
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, () =>
      runRounds({ page, ui, transport: "in-process" }, seeded["in-process"])
    );
    const reactProfileSnapshot = await readReactProfileSnapshot(page);

    // The local window now stays on its last in-process chat. It keeps that one onChat
    // subscription while the server window runs: the desktop backend must replay nothing more
    // (the server window never opens an in-process workspace, so these lines are the desktop's).
    const inProcessIds = [
      ...seeded["in-process"].rounds.flatMap((pair) => [pair.small, pair.large]),
      ...(seeded["in-process"].xl ? [seeded["in-process"].xl] : []),
    ].map((chat) => chat.config.workspaceId);
    const countDesktopReplays = () =>
      inProcessIds.reduce((total, id) => total + readServerReplays(logsDir, id).length, 0);
    const desktopReplays = countDesktopReplays();

    const server = await startXumServer({
      root: workspace.configRoot,
      port: await getFreePort(),
      token: randomBytes(32).toString("hex"),
      logPath: testInfo.outputPath("xum-server.log"),
    });
    try {
      const opened = app.waitForEvent("window");
      const openResult = await page.evaluate(() => {
        const bridge = window.api?.remoteConnection;
        if (!bridge) throw new Error("The local window has no remote connection bridge");
        return bridge.openLocalServer();
      });
      expect(openResult).toEqual({ status: "shown" });
      const serverPage = await opened;
      // The server window has no preload, so it misses the local window's e2e switches: the
      // `page` fixture disables tutorials, and window.api.isE2E hides the onboarding splash.
      await serverPage.evaluate(() => {
        const tutorialState = {
          disabled: true,
          completed: { creation: true, workspace: true, review: true },
        };
        localStorage.setItem("tutorialState", JSON.stringify(tutorialState));
      });
      await serverPage.reload();
      await serverPage.getByRole("button", { name: "Skip" }).click({ timeout: 30_000 });
      await expect(serverPage.getByRole("navigation", { name: "Projects" })).toBeVisible({
        timeout: 30_000,
      });
      const serverRunLabel = `${runLabel}-server-window`;
      // Profile this window too, so both transports pay the same profiler overhead.
      const serverChromeProfile = await withChromeProfiles(
        serverPage,
        { label: serverRunLabel },
        () =>
          runRounds(
            {
              page: serverPage,
              ui: createWorkspaceUI(serverPage, workspace.demoProject),
              transport: "server-window",
            },
            seeded["server-window"]
          )
      );
      expect(countDesktopReplays(), "the local window replayed nothing more").toBe(desktopReplays);
      // The server window's CPU profile and trace; perf-summary.json below holds every switch.
      await writePerfArtifacts({
        testInfo,
        runLabel: serverRunLabel,
        chromeProfile: serverChromeProfile,
        reactProfile: await readReactProfileSnapshot(serverPage),
        historyProfile: null,
      });
    } finally {
      await server.stop();
    }

    const firstRound = seeded["in-process"].rounds[0];
    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: {
        small: firstRound.small.history,
        large: firstRound.large.history,
        ...(seeded["in-process"].xl ? { xl: seeded["in-process"].xl.history } : {}),
      },
      chatSwitch: { switches, ...summarizeChatSwitches(switches) },
    });
    testInfo.annotations.push({ type: "perf-artifact", description: artifactDirectory });

    console.log(`[chat-switch] medians\n${renderChatSwitchMarkdownTable(switches)}`);

    for (const transport of CHAT_SWITCH_TRANSPORTS) {
      const switchBacks = switches.filter(
        (record) => record.transport === transport && record.targetMidStream
      );
      expect(switchBacks, `${transport} switch-backs`).toHaveLength(
        roundCount * 2 + (includeXl ? 1 : 0)
      );
    }
    for (const record of switches) {
      const label = `switch #${record.index} (${record.transport} ${record.leg})`;
      expect(record.renderer.caughtUpMs, `${label} reached caught-up`).not.toBeNull();
      expect(record.renderer.caughtUpMs ?? Infinity, label).toBeLessThan(CAUGHT_UP_BUDGET_MS);
      expect(record.server.length, `${label} has a server replay line`).toBeGreaterThan(0);
      if (record.targetMidStream) {
        expect(
          record.renderer.skeletonShownMs !== null,
          `${label} skeleton shown on mid-stream switch-back`
        ).toBe(EXPECT_SKELETON_ON_MID_STREAM_SWITCH_BACK);
      }
    }
    // No late duplicate replay arrived after a server-window switch was read.
    for (const [workspaceId, count] of serverWindowSwitchCounts) {
      expect(readServerReplays(logsDir, workspaceId), `${workspaceId} replay lines`).toHaveLength(
        count
      );
    }
  });
});
