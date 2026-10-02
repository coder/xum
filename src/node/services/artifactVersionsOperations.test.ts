import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as artifactStoreModule from "./artifactStore";
import {
  createArtifactTurnSnapshotHooks,
  generateArtifactsIndexAttachment,
  getToolArtifactsLocation,
  publishArtifactVersion,
  registerAttachedArtifact,
  resolveArtifactToolPath,
  snapshotArtifactsAtTurnEnd,
} from "./artifactVersionsOperations";
import * as artifactsOperationsModule from "./artifactsOperations";
import type { AvailableArtifactsLocation } from "./artifactsOperations";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import {
  getArtifactId,
  getArtifactVersionsRoot,
  readArtifactIndex,
  readArtifactVersionBytes,
  recordArtifactVersion,
} from "./artifactVersionStore";

let root: string;
let sessionDir: string;
let artifactsDir: string;
let location: AvailableArtifactsLocation;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-versions-"));
  sessionDir = path.join(root, "session");
  artifactsDir = path.join(root, "scratch", "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  location = { kind: "host", dir: artifactsDir };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const file = path.join(artifactsDir, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function versionsOf(relPath: string) {
  return (await readArtifactIndex(sessionDir, getArtifactId(relPath)))?.versions ?? [];
}

const publish = (relPath: string, label: string | null = null) =>
  publishArtifactVersion({ sessionDir, location, relPath, source: "publish", label });

describe("artifact version store", () => {
  test("republishing bumps the version; identical bytes add none", async () => {
    await write("report.md", "one");
    const first = await publish("report.md", "Report");
    await write("report.md", "two");
    const second = await publish("report.md", "Report v2");
    const same = await publish("report.md", "ignored");
    if (!first.success || !second.success || !same.success) throw new Error("publish failed");
    expect([first.result.version.version, second.result.version.version]).toEqual([1, 2]);
    expect(same.result.created).toBe(false);
    expect(same.result.version.version).toBe(2);
    expect((await versionsOf("report.md")).map((v) => v.label)).toEqual(["Report", "Report v2"]);
  });

  test("old versions stay readable after the file is deleted", async () => {
    await write("chart.html", "<p>v1</p>");
    await publish("chart.html");
    await fs.rm(path.join(artifactsDir, "chart.html"));
    const stored = await readArtifactVersionBytes(sessionDir, getArtifactId("chart.html"), 1);
    expect(stored?.bytes.toString()).toBe("<p>v1</p>");
  });

  test("a corrupt index is moved aside and history restarts", async () => {
    await write("a.md", "x");
    await publish("a.md");
    const indexPath = path.join(
      sessionDir,
      "artifact-versions",
      getArtifactId("a.md"),
      "index.json"
    );
    await fs.writeFile(indexPath, "{not json");
    expect(await readArtifactIndex(sessionDir, getArtifactId("a.md"))).toBeNull();
    const again = await publish("a.md");
    expect(again.success && again.result.version.version).toBe(1);
  });

  test("ids differ for paths that slug alike", () => {
    expect(getArtifactId("a b.md")).not.toBe(getArtifactId("a-b.md"));
  });

  test("a missing file is reported", async () => {
    expect(await publish("nope.md")).toEqual({
      success: false,
      error: "Artifact not found: nope.md",
    });
  });
});

