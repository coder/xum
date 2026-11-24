import { describe, expect, test } from "bun:test";
import { EXPERIMENTS, EXPERIMENT_IDS } from "./experiments";

describe("experiments registry", () => {
  test("keeps multi-project workspaces visible in Settings while remaining opt-in", () => {
    const experiment = EXPERIMENTS[EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES];

    expect(experiment.enabledByDefault).toBe(false);
    expect(experiment.showInSettings).toBe(true);
  });

  test("keeps portable desktop visible in Settings while remaining opt-in", () => {
    const experiment = EXPERIMENTS[EXPERIMENT_IDS.PORTABLE_DESKTOP];

    expect(experiment.enabledByDefault).toBe(false);
    expect(experiment.showInSettings).toBe(true);
  });
});
