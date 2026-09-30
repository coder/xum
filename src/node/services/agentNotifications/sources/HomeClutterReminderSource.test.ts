import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ClutterScanner, getClutterWatchRoots } from "@/node/runtime/homeClutterWatch";
import { HomeClutterReminderSource } from "./HomeClutterReminderSource";

interface PollResult {
  toolSucceeded?: boolean;
  resultCanCarryNotifications?: boolean;
}
const poll = (source: HomeClutterReminderSource, result: PollResult = {}) =>
  source.poll({
    toolName: "bash",
    toolSucceeded: result.toolSucceeded ?? true,
    resultCanCarryNotifications: result.resultCanCarryNotifications ?? true,
    now: Date.now(),
  });

describe("HomeClutterReminderSource (real filesystem)", () => {
  let home: string;
  let scanner: ClutterScanner;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "home-clutter-reminder-"));
    await fs.mkdir(path.join(home, ".cache"));
    scanner = new ClutterScanner(getClutterWatchRoots(home));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  test("reports the first tool call's clutter once per turn", async () => {
    const turn = new HomeClutterReminderSource({ homeDir: home, scanner });
    await scanner.scan(); // the turn-start baseline scan has finished

    await fs.mkdir(path.join(home, "perf-runs"));
    const first = await poll(turn);
    expect(first).toHaveLength(1);
    expect(first[0].content).toContain("~/perf-runs");

    // Later clutter in the same turn stays quiet.
    await fs.mkdir(path.join(home, ".cache", "task-x"));
    expect(await poll(turn)).toEqual([]);

    // The next turn gets a fresh source and reports only what is new since it started.
    const nextTurn = new HomeClutterReminderSource({ homeDir: home, scanner });
    await scanner.scan();
    await fs.mkdir(path.join(home, "ws5-scripts"));
    const next = await poll(nextTurn);
    expect(next[0].content).toContain("~/ws5-scripts");
    expect(next[0].content).not.toContain("perf-runs");
  });

  test("keeps the reminder until a tool result can actually carry it", async () => {
    const turn = new HomeClutterReminderSource({ homeDir: home, scanner });
    await scanner.scan();

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
});

/** In-memory directory listings with switchable stalls and read errors. */
function fakeHome(home: string) {
  const dirs = new Map<string, string[]>([
    [home, ["existing"]],
    [path.join(home, ".cache"), []],
  ]);
  const failing = new Set<string>();
  let stall: Promise<void> | null = null;
  let release = () => undefined as void;
  let reads = 0;
  return {
    dirs,
    failing,
    get reads() {
      return reads;
    },
    stall() {
      stall = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    unstall() {
      stall = null;
      release();
    },
    readDir: async (dir: string): Promise<string[]> => {
      reads++;
      if (stall != null) await stall;
      if (failing.has(dir)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const names = dirs.get(dir);
      if (names == null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...names];
    },
  };
}

describe("HomeClutterReminderSource (stalled or failing reads)", () => {
  const home = path.join(os.tmpdir(), "fake-home");

  test("keeps a turn-start scan that finishes after a poll timed out", async () => {
    const fake = fakeHome(home);
    const scanner = new ClutterScanner(getClutterWatchRoots(home), fake.readDir);
    fake.stall();
    const turn = new HomeClutterReminderSource({ homeDir: home, scanner });

    // The first tool call returns without waiting for the stuck baseline scan.
    expect(await poll(turn)).toEqual([]);
    fake.unstall();
    await scanner.scan(); // the late baseline lands

    fake.dirs.get(home)!.push("made-by-first-call");
    const next = await poll(turn);
    expect(next[0].content).toContain("~/made-by-first-call");
  });

  test("shares one stuck scan across turns instead of piling up reads", async () => {
    const fake = fakeHome(home);
    const scanner = new ClutterScanner(getClutterWatchRoots(home), fake.readDir);
    fake.stall();

    const turnA = new HomeClutterReminderSource({ homeDir: home, scanner });
    const turnB = new HomeClutterReminderSource({ homeDir: home, scanner });
    await poll(turnA);
    await poll(turnB);
    await poll(turnA);

    // One scan = one read per watched root, no matter how many sources or polls.
    expect(fake.reads).toBe(scanner.roots.length);
    fake.unstall();
  });

  test("a transient read error does not make existing entries look new", async () => {
    const fake = fakeHome(home);
    const scanner = new ClutterScanner(getClutterWatchRoots(home), fake.readDir);
    const turn = new HomeClutterReminderSource({ homeDir: home, scanner });
    await scanner.scan();

    fake.failing.add(home);
    expect(await poll(turn)).toEqual([]);
    fake.failing.delete(home);
    expect(await poll(turn)).toEqual([]);
  });
});