describe("turn-end snapshots", () => {
  test("ten edits in one turn give one version per changed file", async () => {
    const turnStartedAtMs = Date.now();
    for (let i = 0; i < 10; i++) await write("notes.md", `edit ${i}`);
    await write("data.json", "{}");
    const snap = await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs });
    expect(snap.sort()).toEqual(["data.json", "notes.md"]);
    expect(await versionsOf("notes.md")).toMatchObject([
      { version: 1, source: "turn-end", label: null },
    ]);
  });

  test("the host-maintained goal status board is never snapshotted", async () => {
    await write("goal.status.html", "<p>status</p>");
    await write("nested/goal.status.html", "<p>user file</p>");
    const snap = await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 });
    expect(snap).toEqual(["nested/goal.status.html"]);
    expect(await versionsOf("goal.status.html")).toHaveLength(0);
  });

  test("an unchanged file gets no new version", async () => {
    await write("notes.md", "same");
    await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 });
    // Touch without changing bytes: mtime differs, so the file is read, but the hash matches.
    const later = new Date(Date.now() + 5000);
    await fs.utimes(path.join(artifactsDir, "notes.md"), later, later);
    const snap = await snapshotArtifactsAtTurnEnd({
      sessionDir,
      location,
      turnStartedAtMs: Date.now(),
    });
    expect(snap).toEqual([]);
    expect(await versionsOf("notes.md")).toHaveLength(1);
  });

  test("a same-size rewrite in the second of the recorded mtime is still snapshotted", async () => {
    await write("same.md", "aaaa");
    const mtimeMs = 1_700_000_000_000;
    const file = path.join(artifactsDir, "same.md");
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    // Recorded 200 ms after that mtime: a rewrite later in the same second keeps the mtime.
    await recordArtifactVersion({
      sessionDir,
      relPath: "same.md",
      bytes: Buffer.from("aaaa"),
      source: "turn-end",
      label: null,
      sourceModifiedMs: mtimeMs,
      nowMs: mtimeMs + 200,
    });
    await fs.writeFile(file, "bbbb");
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);

    const snap = await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 });

    expect(snap).toEqual(["same.md"]);
    expect(await versionsOf("same.md")).toHaveLength(2);
  });

  test("any publish during the turn suppresses the snapshot, even a deduped one", async () => {
    await write("a.md", "a");
    await write("b.md", "b");
    await publish("a.md", "A");
    const turnStartedAtMs = Date.now();
    await write("b.md", "b changed");
    // Same bytes as v1: no new version, but it still counts as this turn's publish.
    const republish = await publish("a.md", "A");
    expect(republish.success && republish.result.created).toBe(false);
    expect(await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs })).toEqual([]);
    expect(await versionsOf("b.md")).toHaveLength(0);
  });

  test("a publish before the turn does not suppress it", async () => {
    await write("a.md", "a");
    await publish("a.md", "A");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const turnStartedAtMs = Date.now();
    await write("a.md", "a2");
    expect(await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs })).toEqual([
      "a.md",
    ]);
  });

  test("hooks snapshot only after a recorded start, and only when enabled", async () => {
    let enabled = true;
    let now = 1000;
    const hooks = createArtifactTurnSnapshotHooks({
      isEnabled: () => enabled,
      sessionDir,
      resolveLocation: () => Promise.resolve(location),
      now: () => now,
    });
    await write("x.md", "1");
    // Completion without a start (e.g. after a restart mid-turn): no snapshot.
    await hooks.onLogicalTurnCompleted(new AbortController().signal);
    expect(await versionsOf("x.md")).toHaveLength(0);
    hooks.onLogicalTurnStarted();
    enabled = false;
    await hooks.onLogicalTurnCompleted(new AbortController().signal);
    expect(await versionsOf("x.md")).toHaveLength(0);
    enabled = true;
    now = Date.now();
    hooks.onLogicalTurnStarted();
    await hooks.onLogicalTurnCompleted(new AbortController().signal);
    expect(await versionsOf("x.md")).toHaveLength(1);
  });

  test("an aborted turn-end snapshot writes no versions", async () => {
    await write("y.md", "1");
    const controller = new AbortController();
    const resolved = Promise.withResolvers<typeof location>();
    const hooks = createArtifactTurnSnapshotHooks({
      isEnabled: () => true,
      sessionDir,
      resolveLocation: () => resolved.promise,
    });
    hooks.onLogicalTurnStarted();
    const running = hooks.onLogicalTurnCompleted(controller.signal);
    // The bound fires while the hook is still resolving where artifacts live.
    controller.abort();
    resolved.resolve(location);
    await running;
    expect(await versionsOf("y.md")).toHaveLength(0);

    // Aborted between reading a file and recording it: still nothing is written.
    const midRead = new AbortController();
    const readOriginal = artifactsOperationsModule.readArtifactBytesAtLocation;
    const read = spyOn(artifactsOperationsModule, "readArtifactBytesAtLocation");
    read.mockImplementationOnce(async (...args) => {
      const result = await readOriginal(...args);
      midRead.abort();
      return result;
    });
    try {
      expect(
        await snapshotArtifactsAtTurnEnd({
          sessionDir,
          location,
          turnStartedAtMs: 0,
          abortSignal: midRead.signal,
        })
      ).toEqual([]);
    } finally {
      read.mockRestore();
    }
    expect(await versionsOf("y.md")).toHaveLength(0);
  });
});

