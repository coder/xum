import { electronTest as test, electronExpect as expect } from "../electronTest";
import { getXumE2EEnv } from "../env";
import { parseHistoryProfilesFromEnv, seedWorkspaceHistoryProfile } from "../utils/historyFixture";
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
const selectedProfiles = parseHistoryProfilesFromEnv(getXumE2EEnv("E2E_PERF_PROFILES"));

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("workspace open performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set XUM_E2E_RUN_PERF=1 to run perf profiling scenarios");

  for (const profile of selectedProfiles) {
    test(`perf: open workspace with ${profile} history profile`, async ({
      ui,
      page,
      workspace,
    }, testInfo) => {
      const historySummary = await seedWorkspaceHistoryProfile({
        demoProject: workspace.demoProject,
        profile,
      });

      await resetReactProfileSamples(page);

      const runLabel = `workspace-open-${profile}`;
      let milestones: PageMilestones | undefined;
      const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
        await startPageMilestones(page);
        await ui.projects.openFirstWorkspace();
        await expect(page.getByTestId("message-window")).toHaveAttribute("data-loaded", "true", {
          timeout: 20_000,
        });
        milestones = await readPageMilestones(page);
      });
      if (!milestones) {
        throw new Error("Page milestones were not captured");
      }

      const reactProfileSnapshot = await readReactProfileSnapshot(page);
      if (!reactProfileSnapshot) {
        throw new Error("React profile snapshot was not captured");
      }

      const artifactDirectory = await writePerfArtifacts({
        testInfo,
        runLabel,
        chromeProfile,
        reactProfile: reactProfileSnapshot,
        historyProfile: historySummary,
        milestones,
      });

      expect(chromeProfile.wallTimeMs).toBeGreaterThan(0);
      // The assertion above saw data-loaded, so the in-page observer must have too.
      expect(milestones.fullyLoadedMs).not.toBeNull();
      expect(chromeProfile.cpuProfile).not.toBeNull();
      const interestingRenderPaths = [
        "chat-pane",
        "chat-pane.header",
        "chat-pane.transcript",
        "chat-pane.input",
      ] as const;
      for (const profilerId of interestingRenderPaths) {
        expect(reactProfileSnapshot.byProfilerId[profilerId]?.sampleCount ?? 0).toBeGreaterThan(0);
      }
      expect(reactProfileSnapshot.enabled).toBe(true);
      expect(reactProfileSnapshot.sampleCount).toBeGreaterThan(0);

      testInfo.annotations.push({
        type: "perf-artifact",
        description: artifactDirectory,
      });
    });
  }
});
