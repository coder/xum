import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createArtifactListTool } from "./artifact_list";
import { createTestToolConfig, getTestDeps } from "./testHelpers";

const options: ToolExecutionOptions<unknown> = {
  toolCallId: "t1",
  messages: [],
  context: undefined,
};

interface ArtifactListResult {
  success: boolean;
  error?: string;
  artifacts?: Array<{ path: string; kind: string; size: number; modified: string }>;
}

describe("artifact_list tool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-list-tool-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("is only advertised when the artifacts experiment is on", () => {
    expect(getAvailableTools("anthropic:claude-sonnet-4-5")).not.toContain("artifact_list");
    expect(getAvailableTools("anthropic:claude-sonnet-4-5", { enableArtifacts: true })).toContain(
      "artifact_list"
    );
  });

  test("is registered only when the experiment is on and $XUM_SCRATCH_DIR is set", async () => {
    const { initStateManager } = getTestDeps();
    const toolsFor = (config: ReturnType<typeof createTestToolConfig>) =>
      getToolsForModel(
        "anthropic:claude-sonnet-4-20250514",
        config,
        "test-workspace",
        initStateManager
      );
    const base = createTestToolConfig(tempDir);
    const scratchEnv = { XUM_SCRATCH_DIR: path.join(tempDir, "scratch"), XUM_RUNTIME: "worktree" };

    const local = await toolsFor({ ...base, xumEnv: scratchEnv, experiments: { artifacts: true } });
    // No scratch dir (e.g. a devcontainer without a local Docker daemon): no tool.
    const remote = await toolsFor({ ...base, experiments: { artifacts: true } });
    const off = await toolsFor({ ...base, xumEnv: scratchEnv, experiments: { artifacts: false } });

    expect(local.artifact_list).toBeDefined();
    expect(remote.artifact_list).toBeUndefined();
    expect(off.artifact_list).toBeUndefined();
  });

  test("lists files under $XUM_SCRATCH_DIR/artifacts", async () => {
    const scratchDir = path.join(tempDir, "scratch");
    await fs.mkdir(path.join(scratchDir, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(scratchDir, "artifacts", "data.json"), "{}");
    const runtime = new LocalRuntime(tempDir);
    const execSpy = spyOn(runtime, "exec");
    const config = {
      ...createTestToolConfig(tempDir, { runtime }),
      xumEnv: { XUM_SCRATCH_DIR: scratchDir, XUM_RUNTIME: "worktree" },
    };

    const tool = createArtifactListTool(config);
    const result = (await tool.execute!({}, options)) as ArtifactListResult;

    expect(result.success).toBe(true);
    expect(result.artifacts?.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
      { path: "data.json", kind: "json", size: 2 },
    ]);
    expect(Number.isNaN(Date.parse(result.artifacts?.[0]?.modified ?? ""))).toBe(false);
    // Host scratch dirs are read from the host filesystem, not through the runtime.
    expect(execSpy).not.toHaveBeenCalled();
  });

  test("lists SSH/Docker scratch dirs through the runtime, with the same result shape", async () => {
    // A LocalRuntime over a temp dir stands in for the remote host.
    const scratchDir = path.join(tempDir, "remote-scratch");
    await fs.mkdir(path.join(scratchDir, "artifacts", "reports"), { recursive: true });
    await fs.writeFile(path.join(scratchDir, "artifacts", "reports", "summary.md"), "# hi");
    const runtime = new LocalRuntime(tempDir);
    const execSpy = spyOn(runtime, "exec");
    const config = {
      ...createTestToolConfig(tempDir, { runtime }),
      xumEnv: { XUM_SCRATCH_DIR: scratchDir, XUM_RUNTIME: "ssh" },
    };

    const result = (await createArtifactListTool(config).execute!(
      {},
      options
    )) as ArtifactListResult & {
      dir?: string;
      truncated?: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.dir).toBe(path.join(scratchDir, "artifacts"));
    expect(result.truncated).toBe(false);
    expect(result.artifacts?.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
      { path: "reports/summary.md", kind: "markdown", size: 4 },
    ]);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy.mock.calls[0]?.[1].pathEnv).toEqual({
      XUM_ARTIFACTS_DIR: path.join(scratchDir, "artifacts"),
    });
  });

  test("lists a devcontainer mount inside the container where folders cannot be pinned", async () => {
    // The container writes the host-mounted dir; without descriptor paths the host's pathname
    // checks can be raced, so the container lists it instead. With them, the host lists it.
    const scratchDir = path.join(tempDir, "dc-scratch");
    await fs.mkdir(path.join(scratchDir, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(scratchDir, "artifacts", "notes.md"), "# hi");
    const runtime = new LocalRuntime(tempDir);
    const execSpy = spyOn(runtime, "exec");
    const config = {
      ...createTestToolConfig(tempDir, { runtime }),
      xumEnv: { XUM_SCRATCH_DIR: scratchDir, XUM_RUNTIME: "devcontainer" },
    };
    const listPaths = async () =>
      (
        (await createArtifactListTool(config).execute!({}, options)) as ArtifactListResult
      ).artifacts?.map((artifact) => artifact.path);

    expect(await listPaths()).toEqual(["notes.md"]);
    expect(execSpy).not.toHaveBeenCalled();

    const realStat = fs.stat;
    const statSpy = spyOn(fs, "stat").mockImplementation((async (p: string) => {
      if (p === "/proc/self/fd") throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
      return realStat(p);
    }) as typeof fs.stat);
    try {
      expect(await listPaths()).toEqual(["notes.md"]);
      expect(execSpy).toHaveBeenCalledTimes(1);
    } finally {
      statSpy.mockRestore();
    }
  });

  test("explains that the workspace has no artifacts folder when $XUM_SCRATCH_DIR is unset", async () => {
    const tool = createArtifactListTool(createTestToolConfig(tempDir));
    const result = (await tool.execute!({}, options)) as ArtifactListResult;
    expect(result).toEqual({ success: false, error: ARTIFACTS_UNAVAILABLE_REASON });
  });
});
