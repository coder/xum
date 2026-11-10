import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ArtifactToolResult } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as artifactsOperationsModule from "@/node/services/artifactsOperations";
import { getArtifactId, readArtifactRecord } from "@/node/services/artifactRecordStore";
import { createArtifactTool } from "./artifact";
import { createArtifactListTool } from "./artifact_list";
import { createArtifactReadTool } from "./artifact_read";
import { PROJECT_SHELF_MULTI_PROJECT_ERROR } from "@/node/services/artifactShelf";
import { createTestToolConfig, getTestDeps } from "./testHelpers";

const options: ToolExecutionOptions<unknown> = {
  toolCallId: "t1",
  messages: [],
  context: undefined,
};

describe("artifact tool", () => {
  let tempDir: string;
  let scratchDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-tool-"));
    scratchDir = path.join(tempDir, "scratch");
    sessionDir = path.join(tempDir, "session");
    await fs.mkdir(path.join(scratchDir, "artifacts"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const configFor = (runtimeMode = "worktree", runtime = new LocalRuntime(tempDir)) => ({
    ...createTestToolConfig(tempDir, { sessionsDir: sessionDir, runtime }),
    xumEnv: { XUM_SCRATCH_DIR: scratchDir, XUM_RUNTIME: runtimeMode },
    experiments: { artifacts: true },
    artifactShelfRoot: path.join(tempDir, "shelf"),
    workspaceProjectPath: "/repos/app",
  });

  const run = async (
    input: Parameters<NonNullable<ReturnType<typeof createArtifactTool>["execute"]>>[0],
    config = configFor()
  ) => (await createArtifactTool(config).execute!(input, options)) as ArtifactToolResult;

  test("is registered only with the experiment, a scratch dir and a session dir", async () => {
    const { initStateManager } = getTestDeps();
    const toolsFor = (config: ReturnType<typeof createTestToolConfig>) =>
      getToolsForModel("anthropic:claude-sonnet-4-20250514", config, "ws", initStateManager);
    const on = configFor();
    expect((await toolsFor(on)).artifact).toBeDefined();
    expect((await toolsFor({ ...on, workspaceSessionDir: undefined })).artifact).toBeUndefined();
    expect((await toolsFor({ ...on, experiments: { artifacts: false } })).artifact).toBeUndefined();
    expect((await toolsFor({ ...on, xumEnv: {} })).artifact).toBeUndefined();
  });

  test("publishing records one title, kind and pin per path, and republishing updates them", async () => {
    const file = path.join(scratchDir, "artifacts", "chart.html");
    await fs.writeFile(file, "<p>1</p>");
    const first = await run({ path: "chart.html", title: "interactive chart", pin: "project" });
    expect(first).toEqual({
      success: true,
      path: "chart.html",
      bytes: 8,
      kind: "html",
      title: "interactive chart",
      pin: "project",
    });
    await fs.writeFile(file, "<p>two</p>");
    // Absolute path inside the artifacts dir; no title → file name; omitted pin keeps "project".
    const second = await run({ path: file });
    expect(second).toEqual({
      success: true,
      path: "chart.html",
      bytes: 10,
      kind: "html",
      title: "chart.html",
      pin: "project",
    });
    expect(await readArtifactRecord(sessionDir, getArtifactId("chart.html"))).toMatchObject({
      title: "chart.html",
      pin: "project",
    });
  });

  test("kind override is stored with the record", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "flow.txt"), "graph TD; a-->b");
    expect(await run({ path: "flow.txt", kind: "mermaid" })).toMatchObject({ kind: "mermaid" });
    expect((await readArtifactRecord(sessionDir, getArtifactId("flow.txt")))?.kind).toBe("mermaid");
  });

  test("refuses paths outside the artifacts dir and missing files", async () => {
    expect(await run({ path: "/etc/hosts" })).toMatchObject({ success: false });
    expect(await run({ path: "../x.md" })).toMatchObject({ success: false });
    expect(await run({ path: "missing.md" })).toEqual({
      success: false,
      error: "Artifact not found: missing.md",
    });
  });

  test("SSH/Docker scratch dirs are copied through the runtime", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "r.md"), "# remote");
    const runtime = new LocalRuntime(tempDir);
    const execSpy = spyOn(runtime, "exec");
    const result = await run({ path: "r.md" }, configFor("ssh", runtime));
    expect(result).toMatchObject({ success: true, bytes: 8 });
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  test("artifact_list shows the title of published artifacts", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "a.md"), "a");
    await fs.writeFile(path.join(scratchDir, "artifacts", "b.md"), "b");
    await run({ path: "a.md", title: "Alpha" });
    const listed = (await createArtifactListTool(configFor()).execute!({}, options)) as {
      artifacts: Array<{ path: string; title?: string }>;
    };
    // Both files can share an mtime millisecond, so the listing order is not part of this check.
    expect(
      listed.artifacts
        .map(({ path, title }) => ({ path, title }))
        .sort((a, b) => a.path.localeCompare(b.path))
    ).toEqual([
      { path: "a.md", title: "Alpha" },
      { path: "b.md", title: undefined },
    ]);
  });
});

