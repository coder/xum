import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { log } from "@/node/services/log";
import { prepareOomHeapSnapshots, type OomHeapSnapshotLogDetails } from "./oomHeapSnapshot";

const dirs: string[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const SNAPSHOT = "Heap.20261016.130810.2982.0.001.heapsnapshot";

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "oom-heap-snapshot-"));
  dirs.push(base);
  const xumHome = path.join(base, "xum");
  const cwd = path.join(base, "cwd");
  await fs.mkdir(xumHome);
  await fs.mkdir(cwd);
  const armed: number[] = [];
  const logs: string[] = [];
  const deps = {
    xumHome,
    cwd: () => cwd,
    setHeapSnapshotNearHeapLimit: (limit: number) => armed.push(limit),
    log: {
      warn: (message: string, meta: OomHeapSnapshotLogDetails) =>
        logs.push(`warn ${message} ${JSON.stringify(meta)}`),
    },
  };
  // Armed and not-armed lines are printed like the startup banner.
  const out = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(`info ${args.map(String).join(" ")}`);
  });
  restores.push(() => out.mockRestore());
  return { cwd, armed, logs, deps, snapshotDir: path.join(xumHome, "heap-snapshots") };
}

describe("prepareOomHeapSnapshots", () => {
  test("without the heap-snapshots directory it does not arm", async () => {
    const s = await setup();

    await prepareOomHeapSnapshots(s.deps);

    expect(s.armed).toEqual([]);
  });

  test("with the directory and no snapshot it arms once and logs where Node writes", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });

    await prepareOomHeapSnapshots(s.deps);

    expect(s.armed).toEqual([1]);
    expect(s.logs.some((line) => line.startsWith("info") && line.includes(s.cwd))).toBe(true);
  });

  test.each(["cwd", "snapshot directory"] as const)(
    "a snapshot already in the %s leaves it unarmed and names the file",
    async (where) => {
      const s = await setup();
      await fs.mkdir(s.snapshotDir, { mode: 0o700 });
      const file = path.join(where === "cwd" ? s.cwd : s.snapshotDir, SNAPSHOT);
      await fs.writeFile(file, "kept");

      await prepareOomHeapSnapshots(s.deps);

      // A crash loop writes at most one multi-GB file; the existing one is untouched.
      expect(s.armed).toEqual([]);
      expect(s.logs.some((line) => line.includes(file))).toBe(true);
      expect(await fs.readFile(file, "utf8")).toBe("kept");
    }
  );

  test("a failure is logged and does not reject, so startup continues", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const deps = {
      ...s.deps,
      cwd: () => {
        throw new Error("ENOENT: process.cwd failed");
      },
    };

    await prepareOomHeapSnapshots(deps);

    expect(s.armed).toEqual([]);
    expect(s.logs.some((line) => line.startsWith("warn"))).toBe(true);
  });

  // `xum server` (CLI mode) logs at "error" by default, so a log.info line never printed and the
  // live server's log could not confirm arming (#6883 follow-up). Like the startup banner, the
  // armed and not-armed lines must reach the console at that level.
  test.each([
    ["armed", false, "Armed"],
    ["not armed", true, "Not armed"],
  ] as const)(
    "the %s line reaches the startup output at the default CLI log level",
    async (_case, withSnapshot, expected) => {
      const s = await setup();
      await fs.mkdir(s.snapshotDir, { mode: 0o700 });
      if (withSnapshot) await fs.writeFile(path.join(s.cwd, SNAPSHOT), "kept");
      const previousLevel = log.getLevel();
      log.setLevel("error");
      const printed: string[] = [];
      const capture = (...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      };
      for (const restore of restores.splice(0)) restore();
      const out = spyOn(console, "log").mockImplementation(capture);
      const err = spyOn(console, "error").mockImplementation(capture);
      try {
        await prepareOomHeapSnapshots({ ...s.deps, log });
      } finally {
        out.mockRestore();
        err.mockRestore();
        log.setLevel(previousLevel);
      }

      expect(printed.some((line) => line.includes(`[heap-snapshot] ${expected}`))).toBe(true);
    }
  );
});