describe("snapshot metadata on unchanged bytes", () => {
  test("unchanged host files are not re-read; a cp -p replacement still is", async () => {
    const hooks = createArtifactTurnSnapshotHooks({
      isEnabled: () => true,
      sessionDir,
      resolveLocation: () => Promise.resolve(location),
    });
    const turn = async () => {
      hooks.onLogicalTurnStarted();
      await hooks.onLogicalTurnCompleted(new AbortController().signal);
    };
    await write("big.md", "aaaa");
    const file = path.join(artifactsDir, "big.md");
    // Whole seconds in the past: the file's last change is settled when it is first hashed.
    const mtimeMs = Math.floor(Date.now() / 1000) * 1000 - 20_000;
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const read = spyOn(artifactsOperationsModule, "readArtifactBytesAtLocation");
    try {
      await turn();
      expect(read).toHaveBeenCalledTimes(1);
      await turn();
      expect(read).toHaveBeenCalledTimes(1);
      // Same size and mtime (`cp -p`), but the rewrite moves ctime: it is read and versioned.
      await fs.writeFile(file, "bbbb");
      await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
      await turn();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
    expect((await versionsOf("big.md")).map((v) => v.version)).toEqual([1, 2]);
  });

  test("a touched but unchanged file adds no version", async () => {
    await write("touched.md", "same");
    const file = path.join(artifactsDir, "touched.md");
    const setMtime = (ms: number) => fs.utimes(file, ms / 1000, ms / 1000);
    // Whole seconds in the past, so both mtimes are unambiguous when read.
    const base = Math.floor(Date.now() / 1000) * 1000;
    await setMtime(base - 20_000);
    await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 });
    await setMtime(base - 10_000);
    expect(await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 })).toEqual(
      []
    );
    expect(await versionsOf("touched.md")).toHaveLength(1);
  });

  test("a same-size replacement that keeps the mtime (cp -p) is still snapshotted", async () => {
    await write("copied.md", "aaaa");
    const file = path.join(artifactsDir, "copied.md");
    // Whole seconds in the past, so the recorded mtime is unambiguous.
    const mtimeMs = Math.floor(Date.now() / 1000) * 1000 - 20_000;
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 });
    await fs.writeFile(file, "bbbb");
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);

    expect(await snapshotArtifactsAtTurnEnd({ sessionDir, location, turnStartedAtMs: 0 })).toEqual([
      "copied.md",
    ]);
    expect(await versionsOf("copied.md")).toHaveLength(2);
  });

  test("an mtime read within its own second is not trusted", async () => {
    const mtimeMs = 1_700_000_000_000;
    await recordArtifactVersion({
      sessionDir,
      relPath: "fresh.md",
      bytes: Buffer.from("x"),
      source: "turn-end",
      label: null,
      sourceModifiedMs: mtimeMs,
      nowMs: mtimeMs + 999,
    });
    expect((await versionsOf("fresh.md"))[0]?.sourceModifiedMs).toBeUndefined();
  });

  test("republishing the same bytes with a kind keeps that kind", async () => {
    await write("flow.txt", "graph TD; A-->B");
    await publish("flow.txt");
    const again = await publishArtifactVersion({
      sessionDir,
      location,
      relPath: "flow.txt",
      source: "publish",
      label: null,
      kind: "mermaid",
    });
    expect(again).toMatchObject({ success: true, kind: "mermaid", result: { created: false } });
    expect((await versionsOf("flow.txt")).map((v) => v.kind)).toEqual(["mermaid"]);
  });
});

