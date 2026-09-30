import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { HomeClutterReminderSource } from "./HomeClutterReminderSource";

describe("HomeClutterReminderSource", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "home-clutter-reminder-"));
    await fs.mkdir(path.join(home, ".cache"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const poll = (
    source: HomeClutterReminderSource,
    result: { toolSucceeded?: boolean; resultCanCarryNotifications?: boolean } = {}
  ) =>
    source.poll({
      toolName: "bash",
      toolSucceeded: result.toolSucceeded ?? true,
      resultCanCarryNotifications: result.resultCanCarryNotifications ?? true,
      now: Date.now(),
    });

  test("keeps the reminder until a tool result can actually carry it", async () => {
    const turn = new HomeClutterReminderSource({ homeDir: home });
    expect(await poll(turn)).toEqual([]); // a first tool call with nothing new

    // Failed calls and string results (e.g. MCP tools) drop notifications, so nothing is spent.
    await fs.mkdir(path.join(home, "from-failed-call"));
    expect(await poll(turn, { toolSucceeded: false })).toEqual([]);
    await fs.mkdir(path.join(home, "from-string-result"));
    expect(await poll(turn, { resultCanCarryNotifications: false })).toEqual([]);

    const next = await poll(turn);
    expect(next).toHaveLength(1);
    expect(next[0].content).toContain("~/from-failed-call");
    expect(next[0].content).toContain("~/from-string-result");
  });

  test("tells the model once per turn", async () => {
    const turn = new HomeClutterReminderSource({ homeDir: home });
    expect(await poll(turn)).toEqual([]); // a first tool call with nothing new

    await fs.mkdir(path.join(home, "perf-runs"));
    const first = await poll(turn);
    expect(first).toHaveLength(1);
    expect(first[0].content).toContain("~/perf-runs");

    // Later clutter in the same turn stays quiet.
    await fs.mkdir(path.join(home, ".cache", "task-x"));
    expect(await poll(turn)).toEqual([]);

    // The next turn gets a fresh source and reports only what is new since it started.
    const nextTurn = new HomeClutterReminderSource({ homeDir: home });
    expect(await poll(nextTurn)).toEqual([]);
    await fs.mkdir(path.join(home, "ws5-scripts"));
    const next = await poll(nextTurn);
    expect(next[0].content).toContain("~/ws5-scripts");
    expect(next[0].content).not.toContain("perf-runs");
  });
});
