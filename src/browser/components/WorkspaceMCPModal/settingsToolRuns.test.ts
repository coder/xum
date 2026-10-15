import { expect, test } from "bun:test";
import {
  clearSettingsToolResults,
  forgetSettingsToolRuns,
  settingsToolRunsOf,
  startSettingsToolRun,
} from "./settingsToolRuns";

test("settings tool runs: tracked per workspace and server until each run ends once", () => {
  const first = startSettingsToolRun("ws-runs", "cad", "cad.reset");
  const second = startSettingsToolRun("ws-runs", "cad", "cad.reset");
  expect(settingsToolRunsOf("ws-runs").cad?.running).toEqual(["cad.reset", "cad.reset"]);
  expect(settingsToolRunsOf("ws-other")).toEqual({});
  first({ text: "done", isError: false });
  // A second end of the same run must not end the other run of the tool.
  first(null);
  expect(settingsToolRunsOf("ws-runs").cad).toEqual({
    running: ["cad.reset"],
    results: { "cad.reset": { text: "done", isError: false } },
  });
  // A reopen drops old results, not the run still in flight.
  clearSettingsToolResults("ws-runs");
  expect(settingsToolRunsOf("ws-runs").cad).toEqual({ running: ["cad.reset"], results: {} });
  second(null);
  expect(settingsToolRunsOf("ws-runs")).toEqual({});
});

test("settings tool runs: a removed workspace's entries go, and a late run end does not return", () => {
  const end = startSettingsToolRun("ws-removed", "cad", "cad.reset");
  forgetSettingsToolRuns("ws-removed");
  expect(settingsToolRunsOf("ws-removed")).toEqual({});
  end({ text: "done", isError: false });
  expect(settingsToolRunsOf("ws-removed")).toEqual({});
});
