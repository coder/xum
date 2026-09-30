import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ToolExecutionOptions } from "ai";

const GLOBAL_WORKSPACE_ID = "workspace-global";
import type { SkillsCatalogSearchToolResult } from "@/common/types/tools";
import { createSkillsCatalogSearchTool } from "./skills_catalog_search";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

let fetchSpy: { mockRestore: () => void } | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("skills_catalog_search", () => {
  it("allows search from project workspace", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-search-project-workspace");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "my-project",
    });

    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        query: "testing",
        searchType: "keyword",
        count: 1,
        skills: [
          {
            skillId: "test-skill",
            name: "test-skill",
            installs: 42,
            source: "test-owner/test-repo",
          },
        ],
      })
    );

    const tool = createSkillsCatalogSearchTool(config);
    const result = (await tool.execute!(
      { query: "testing" },
      mockToolCallOptions
    )) as SkillsCatalogSearchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.count).toBe(1);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]).toEqual({
        skillId: "test-skill",
        name: "test-skill",
        owner: "test-owner",
        repo: "test-repo",
        installs: 42,
        url: "https://skills.sh/skill/test-skill",
      });
    }
  });

  it("returns search results with parsed source", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-search-success");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        query: "testing",
        searchType: "keyword",
        count: 1,
        skills: [
          {
            skillId: "test-skill",
            name: "test-skill",
            installs: 42,
            source: "test-owner/test-repo",
          },
        ],
      })
    );

    const tool = createSkillsCatalogSearchTool(config);
    const result = (await tool.execute!(
      { query: "testing" },
      mockToolCallOptions
    )) as SkillsCatalogSearchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.count).toBe(1);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]).toEqual({
        skillId: "test-skill",
        name: "test-skill",
        owner: "test-owner",
        repo: "test-repo",
        installs: 42,
        url: "https://skills.sh/skill/test-skill",
      });
    }
  });

  it("skips skills with malformed source values", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-search-malformed-source");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        query: "testing",
        searchType: "keyword",
        count: 2,
        skills: [
          {
            skillId: "valid-skill",
            name: "valid-skill",
            installs: 42,
            source: "test-owner/test-repo",
          },
          {
            skillId: "invalid-skill",
            name: "invalid-skill",
            installs: 5,
            source: "invalid-no-slash",
          },
        ],
      })
    );

    const tool = createSkillsCatalogSearchTool(config);
    const result = (await tool.execute!(
      { query: "testing" },
      mockToolCallOptions
    )) as SkillsCatalogSearchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skills).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.skills[0]).toEqual({
        skillId: "valid-skill",
        name: "valid-skill",
        owner: "test-owner",
        repo: "test-repo",
        installs: 42,
        url: "https://skills.sh/skill/valid-skill",
      });
    }
  });

  it("returns error on API failure", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-search-failure");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const tool = createSkillsCatalogSearchTool(config);
    const result = (await tool.execute!(
      { query: "test" },
      mockToolCallOptions
    )) as SkillsCatalogSearchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
