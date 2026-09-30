import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { resetStorybookPersistedStateForStory, setupSettingsStory } from "./settingsStoryUtils";

describe("SettingsSectionStory", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
  });

  afterEach(() => {
    restoreDom?.();
    restoreDom = null;
  });

  test("clears unseeded experiment overrides before story setup", () => {
    const key = getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
    window.localStorage.setItem(key, JSON.stringify(true));

    resetStorybookPersistedStateForStory();

    expect(window.localStorage.getItem(key)).toBeNull();

    setupSettingsStory({
      experiments: { [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true },
    });
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(true));
  });
});
