import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareOomHeapSnapshots, type OomHeapSnapshotLogDetails } from "./oomHeapSnapshot";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

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
      info: (message: string, meta: OomHeapSnapshotLogDetails) =>
        logs.push(`info ${message} ${JSON.stringify(meta)}`),
      warn: (message: string, meta: OomHeapSnapshotLogDetails) =>
        logs.push(`warn ${message} ${JSON.stringify(meta)}`),
    },
  };
  return { xumHome, cwd, armed, logs, deps, snapshotDir: path.join(xumHome, "heap-snapshots") };
}

describe("prepareOomHeapSnapshots", () => {
  test("without the heap-snapshots directory it arms nothing and moves nothing", async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.cwd, "Heap.20261016.130810.2982.0.001.heapsnapshot"), "x");

    await prepareOomHeapSnapshots(s.deps);

    expect(s.armed).toEqual([]);
    expect(await fs.readdir(s.cwd)).toEqual(["Heap.20261016.130810.2982.0.001.heapsnapshot"]);
  });

  test("with the directory it arms one snapshot and moves earlier ones there with mode 0600", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const snapshot = "Heap.20261016.130810.2982.0.001.heapsnapshot";
    await fs.writeFile(path.join(s.cwd, snapshot), "snapshot-bytes", { mode: 0o644 });
    await fs.writeFile(path.join(s.cwd, "unrelated.heapsnapshot"), "keep");

    await prepareOomHeapSnapshots(s.deps);

    expect(s.armed).toEqual([1]);
    const moved = path.join(s.snapshotDir, snapshot);
    expect(await fs.readFile(moved, "utf8")).toBe("snapshot-bytes");
    expect((await fs.stat(moved)).mode & 0o777).toBe(0o600);
    // Only Node's own snapshot names move; nothing is deleted.
    expect(await fs.readdir(s.cwd)).toEqual(["unrelated.heapsnapshot"]);
    expect(s.logs.some((line) => line.includes(snapshot))).toBe(true);
  });

  test("a snapshot with the same name already in the directory is kept, not overwritten", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const snapshot = "Heap.20261016.130810.2982.0.001.heapsnapshot";
    await fs.writeFile(path.join(s.snapshotDir, snapshot), "older");
    await fs.writeFile(path.join(s.cwd, snapshot), "newer");

    await prepareOomHeapSnapshots(s.deps);

    expect(await fs.readFile(path.join(s.snapshotDir, snapshot), "utf8")).toBe("older");
    expect(await fs.readFile(path.join(s.cwd, snapshot), "utf8")).toBe("newer");
  });

  test("a symlink with a snapshot name is not moved and its target keeps its mode", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const victim = path.join(s.xumHome, "victim");
    await fs.mkdir(victim, { mode: 0o755 });
    const victimMode = (await fs.stat(victim)).mode & 0o777;
    const name = "Heap.20261016.130810.2982.0.001.heapsnapshot";
    await fs.symlink(victim, path.join(s.cwd, name));

    await prepareOomHeapSnapshots(s.deps);

    // A checkout can hold such a link: following it would chmod an arbitrary target.
    expect((await fs.stat(victim)).mode & 0o777).toBe(victimMode);
    expect(await fs.readdir(s.snapshotDir)).toEqual([]);
    expect((await fs.lstat(path.join(s.cwd, name))).isSymbolicLink()).toBe(true);
    expect(s.armed).toEqual([1]);
  });

  test("a hard link with a snapshot name is not moved and its other name keeps its mode", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const victim = path.join(s.xumHome, "victim.sh");
    await fs.writeFile(victim, "#!/bin/sh\n", { mode: 0o700 });
    const victimMode = (await fs.stat(victim)).mode & 0o777;
    const name = "Heap.20261016.130810.2982.0.001.heapsnapshot";
    await fs.link(victim, path.join(s.cwd, name));

    await prepareOomHeapSnapshots(s.deps);

    expect((await fs.stat(victim)).mode & 0o777).toBe(victimMode);
    expect(await fs.readdir(s.snapshotDir)).toEqual([]);
  });

  test("a launch directory that is gone does not stop the setup", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const deps = {
      ...s.deps,
      cwd: () => {
        throw new Error("ENOENT: process.cwd failed");
      },
    };

    await prepareOomHeapSnapshots(deps);

    expect(s.armed).toEqual([1]);
    expect(s.logs.some((line) => line.startsWith("warn"))).toBe(true);
  });

  test("the snapshot is armed before any snapshot is moved", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    await fs.writeFile(path.join(s.cwd, "Heap.20261016.130810.2982.0.001.heapsnapshot"), "x");
    let movedBeforeArm: string[] | undefined;
    const deps = {
      ...s.deps,
      setHeapSnapshotNearHeapLimit: () => {
        movedBeforeArm = readdirSync(s.snapshotDir);
      },
    };

    await prepareOomHeapSnapshots(deps);

    // Server startup stops waiting after a bound; the snapshot must already be armed then.
    expect(movedBeforeArm).toEqual([]);
    expect(await fs.readdir(s.snapshotDir)).toHaveLength(1);
  });

  test("a failure is logged and does not reject, so startup continues", async () => {
    const s = await setup();
    await fs.mkdir(s.snapshotDir, { mode: 0o700 });
    const deps = {
      ...s.deps,
      setHeapSnapshotNearHeapLimit: () => {
        throw new Error("not supported");
      },
    };

    await prepareOomHeapSnapshots(deps);

    expect(s.logs.some((line) => line.startsWith("warn"))).toBe(true);
  });
});
