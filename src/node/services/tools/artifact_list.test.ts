import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
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
    const scratchEnv = { XUM_SCRATCH_DIR: path.join(tempDir, "scratch") };

    const local = await toolsFor({ ...base, xumEnv: scratchEnv, experiments: { artifacts: true } });
    // Remote runtimes (SSH, Docker, devcontainer) have no host scratch dir.
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
    const config = { ...createTestToolConfig(tempDir), xumEnv: { XUM_SCRATCH_DIR: scratchDir } };

    const tool = createArtifactListTool(config);
    const result = (await tool.execute!({}, options)) as ArtifactListResult;

    expect(result.success).toBe(true);
    expect(result.artifacts?.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
      { path: "data.json", kind: "json", size: 2 },
    ]);
    expect(Number.isNaN(Date.parse(result.artifacts?.[0]?.modified ?? ""))).toBe(false);
  });

  test("explains that the runtime has no artifacts folder when the scratch dir is not on this host", async () => {
    const tool = createArtifactListTool(createTestToolConfig(tempDir));
    const result = (await tool.execute!({}, options)) as ArtifactListResult;
    expect(result).toEqual({ success: false, error: ARTIFACTS_UNAVAILABLE_REASON });
  });
});