describe("runtime snapshot metadata", () => {
  test("a same-size rewrite on a runtime whose clock lags the host is still snapshotted", async () => {
    // A LocalRuntime over the same folder stands in for an SSH host (whole-second stat).
    const runtimeLocation: AvailableArtifactsLocation = {
      kind: "runtime",
      runtime: new LocalRuntime(root),
      dir: artifactsDir,
    };
    await write("skew.md", "aaaa");
    const remoteMtimeMs = 1_700_000_000_000;
    const file = path.join(artifactsDir, "skew.md");
    await fs.utimes(file, remoteMtimeMs / 1000, remoteMtimeMs / 1000);
    // Read within that remote second, but the host clock runs 1.5 s ahead, so the host-side
    // check calls the mtime unambiguous.
    await recordArtifactVersion({
      sessionDir,
      relPath: "skew.md",
      bytes: Buffer.from("aaaa"),
      source: "turn-end",
      label: null,
      sourceModifiedMs: remoteMtimeMs,
      nowMs: remoteMtimeMs + 1500,
    });
    await fs.writeFile(file, "bbbb");
    await fs.utimes(file, remoteMtimeMs / 1000, remoteMtimeMs / 1000);

    expect(
      await snapshotArtifactsAtTurnEnd({
        sessionDir,
        location: runtimeLocation,
        turnStartedAtMs: 0,
      })
    ).toEqual(["skew.md"]);
    expect(await versionsOf("skew.md")).toHaveLength(2);
  });
});

describe("interrupted publish", () => {
  test("a publish cancelled during the read records nothing", async () => {
    await write("doc.md", "v1");
    await publish("doc.md");
    const before = await readArtifactIndex(sessionDir, getArtifactId("doc.md"));
    await write("doc.md", "v2");

    const controller = new AbortController();
    const readOriginal = artifactsOperationsModule.readArtifactBytesAtLocation;
    const read = spyOn(artifactsOperationsModule, "readArtifactBytesAtLocation");
    read.mockImplementationOnce(async (...args) => {
      const result = await readOriginal(...args);
      controller.abort();
      return result;
    });
    try {
      expect(
        await publishArtifactVersion({
          sessionDir,
          location,
          relPath: "doc.md",
          source: "publish",
          label: null,
          abortSignal: controller.signal,
        })
      ).toEqual({ success: false, error: "Publish was interrupted" });
    } finally {
      read.mockRestore();
    }
    expect(await readArtifactIndex(sessionDir, getArtifactId("doc.md"))).toEqual(before);
  });

  test("the index lock re-checks the signal before writing", async () => {
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await recordArtifactVersion({
        sessionDir,
        relPath: "late.md",
        bytes: Buffer.from("x"),
        source: "publish",
        label: null,
        abortSignal: controller.signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(await fs.readdir(sessionDir).catch(() => [])).toEqual([]);
  });

  test("a cancel while the new version's bytes are written commits no version", async () => {
    await write("doc.md", "v1");
    await publish("doc.md");
    const before = await readArtifactIndex(sessionDir, getArtifactId("doc.md"));
    const controller = new AbortController();
    const mkdirOriginal = fs.mkdir;
    // The new-version path creates the artifact dir right before writing the blob.
    const abortingMkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
      controller.abort();
      return mkdirOriginal(...args);
    }) as typeof fs.mkdir;
    const mkdir = spyOn(fs, "mkdir").mockImplementationOnce(abortingMkdir);
    let error: unknown;
    try {
      await recordArtifactVersion({
        sessionDir,
        relPath: "doc.md",
        bytes: Buffer.from("v2"),
        source: "publish",
        label: null,
        abortSignal: controller.signal,
      });
    } catch (caught) {
      error = caught;
    } finally {
      mkdir.mockRestore();
    }
    expect(error).toBeInstanceOf(Error);
    expect(await readArtifactIndex(sessionDir, getArtifactId("doc.md"))).toEqual(before);
  });
});

