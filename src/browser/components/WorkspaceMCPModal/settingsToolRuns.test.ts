import { expect, test } from "bun:test";
import {
  clearSettingsToolResults,
  publishSettingsToolWrite,
  subscribeSettingsToolWrites,
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

test("a writing run's end reaches the dialogs of its workspace only", async () => {
  const reread: string[] = [];
  const stop = subscribeSettingsToolWrites("ws-write", async (serverName) => {
    reread.push(serverName);
  });
  const other = subscribeSettingsToolWrites("ws-other", async () => {
    reread.push("other");
  });
  await publishSettingsToolWrite("ws-write", "cad");
  stop();
  // A closed dialog no longer reads.
  await publishSettingsToolWrite("ws-write", "cad");
  other();
  expect(reread).toEqual(["cad"]);
});
