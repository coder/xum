import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as artifactStoreModule from "./artifactStore";
import {
  generateArtifactsIndexAttachment,
  getToolArtifactsLocation,
  publishArtifact,
  resolveArtifactToolPath,
} from "./artifactPublishOperations";
import * as artifactsOperationsModule from "./artifactsOperations";
import type { AvailableArtifactsLocation } from "./artifactsOperations";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import {
  ARTIFACT_STORE_DIR_NAME,
  getArtifactId,
  getArtifactStoreRoot,
  readArtifactRecord,
  recordArtifactPublish,
  type RecordArtifactPublishParams,
} from "./artifactRecordStore";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";

let root: string;
let sessionDir: string;
let artifactsDir: string;
let location: AvailableArtifactsLocation;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-records-"));
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

const recordOf = (relPath: string) => readArtifactRecord(sessionDir, getArtifactId(relPath));

const publish = (relPath: string, extra: Partial<Parameters<typeof publishArtifact>[0]> = {}) =>
  publishArtifact({ sessionDir, location, relPath, title: relPath, ...extra });

describe("publishArtifact", () => {
  test("republishing updates the one record in place", async () => {
    await write("report.md", "one");
    await publish("report.md", { title: "Report", kind: "text", pin: "project" });
    await write("report.md", "two");
    const again = await publish("report.md", { title: "Report 2" });
    expect(again).toMatchObject({ success: true, kind: "markdown", size: 3 });
    expect(await recordOf("report.md")).toMatchObject({
      path: "report.md",
      title: "Report 2",
      pin: "project",
    });
    expect((await recordOf("report.md"))?.kind).toBeUndefined();
    expect(await fs.readdir(path.join(getArtifactStoreRoot(sessionDir)))).toEqual([
      getArtifactId("report.md"),
    ]);
  });

  test("reports the kind override and the file's size", async () => {
    await write("flow.txt", "graph TD; A-->B");
    expect(await publish("flow.txt", { kind: "mermaid" })).toMatchObject({
      success: true,
      kind: "mermaid",
      size: 15,
    });
    expect((await recordOf("flow.txt"))?.kind).toBe("mermaid");
  });

  test("a file over the read cap still publishes", async () => {
    await write("big.md", "x".repeat(artifactsOperationsModule.MAX_ARTIFACT_READ_BYTES + 1));
    expect(await publish("big.md")).toMatchObject({
      success: true,
      size: artifactsOperationsModule.MAX_ARTIFACT_READ_BYTES + 1,
    });
  });

  test("a missing file is reported and leaves no record", async () => {
    expect(await publish("nope.md")).toEqual({
      success: false,
      error: "Artifact not found: nope.md",
    });
    expect(await recordOf("nope.md")).toBeNull();
  });

  test("a corrupt record is moved aside and the next publish writes a fresh one", async () => {
    await write("a.md", "x");
    await publish("a.md", { title: "First" });
    const recordPath = path.join(
      getArtifactStoreRoot(sessionDir),
      getArtifactId("a.md"),
      "record.json"
    );
    await fs.writeFile(recordPath, "{not json");
    expect(await recordOf("a.md")).toBeNull();
    const aside = (await fs.readdir(path.dirname(recordPath))).filter((name) =>
      name.startsWith("record.json.corrupt-")
    );
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(recordPath), aside[0]), "utf8")).toBe(
      "{not json"
    );
    await publish("a.md", { title: "Second" });
    expect((await recordOf("a.md"))?.title).toBe("Second");
  });

  test("an index and blobs from the version store are ignored", async () => {
    await write("legacy.md", "now");
    const dir = path.join(sessionDir, ARTIFACT_STORE_DIR_NAME, getArtifactId("legacy.md"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "index.json"),
      JSON.stringify({
        id: getArtifactId("legacy.md"),
        path: "legacy.md",
        pin: null,
        versions: [
          {
            version: 1,
            label: "Old",
            source: "publish",
            createdAtMs: 1,
            sha256: "x",
            size: 1,
            path: "legacy.md",
          },
        ],
      })
    );
    await fs.writeFile(path.join(dir, "v1"), "old");
    expect(await recordOf("legacy.md")).toBeNull();
    expect(await generateArtifactsIndexAttachment(sessionDir)).toBeNull();
    await publish("legacy.md", { title: "New" });
    expect((await recordOf("legacy.md"))?.title).toBe("New");
    expect(await fs.readFile(path.join(dir, "v1"), "utf8")).toBe("old");
  });

  test("ids differ for paths that slug alike", () => {
    expect(getArtifactId("a b.md")).not.toBe(getArtifactId("a-b.md"));
  });
});