describe("attach_file registration", () => {
  test("registers rich documents inside the artifacts dir with the given bytes", async () => {
    const registered = await registerAttachedArtifact({
      sessionDir,
      location,
      resolvedPath: path.join(artifactsDir, "plots", "chart.svg"),
      bytes: Buffer.from("<svg/>"),
    });
    expect(registered).toEqual({
      id: getArtifactId("plots/chart.svg"),
      version: 1,
      path: "plots/chart.svg",
    });
    expect(await versionsOf("plots/chart.svg")).toMatchObject([
      { source: "attach_file", label: "chart.svg" },
    ]);
  });

  test("ignores files outside the artifacts dir and non-document kinds", async () => {
    const outside = await registerAttachedArtifact({
      sessionDir,
      location,
      resolvedPath: path.join(root, "elsewhere.md"),
      bytes: Buffer.from("x"),
    });
    const image = await registerAttachedArtifact({
      sessionDir,
      location,
      resolvedPath: path.join(artifactsDir, "photo.png"),
      bytes: Buffer.from("png"),
    });
    expect([outside, image]).toEqual([null, null]);
  });

  test("expands a home-relative remote artifacts dir before matching", async () => {
    const registered = await registerAttachedArtifact({
      sessionDir,
      location: {
        kind: "runtime",
        runtime: new LocalRuntime(sessionDir),
        dir: "~/.mux/workspace-scratch/ws/artifacts",
      },
      resolvedPath: "/home/u/.mux/workspace-scratch/ws/artifacts/r.md",
      bytes: Buffer.from("r"),
      resolveRuntimePath: (p) => Promise.resolve(p.replace(/^~/, "/home/u")),
    });
    expect(registered?.path).toBe("r.md");
  });
});

describe("getToolArtifactsLocation", () => {
  test("a dev container scratch dir is read by descriptor on the host, else in the container", async () => {
    // The container writes its mounted scratch dir, so it could race a parent-folder swap past
    // the host's pathname fallback and get a host file copied into the version store.
    const runtime = new LocalRuntime(root);
    const config = {
      xumEnv: { XUM_SCRATCH_DIR: path.join(root, "scratch"), XUM_RUNTIME: "devcontainer" },
      runtime,
    };
    const descriptors = spyOn(artifactStoreModule, "hostSupportsDescriptorPaths");
    try {
      descriptors.mockResolvedValue(false);
      expect(await getToolArtifactsLocation(config)).toMatchObject({
        kind: "runtime",
        dir: artifactsDir,
      });
      descriptors.mockResolvedValue(true);
      expect(await getToolArtifactsLocation(config)).toEqual({
        kind: "host",
        dir: artifactsDir,
        containerWritable: true,
      });
      // Local checkouts are written by this user only: no descriptor requirement.
      expect(
        await getToolArtifactsLocation({
          ...config,
          xumEnv: { ...config.xumEnv, XUM_RUNTIME: "local" },
        })
      ).toEqual({ kind: "host", dir: artifactsDir });
    } finally {
      descriptors.mockRestore();
    }
  });
});

