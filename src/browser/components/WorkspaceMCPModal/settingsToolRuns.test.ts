import { expect, test } from "bun:test";
import {
  clearSettingsToolResults,
  forgetSettingsToolRuns,
  forgetSettingsToolRunsExcept,
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

test("settings tool runs: a removed workspace's entries go, and a late run end does not return", () => {
  const end = startSettingsToolRun("ws-removed", "cad", "cad.reset");
  forgetSettingsToolRuns("ws-removed");
  expect(settingsToolRunsOf("ws-removed")).toEqual({});
  end({ text: "done", isError: false });
  expect(settingsToolRunsOf("ws-removed")).toEqual({});
});

test("a writing run's end reaches the dialogs of its workspace only", async () => {
  const reread: string[] = [];
  const stop = subscribeSettingsToolWrites("ws-write", (serverName) => {
    reread.push(serverName);
    return Promise.resolve();
  });
  const other = subscribeSettingsToolWrites("ws-other", () => {
    reread.push("other");
    return Promise.resolve();
  });
  const readWithoutDialog = () => {
    reread.push("backend");
    return Promise.resolve();
  };
  await publishSettingsToolWrite("ws-write", "cad", readWithoutDialog);
  stop();
  // No dialog of the workspace is open: the backend still reads (it refreshes its caches).
  await publishSettingsToolWrite("ws-write", "cad", readWithoutDialog);
  other();
  expect(reread).toEqual(["cad", "backend"]);
});

test("a metadata snapshot drops the runs of workspaces it no longer lists", () => {
  const kept = startSettingsToolRun("ws-listed", "cad", "cad.reset");
  startSettingsToolRun("ws-deleted-elsewhere", "cad", "cad.reset");
  // An empty snapshot can mean a failed metadata read: it drops nothing.
  forgetSettingsToolRunsExcept(new Set());
  expect(settingsToolRunsOf("ws-deleted-elsewhere").cad?.running).toEqual(["cad.reset"]);
  forgetSettingsToolRunsExcept(new Set(["ws-listed"]));
  expect(settingsToolRunsOf("ws-deleted-elsewhere")).toEqual({});
  expect(settingsToolRunsOf("ws-listed").cad?.running).toEqual(["cad.reset"]);
  kept(null);
});