describe("artifact tool shelf pin (M5c)", () => {
  let tempDir: string;
  let scratchDir: string;
  let sessionDir: string;
  let shelfRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-shelf-tool-"));
    scratchDir = path.join(tempDir, "scratch");
    sessionDir = path.join(tempDir, "session");
    shelfRoot = path.join(tempDir, "xum", "artifacts");
    await fs.mkdir(path.join(scratchDir, "artifacts"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const configFor = (projects?: Array<{ projectPath: string; projectName: string }>) => ({
    ...createTestToolConfig(tempDir, { sessionsDir: sessionDir }),
    xumEnv: { XUM_SCRATCH_DIR: scratchDir, XUM_RUNTIME: "worktree" },
    experiments: { artifacts: true },
    artifactShelfRoot: shelfRoot,
    workspaceProjectPath: "/repos/app",
    projects,
  });

  test("pin copies the file to the shelf; artifact_list and artifact_read see it", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "plan.md"), "# Plan v1");
    const config = configFor();
    expect(
      await createArtifactTool(config).execute!(
        { path: "plan.md", title: "migration plan", pin: "project" },
        options
      )
    ).toMatchObject({ success: true, pin: "project" });

    // Another workspace of the same project (same identity, its own session dir) lists it.
    const other = { ...configFor(), workspaceSessionDir: path.join(tempDir, "other-session") };
    const listed = (await createArtifactListTool(other).execute!({ scope: "shelf" }, options)) as {
      shelf: Array<{
        scope: string;
        name: string;
        title: string;
        pinnedBy: string;
        source: unknown;
      }>;
    };
    expect(listed.shelf).toHaveLength(1);
    expect(listed.shelf[0]).toMatchObject({
      scope: "project",
      name: "plan.md",
      title: "migration plan",
      pinnedBy: "agent",
      source: { workspaceId: "test-workspace", path: "plan.md" },
    });
    expect(
      await createArtifactReadTool(other).execute!({ scope: "project", path: "plan.md" }, options)
    ).toMatchObject({ success: true, content: "# Plan v1", title: "migration plan" });
  });

  test("a cancelled publish pins nothing, and the cancel signal reaches both reads", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "plan.md"), "# Plan");
    const config = configFor();
    const controller = new AbortController();
    const readOriginal = artifactsOperationsModule.readArtifactBytesAtLocation;
    const signals: Array<AbortSignal | undefined> = [];
    const read = spyOn(artifactsOperationsModule, "readArtifactBytesAtLocation");
    read.mockImplementation((...args) => {
      signals.push(args[3]);
      return readOriginal(...args);
    });
    try {
      expect(
        await createArtifactTool(config).execute!(
          { path: "plan.md", pin: "global" },
          { ...options, abortSignal: controller.signal }
        )
      ).toMatchObject({ success: true, pin: "global" });
      controller.abort();
      expect(
        await createArtifactTool(config).execute!(
          { path: "plan.md", title: "again", pin: "project" },
          { ...options, abortSignal: controller.signal }
        )
      ).toEqual({ success: false, error: "Publish was interrupted" });
    } finally {
      read.mockRestore();
    }
    // The first call read the file twice (publish, then pin), each with the tool's signal.
    expect(signals.slice(0, 2)).toEqual([controller.signal, controller.signal]);
    const shelf = (await createArtifactListTool(config).execute!({ scope: "shelf" }, options)) as {
      shelf: Array<{ scope: string }>;
    };
    expect(shelf.shelf.map((entry) => entry.scope)).toEqual(["global"]);
  });

  test("a project pin from a multi-project workspace is refused before publishing", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "x.md"), "x");
    const config = configFor([
      { projectPath: "/repos/a", projectName: "a" },
      { projectPath: "/repos/b", projectName: "b" },
    ]);
    expect(
      await createArtifactTool(config).execute!({ path: "x.md", pin: "project" }, options)
    ).toEqual({ success: false, error: PROJECT_SHELF_MULTI_PROJECT_ERROR });
    expect(await readArtifactRecord(sessionDir, getArtifactId("x.md"))).toBeNull();
    // Global pins still work there.
    expect(
      await createArtifactTool(config).execute!({ path: "x.md", pin: "global" }, options)
    ).toMatchObject({ success: true });
  });

  test("artifact_read refuses binary kinds and unknown names", async () => {
    await fs.writeFile(path.join(scratchDir, "artifacts", "img.png"), Buffer.from([0x89, 0x50]));
    const config = configFor();
    await createArtifactTool(config).execute!({ path: "img.png", pin: "global" }, options);
    expect(
      await createArtifactReadTool(config).execute!({ scope: "global", path: "img.png" }, options)
    ).toMatchObject({ success: false });
    const binary = (await createArtifactReadTool(config).execute!(
      { scope: "global", path: "img.png" },
      options
    )) as { error?: string };
    expect(binary.error).toContain("text artifacts only");
    expect(
      await createArtifactReadTool(config).execute!(
        { scope: "global", path: "../img.png" },
        options
      )
    ).toMatchObject({ success: false });
  });

  test("artifact_read refuses a text-kind entry whose bytes are binary", async () => {
    // The live reader treats NUL bytes as binary; a pinned copy must not decode them as text.
    await fs.writeFile(path.join(scratchDir, "artifacts", "notes.md"), Buffer.from("a\0b"));
    const config = configFor();
    expect(
      await createArtifactTool(config).execute!({ path: "notes.md", pin: "global" }, options)
    ).toMatchObject({ success: true });
    const read = (await createArtifactReadTool(config).execute!(
      { scope: "global", path: "notes.md" },
      options
    )) as { success: boolean; error?: string };
    expect(read.success).toBe(false);
    expect(read.error).toContain("binary");
  });
});
