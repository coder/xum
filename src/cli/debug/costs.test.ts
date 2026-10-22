import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs";
import { defaultConfig } from "@/node/config";
import * as statsModule from "@/common/utils/tokens/tokenStatsCalculator";
import { costsCommand } from "./costs";

const fakeChatHistory = [
  JSON.stringify({ role: "user", parts: [{ type: "text", text: "hello" }] }),
  JSON.stringify({
    role: "assistant",
    parts: [{ type: "text", text: "hi" }],
    metadata: { model: "anthropic:claude-sonnet-4-20250514" },
  }),
].join("\n");

const mockStats: Awaited<ReturnType<typeof statsModule.calculateTokenStats>> = {
  consumers: [],
  totalTokens: 100,
  model: "anthropic:claude-sonnet-4-20250514",
  tokenizerName: "test",
  usageHistory: [],
};

describe("costsCommand", () => {
  let calculateStatsSpy: ReturnType<typeof spyOn<typeof statsModule, "calculateTokenStats">>;

  beforeEach(() => {
    spyOn(console, "log").mockImplementation(() => undefined);
    spyOn(fs, "existsSync").mockReturnValue(true);
    spyOn(fs, "readFileSync").mockReturnValue(fakeChatHistory);
    calculateStatsSpy = spyOn(statsModule, "calculateTokenStats").mockResolvedValue(mockStats);
  });

  afterEach(() => {
    mock.restore();
  });

  it("passes enableAgentReport true for child workspaces", async () => {
    spyOn(defaultConfig, "findWorkspace").mockReturnValue({
      workspacePath: "/tmp/ws",
      projectPath: "/tmp/proj",
      parentWorkspaceId: "parent-workspace",
    });

    await costsCommand("child-workspace");

    expect(calculateStatsSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      null,
      expect.objectContaining({ enableAgentReport: true })
    );
  });

  it("passes enableAgentReport false for top-level workspaces", async () => {
    spyOn(defaultConfig, "findWorkspace").mockReturnValue({
      workspacePath: "/tmp/ws",
      projectPath: "/tmp/proj",
    });

    await costsCommand("top-level-workspace");

    expect(calculateStatsSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      null,
      expect.objectContaining({ enableAgentReport: false })
    );
  });

  it("withholds review-pane and git-patch tools for scratch workspaces", async () => {
    spyOn(defaultConfig, "findWorkspace").mockReturnValue({
      workspacePath: "/tmp/ws",
      projectPath: "/tmp/proj",
      kind: "scratch",
    });

    await costsCommand("scratch-workspace");

    expect(calculateStatsSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      null,
      expect.objectContaining({ enableReviewPane: false, enableGitPatches: false })
    );
  });

  it("passes enableAgentReport false when workspace not found", async () => {
    spyOn(defaultConfig, "findWorkspace").mockReturnValue(null);

    await costsCommand("unknown-workspace");

    expect(calculateStatsSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      null,
      expect.objectContaining({ enableAgentReport: false })
    );
  });
});