describe("resolveArtifactToolPath", () => {
  test("accepts relative and contained absolute paths, refuses escapes", () => {
    expect(resolveArtifactToolPath(location, "./a/b.md")).toBe("a/b.md");
    expect(resolveArtifactToolPath(location, path.join(artifactsDir, "c.md"))).toBe("c.md");
    expect(resolveArtifactToolPath(location, "/etc/passwd")).toHaveProperty("error");
    expect(resolveArtifactToolPath(location, "../x.md")).toHaveProperty("error");
  });

  test("keeps edge whitespace: `report.md ` and `report.md` are different files", async () => {
    await write("report.md ", "spaced");
    await write("report.md", "plain");
    const relPath = resolveArtifactToolPath(location, "report.md ");
    expect(relPath).toBe("report.md ");
    expect((await publish(relPath as string)).success).toBe(true);
    const index = await readArtifactIndex(sessionDir, getArtifactId("report.md "));
    const stored = await readArtifactVersionBytes(sessionDir, index!.id, 1);
    expect(stored?.bytes.toString()).toBe("spaced");
    expect(resolveArtifactToolPath(location, "  ")).toHaveProperty("error");
  });

  test("uses Windows path rules for a Windows host artifacts dir", () => {
    const windows = { kind: "host", dir: "C:\\Users\\me\\scratch\\artifacts" } as const;
    expect(
      resolveArtifactToolPath(windows, "C:\\Users\\me\\scratch\\artifacts\\a\\b.md", path.win32)
    ).toBe("a/b.md");
    expect(resolveArtifactToolPath(windows, "C:\\Users\\me\\secret.md", path.win32)).toHaveProperty(
      "error"
    );
    expect(resolveArtifactToolPath(windows, "D:\\artifacts\\a.md", path.win32)).toHaveProperty(
      "error"
    );
  });
});

describe("recordArtifactVersion across processes", () => {
  test("waits for another process's index lock before reading the index", async () => {
    // A desktop app alongside `xum server` shares this session dir; held here by this process,
    // the file lock looks to the store exactly like another backend mid-publish.
    const dir = path.join(getArtifactVersionsRoot(sessionDir), getArtifactId("locked.md"));
    const release = await acquireCrossProcessLock({
      lockPath: path.join(dir, "index.lock"),
      acquireTimeoutMs: 1_000,
      staleMs: 60_000,
      timeoutMessage: "test holder",
    });
    let settled = false;
    const recording = recordArtifactVersion({
      sessionDir,
      relPath: "locked.md",
      bytes: Buffer.from("1"),
      source: "publish",
      label: null,
    }).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await versionsOf("locked.md")).toHaveLength(0);
    } finally {
      await release();
    }
    await recording;
    expect(await versionsOf("locked.md")).toHaveLength(1);
  });
});

describe("recordArtifactVersion pin", () => {
  test("keeps the pin when omitted and clears it on null", async () => {
    const base = { sessionDir, relPath: "p.md", source: "publish" as const, label: null };
    await recordArtifactVersion({ ...base, bytes: Buffer.from("1"), pin: "project" });
    const kept = await recordArtifactVersion({ ...base, bytes: Buffer.from("2") });
    expect(kept.pin).toBe("project");
    const cleared = await recordArtifactVersion({ ...base, bytes: Buffer.from("2"), pin: null });
    expect(cleared.pin).toBeNull();
    expect((await readArtifactIndex(sessionDir, getArtifactId("p.md")))?.pin).toBeNull();
  });
});

describe("post-compaction artifacts index", () => {
  test("lists latest versions newest first, and nothing without versions", async () => {
    expect(await generateArtifactsIndexAttachment(sessionDir)).toBeNull();
    const base = { sessionDir, source: "publish" as const };
    await recordArtifactVersion({
      ...base,
      relPath: "old.md",
      bytes: Buffer.from("1"),
      label: "Old",
      nowMs: 1,
    });
    await recordArtifactVersion({
      ...base,
      relPath: "new.md",
      bytes: Buffer.from("1"),
      label: null,
      nowMs: 5,
    });
    await recordArtifactVersion({
      ...base,
      relPath: "new.md",
      bytes: Buffer.from("2"),
      label: "Two",
      nowMs: 6,
    });
    expect(await generateArtifactsIndexAttachment(sessionDir)).toEqual({
      type: "artifacts_index",
      artifacts: [
        { path: "new.md", latestVersion: 2, label: "Two" },
        { path: "old.md", latestVersion: 1, label: "Old" },
      ],
    });
  });
});
