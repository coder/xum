import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as artifactStoreModule from "./artifactStore";
import {
  generateArtifactsIndexAttachment,
  getToolArtifactsLocation,
  publishArtifactVersion,
  resolveArtifactToolPath,
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
  publishArtifactVersion({ sessionDir, location, relPath, label });

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
    await write("a.md", "y");
    await publish("a.md");
    await fs.writeFile(indexPath, "{not json");
    expect(await readArtifactIndex(sessionDir, getArtifactId("a.md"))).toBeNull();
    await write("a.md", "z");
    const again = await publish("a.md");
    // The restarted history numbers past the surviving v1/v2 blobs, which stay intact.
    expect(again.success && again.result.version.version).toBe(3);
    const dir = path.dirname(indexPath);
    expect(await fs.readFile(path.join(dir, "v1"), "utf8")).toBe("x");
    expect(await fs.readFile(path.join(dir, "v2"), "utf8")).toBe("y");
    expect(await fs.readFile(path.join(dir, "v3"), "utf8")).toBe("z");
  });

  test("only a missing or moved-aside index makes an append scan the version blobs", async () => {
    const dir = path.join(sessionDir, "artifact-versions", getArtifactId("b.md"));
    await write("b.md", "1");
    await publish("b.md");
    const realReaddir = fs.readdir;
    const scanned: string[] = [];
    const readdir = spyOn(fs, "readdir").mockImplementation(((target: string, ...rest: []) => {
      scanned.push(String(target));
      return realReaddir(target, ...rest);
    }) as typeof fs.readdir);
    try {
      await write("b.md", "2");
      const healthy = await publish("b.md");
      expect(healthy.success && healthy.result.version.version).toBe(2);
      expect(scanned).not.toContain(dir);

      await fs.writeFile(path.join(dir, "index.json"), "{not json");
      await write("b.md", "3");
      const restarted = await publish("b.md");
      expect(restarted.success && restarted.result.version.version).toBe(3);
      expect(scanned).toContain(dir);
    } finally {
      readdir.mockRestore();
    }
  });

  test("blob names too large for a safe version number are ignored by the scan", async () => {
    const dir = path.join(sessionDir, "artifact-versions", getArtifactId("huge.md"));
    await fs.mkdir(dir, { recursive: true });
    // The longest name most filesystems allow (255 bytes): 1e254, far past any safe integer.
    await fs.writeFile(path.join(dir, `v${"9".repeat(254)}`), "huge");
    await fs.writeFile(path.join(dir, "v9007199254740993"), "unsafe");
    // MAX_SAFE_INTEGER is safe, but the version after it would not be.
    await fs.writeFile(path.join(dir, `v${Number.MAX_SAFE_INTEGER}`), "max");
    await write("huge.md", "fresh");
    const result = await publish("huge.md");
    expect(result.success && result.result.version.version).toBe(1);
    // The index re-reads valid and the blob it names holds the new bytes.
    expect((await versionsOf("huge.md")).map((v) => v.version)).toEqual([1]);
    const stored = await readArtifactVersionBytes(sessionDir, getArtifactId("huge.md"), 1);
    expect(stored?.bytes.toString()).toBe("fresh");
  });

  test("republishing the same bytes with a kind keeps that kind", async () => {
    await write("flow.txt", "graph TD; A-->B");
    await publish("flow.txt");
    const again = await publishArtifactVersion({
      sessionDir,
      location,
      relPath: "flow.txt",
      label: null,
      kind: "mermaid",
    });
    expect(again).toMatchObject({ success: true, kind: "mermaid", result: { created: false } });
    expect((await versionsOf("flow.txt")).map((v) => v.kind)).toEqual(["mermaid"]);
  });

  test("an index from older builds lists its turn-end and attach_file versions", async () => {
    // Older builds also wrote these sources and two bookkeeping fields. Rejecting them would
    // move the whole history aside as a corrupt index.
    await write("legacy.md", "v3");
    const dir = path.join(getArtifactVersionsRoot(sessionDir), getArtifactId("legacy.md"));
    await fs.mkdir(dir, { recursive: true });
    const old = (version: number, source: string) => ({
      version,
      label: source === "turn-end" ? null : "legacy.md",
      source,
      createdAtMs: version,
      sha256: `sha-${version}`,
      size: 2,
      path: "legacy.md",
      sourceModifiedMs: version,
    });
    await fs.writeFile(
      path.join(dir, "index.json"),
      JSON.stringify({
        id: getArtifactId("legacy.md"),
        path: "legacy.md",
        pin: null,
        lastPublishedAtMs: 2,
        versions: [old(1, "attach_file"), old(2, "turn-end")],
      })
    );
    expect((await versionsOf("legacy.md")).map((v) => v.source)).toEqual([
      "attach_file",
      "turn-end",
    ]);
    await publish("legacy.md", "Third");
    expect((await versionsOf("legacy.md")).map((v) => [v.version, v.source])).toEqual([
      [1, "attach_file"],
      [2, "turn-end"],
      [3, "publish"],
    ]);
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

  test("a file name starting with ~ is relative; only ~ and ~/ mean the home folder", () => {
    expect(resolveArtifactToolPath(location, "~draft.md")).toBe("~draft.md");
    expect(resolveArtifactToolPath(location, "~/elsewhere/x.md")).toHaveProperty("error");
    expect(resolveArtifactToolPath(location, "~")).toHaveProperty("error");
    const remote: AvailableArtifactsLocation = {
      kind: "runtime",
      runtime: new LocalRuntime(sessionDir),
      dir: "~/.mux/workspace-scratch/ws/artifacts",
    };
    expect(resolveArtifactToolPath(remote, "~notes.md")).toBe("~notes.md");
    expect(resolveArtifactToolPath(remote, "~/.mux/workspace-scratch/ws/artifacts/a.md")).toBe(
      "a.md"
    );
    expect(resolveArtifactToolPath(remote, "~/other/a.md")).toHaveProperty("error");
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
    const base = { sessionDir, relPath: "p.md", label: null };
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
    const base = { sessionDir };
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
