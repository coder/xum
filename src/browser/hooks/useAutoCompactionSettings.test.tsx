import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { resetTestExperiments, setTestExperiment } from "@/browser/testUtils";
import { installDom } from "../../../tests/ui/dom";
import { useAutoCompactionSettings } from "./useAutoCompactionSettings";

let cleanupDom: (() => void) | undefined;

describe("automatic context policy display", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    resetTestExperiments();
    cleanup();
    cleanupDom?.();
  });

  test.each([
    {
      tokenBudget: false,
      memory: true,
      continuous: false,
      ptc: false,
      rlm: false,
      rollover: false,
    },
    { tokenBudget: true, memory: true, continuous: false, ptc: false, rlm: false, rollover: true },
    {
      tokenBudget: true,
      memory: false,
      continuous: false,
      ptc: false,
      rlm: false,
      rollover: false,
    },
    { tokenBudget: true, memory: true, continuous: true, ptc: false, rlm: false, rollover: false },
    { tokenBudget: true, memory: true, continuous: false, ptc: true, rlm: true, rollover: false },
    { tokenBudget: true, memory: true, continuous: false, ptc: false, rlm: true, rollover: true },
  ])("respects effective policy precedence: %j", (flags) => {
    setTestExperiment(EXPERIMENT_IDS.TOKEN_BUDGET, flags.tokenBudget);
    setTestExperiment(EXPERIMENT_IDS.MEMORY, flags.memory);
    setTestExperiment(EXPERIMENT_IDS.CONTINUOUS_COMPACTION, flags.continuous);
    setTestExperiment(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING, flags.ptc);
    setTestExperiment(EXPERIMENT_IDS.RLM, flags.rlm);
    const { result } = renderHook(() => useAutoCompactionSettings("ws-1", "openai:gpt-5.2"));
    expect(result.current.rolloverEnabled).toBe(flags.rollover);
  });
});
