import { describe, expect, it } from "bun:test";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { SLASH_COMMAND_HINTS } from "@/common/constants/slashCommandHints";
import { getCommandGhostHint } from "./registry";

describe("getCommandGhostHint", () => {
  it("returns inputHint for a command with trailing space and no args", () => {
    expect(getCommandGhostHint("/compact ", false)).toBe(SLASH_COMMAND_HINTS.compact);
  });

  it("returns null once arguments are present", () => {
    expect(getCommandGhostHint("/compact -t 100", false)).toBeNull();
  });

  it("returns null for partial commands", () => {
    expect(getCommandGhostHint("/comp", false)).toBeNull();
  });

  it("returns null for commands without an input hint", () => {
    expect(getCommandGhostHint("/clear ", false)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(getCommandGhostHint("", false)).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(getCommandGhostHint("/nonexistent ", false)).toBeNull();
  });

  it("returns null while command suggestions are visible", () => {
    expect(getCommandGhostHint("/compact ", true)).toBeNull();
  });

  it("returns null when the command is followed by a newline instead of a space", () => {
    expect(getCommandGhostHint("/compact\n", false)).toBeNull();
  });

  it("returns null for workspace-only commands in creation mode", () => {
    expect(getCommandGhostHint("/compact ", false, "creation")).toBeNull();
  });

  it("returns null for experiment-gated command hints when disabled", () => {
    expect(
      getCommandGhostHint("/heartbeat ", false, {
        isExperimentEnabled: () => false,
      })
    ).toBeNull();
  });

  it("returns hints for experiment-gated commands when enabled", () => {
    const enabledExperiments = new Set<ExperimentId>([EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]);

    expect(
      getCommandGhostHint("/heartbeat ", false, {
        isExperimentEnabled: (experimentId) => enabledExperiments.has(experimentId),
      })
    ).toBe(SLASH_COMMAND_HINTS.heartbeat);
  });

  it("returns only workflow args after the typed /workflow command", () => {
    const enabledExperiments = new Set<ExperimentId>([EXPERIMENT_IDS.DYNAMIC_WORKFLOWS]);

    const hint = getCommandGhostHint("/workflow ", false, {
      isExperimentEnabled: (experimentId) => enabledExperiments.has(experimentId),
    });

    expect(hint).toBe("<script_path> [json_args]");
    expect(hint).not.toContain("/workflow");
  });

  it("returns goal hints regardless of experiment state after GA", () => {
    expect(
      getCommandGhostHint("/goal ", false, {
        isExperimentEnabled: () => false,
      })
    ).toBe(SLASH_COMMAND_HINTS.goal);
  });

  it("still returns hints for creation-available commands in creation mode", () => {
    expect(getCommandGhostHint("/model ", false, "creation")).toBe(SLASH_COMMAND_HINTS.model);
  });
});
