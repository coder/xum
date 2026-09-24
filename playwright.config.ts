import { defineConfig, type ReporterDescription } from "@playwright/test";
import { resolveXumEnvironmentValue } from "./src/common/compat/xumEnv";

const isCI = process.env.CI === "true";
// Perf runs also write per-test outcomes for the nightly trend report (scripts/perf/perfTrend.ts).
// artifacts/perf/ is already uploaded by perf-profiles.yml and is not cleaned by Playwright.
const perfResultsReporter: ReporterDescription[] =
  resolveXumEnvironmentValue("E2E_RUN_PERF", process.env) === "1"
    ? [["json", { outputFile: "artifacts/perf/playwright-results.json" }]]
    : [];

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 15_000, // Increased to allow worker thread encoding import (~10s)
  },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/playwright-report", open: "never" }],
    ...perfResultsReporter,
  ],
  use: {
    trace: isCI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: {
      mode: "on",
      size: { width: 1280, height: 720 },
    },
  },
  outputDir: "artifacts/playwright-output",
  projects: [
    {
      name: "electron",
      testDir: "./tests/e2e",
      // Electron tests are resource-intensive (each spawns a full browser).
      // Limit parallelism to avoid timing issues with transient UI elements like toasts.
      fullyParallel: false,
    },
  ],
});