describe("interrupted publish", () => {
  test("a publish cancelled during the read records nothing", async () => {
    await write("doc.md", "v1");
    await publish("doc.md", { title: "Before" });
    const before = await recordOf("doc.md");

    const controller = new AbortController();
    const readOriginal = artifactsOperationsModule.readArtifactBytesAtLocation;
    const read = spyOn(artifactsOperationsModule, "readArtifactBytesAtLocation");
    read.mockImplementationOnce(async (...args) => {
      const result = await readOriginal(...args);
      controller.abort();
      return result;
    });
    try {
      expect(await publish("doc.md", { title: "After", abortSignal: controller.signal })).toEqual({
        success: false,
        error: "Publish was interrupted",
      });
    } finally {
      read.mockRestore();
    }
    expect(await recordOf("doc.md")).toEqual(before);
  });

  test("the record lock re-checks the signal before writing", async () => {
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await recordArtifactPublish({
        sessionDir,
        relPath: "late.md",
        title: "late.md",
        abortSignal: controller.signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(await fs.readdir(sessionDir).catch(() => [])).toEqual([]);
  });

  test("a cancel while the record is written commits no record", async () => {
    await write("doc.md", "v1");
    await publish("doc.md", { title: "Before" });
    const before = await recordOf("doc.md");
    const controller = new AbortController();
    const mkdirOriginal = fs.mkdir;
    // The first mkdir is the record lock's; the second prepares the record write.
    let mkdirCalls = 0;
    const abortingMkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
      if (++mkdirCalls === 2) controller.abort();
      return mkdirOriginal(...args);
    }) as typeof fs.mkdir;
    const mkdir = spyOn(fs, "mkdir").mockImplementation(abortingMkdir);
    let error: unknown;
    try {
      await recordArtifactPublish({
        sessionDir,
        relPath: "doc.md",
        title: "After",
        abortSignal: controller.signal,
      });
    } catch (caught) {
      error = caught;
    } finally {
      mkdir.mockRestore();
    }
    expect(error).toBeInstanceOf(Error);
    expect(await recordOf("doc.md")).toEqual(before);
  });
});

describe("getToolArtifactsLocation", () => {
  test("a dev container scratch dir is read by descriptor on the host, else in the container", async () => {
    // The container writes its mounted scratch dir, so it could race a parent-folder swap past
    // the host's pathname fallback and get a host file's size reported or copied to the shelf.
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
    const record = await readArtifactRecord(sessionDir, getArtifactId("report.md "));
    expect(record?.path).toBe("report.md ");
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

describe("recordArtifactPublish across processes", () => {
  test("waits for another process's record lock before reading the record", async () => {
    // A desktop app alongside `xum server` shares this session dir; held here by this process,
    // the file lock looks to the store exactly like another backend mid-publish.
    const dir = path.join(getArtifactStoreRoot(sessionDir), getArtifactId("locked.md"));
    const release = await acquireCrossProcessLock({
      lockPath: path.join(dir, "record.lock"),
      acquireTimeoutMs: 1_000,
      staleMs: 60_000,
      timeoutMessage: "test holder",
    });
    let settled = false;
    const recording = recordArtifactPublish({
      sessionDir,
      relPath: "locked.md",
      title: "Locked",
    }).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await recordOf("locked.md")).toBeNull();
    } finally {
      await release();
    }
    await recording;
    expect((await recordOf("locked.md"))?.title).toBe("Locked");
  });
});

// Each test kills a mutant that the phase 4 mutation runs left alive (#7475).
describe("recordArtifactPublish results", () => {
  const record = (extra: Partial<RecordArtifactPublishParams> = {}) =>
    recordArtifactPublish({ sessionDir, relPath: "r.md", title: "R", ...extra });

  test("reports the kind and a zero nowMs", async () => {
    const result = await record({ kind: "html", nowMs: 0 });
    expect(result.kind).toBe("html");
    expect(result.publishedAtMs).toBe(0);
  });

  test("keeps the pin when it is omitted", async () => {
    await record({ pin: "project" });
    expect((await record()).pin).toBe("project");
    expect((await record({ pin: "global" })).pin).toBe("global");
    expect((await recordOf("r.md"))?.pin).toBe("global");
  });

  test("a failed lock acquire without an abort signal rethrows its own error", async () => {
    const locks = {
      ...nodeSessionLocks,
      acquireCrossProcessLock: () => Promise.reject(new Error("lock store down")),
    };
    const failure = await record({ locks }).then(
      () => "resolved",
      (error: unknown) => (error as Error).message
    );
    expect(failure).toBe("lock store down");
  });
});

describe("post-compaction artifacts index", () => {
  test("lists published artifacts newest first, and nothing without records", async () => {
    expect(await generateArtifactsIndexAttachment(sessionDir)).toBeNull();
    await recordArtifactPublish({ sessionDir, relPath: "old.md", title: "Old", nowMs: 1 });
    await recordArtifactPublish({ sessionDir, relPath: "new.md", title: "One", nowMs: 5 });
    await recordArtifactPublish({ sessionDir, relPath: "new.md", title: "Two", nowMs: 6 });
    expect(await generateArtifactsIndexAttachment(sessionDir)).toEqual({
      type: "artifacts_index",
      artifacts: [
        { path: "new.md", title: "Two" },
        { path: "old.md", title: "Old" },
      ],
    });
  });
});
