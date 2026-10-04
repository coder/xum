/**
 * perf.tapeReplay: replay a committed synthetic session tape through the real desktop app
 * (backend onChat replay source -> MessagePort oRPC -> WorkspaceStore -> React) and time it.
 *
 * The app runs in session tape replay mode (XUM_REPLAY_TAPES): the demo workspace is registered
 * under the fixture's workspace id, its onChat stream comes from the tape, the renderer cannot
 * reach the network, and sends are refused. Inherited provider credentials are stripped from the
 * launch environment, so even a bug in the read-only gates could not reach a provider.
 */
import fs from "fs";
import path from "path";
import type { Request } from "@playwright/test";
import {
  loadSessionTape,
  summarizeSessionTape,
} from "@/common/utils/sessionTapes/sessionTapeLoader";
import { electronTest, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv } from "../env";
import {
  TAPE_REPLAY_FIXTURE_FILE_NAME,
  TAPE_REPLAY_FIXTURE_WORKSPACE_ID,
  TAPE_REPLAY_PROBE_URLS,
  TAPE_REPLAY_TEXTS,
} from "../fixtures/sessionTapes/tapeReplayFixture";
import type { DemoProjectConfig } from "../utils/demoProject";
import {
  readPageMilestones,
  startPageMilestones,
  type PageMilestones,
} from "../utils/pageMilestones";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";

const shouldRunPerfScenarios = getXumE2EEnv("E2E_RUN_PERF") === "1";
const FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "sessionTapes",
  TAPE_REPLAY_FIXTURE_FILE_NAME
);
/** Generic credential shapes (provider keys, gateway tokens, endpoint overrides). */
const CREDENTIAL_ENV_PATTERN = /_API_KEY$|_AUTH_TOKEN$|_BASE_URL$/;

/**
 * Give the demo workspace the fixture's id: the replay source refuses a tape whose header hash
 * does not match the mapped workspace. Config entries with an id and a name are read as-is.
 */
function registerFixtureWorkspace(demoProject: DemoProjectConfig): void {
  const config = JSON.parse(fs.readFileSync(demoProject.configPath, "utf-8")) as {
    projects: [string, { workspaces: { path: string; id?: string; name?: string }[] }][];
  };
  const entry = config.projects.find(([projectPath]) => projectPath === demoProject.projectPath);
  const workspace = entry?.[1].workspaces.find((ws) => ws.path === demoProject.workspacePath);
  if (!workspace) throw new Error("Demo workspace is missing from config.json");
  workspace.id = TAPE_REPLAY_FIXTURE_WORKSPACE_ID;
  workspace.name = path.basename(demoProject.workspacePath);
  fs.writeFileSync(demoProject.configPath, JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(demoProject.sessionsDir, TAPE_REPLAY_FIXTURE_WORKSPACE_ID), {
    recursive: true,
  });
}

const test = electronTest.extend({
  workspace: async ({ workspace }, use) => {
    registerFixtureWorkspace(workspace.demoProject);
    // The app fixture copies process.env into the Electron environment at launch.
    const savedEnv = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string | undefined) => {
      if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    for (const key of Object.keys(process.env)) {
      if (CREDENTIAL_ENV_PATTERN.test(key)) setEnv(key, undefined);
    }
    setEnv("MUX_REPLAY_TAPES", undefined);
    setEnv(
      "XUM_REPLAY_TAPES",
      JSON.stringify({ [TAPE_REPLAY_FIXTURE_WORKSPACE_ID]: FIXTURE_PATH })
    );
    try {
      await use(workspace);
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
});

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("session tape replay performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: replay a synthetic session tape", async ({ page, ui }, testInfo) => {
    const tape = loadSessionTape(fs.readFileSync(FIXTURE_PATH, "utf-8"));
    if (tape.status !== "ok") throw new Error(`Fixture tape is not ok: ${tape.status}`);
    const tapeSummary = summarizeSessionTape(tape);

    // Every probe image request must fail at the egress block; none may finish.
    const isProbe = (request: Request) =>
      (TAPE_REPLAY_PROBE_URLS as readonly string[]).includes(request.url());
    const probeFailures: { url: string; errorText: string }[] = [];
    const probesFinished: string[] = [];
    page.on("requestfailed", (request) => {
      if (isProbe(request)) {
        probeFailures.push({ url: request.url(), errorText: request.failure()?.errorText ?? "" });
      }
    });
    page.on("requestfinished", (request) => {
      if (isProbe(request)) probesFinished.push(request.url());
    });

    await resetReactProfileSamples(page);
    const transcript = page.getByRole("log", { name: "Conversation transcript" });
    const runLabel = "tape-replay";
    let milestones: PageMilestones | undefined;
    let firstRowMs = 0;
    let lastRowMs = 0;
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      await startPageMilestones(page);
      const startedAt = performance.now();
      await ui.projects.openFirstWorkspace();
      await expect(transcript).toContainText(TAPE_REPLAY_TEXTS.historyUser, { timeout: 20_000 });
      firstRowMs = performance.now() - startedAt;
      await expect(transcript).toContainText(TAPE_REPLAY_TEXTS.finalReply, { timeout: 20_000 });
      lastRowMs = performance.now() - startedAt;
      milestones = await readPageMilestones(page);
    });
    if (!milestones) throw new Error("Page milestones were not captured");

    await expect(transcript).toContainText(TAPE_REPLAY_TEXTS.historyAssistant);
    await expect(transcript).toContainText(TAPE_REPLAY_TEXTS.liveText.trim());
    await expect(transcript).toContainText(TAPE_REPLAY_TEXTS.markerCommand);

    // Streaming and final renders can each request an image, so compare distinct URLs.
    await expect
      .poll(() => [...new Set(probeFailures.map((failure) => failure.url))].sort(), {
        timeout: 10_000,
      })
      .toEqual([...TAPE_REPLAY_PROBE_URLS].sort());
    for (const failure of probeFailures) {
      expect(failure.errorText).toContain("ERR_BLOCKED_BY_CLIENT");
    }
    expect(probesFinished).toEqual([]);

    // Replay mode is read-only: a send is refused with the backend's message.
    await ui.chat.sendMessage("Replay fixture: this send must be refused.");
    await expect(page.getByText(/read-only/).first()).toBeVisible({ timeout: 10_000 });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    if (!reactProfileSnapshot) throw new Error("React profile snapshot was not captured");
    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: null,
      milestones,
      tapeReplay: {
        eventCount: tapeSummary.eventCount,
        durationMs: tapeSummary.durationMs,
        firstRowMs,
        lastRowMs,
        blockedRequests: probeFailures.length,
      },
    });
    expect(chromeProfile.wallTimeMs).toBeGreaterThan(0);
    testInfo.annotations.push({ type: "perf-artifact", description: artifactDirectory });
  });
});
