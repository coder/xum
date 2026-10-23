import { describe, expect, it, spyOn } from "bun:test";
import type { ToolExecutionOptions } from "ai";

const GLOBAL_WORKSPACE_ID = "workspace-global";
import { TOOL_TEXT_PAGE_MAX_CHARS } from "@/common/constants/toolLimits";
import type { SkillsCatalogReadToolResult } from "@/common/types/tools";
import { createSkillsCatalogReadTool } from "./skills_catalog_read";
import * as catalogFetch from "./skillsCatalogFetch";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing
---
# Test Skill

This is the body of the skill.
`;

const SKILL_MD_WITH_ADVERTISE = `---
name: hidden-skill
description: A skill that should not be advertised
advertise: false
---
# Hidden Skill

This skill is not advertised.
`;

describe("skills_catalog_read", () => {
  it("allows read from project workspace", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-project-workspace");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "my-project",
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: VALID_SKILL_MD,
      path: "skills/test-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "test-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter?.name).toBe("test-skill");
      expect(result.frontmatter?.description).toContain("test skill");
      expect(result.body).toContain("Test Skill");
      expect(result.url).toContain("test-owner/test-repo");
    }

    fetchContentSpy.mockRestore();
  });

  it("pages a long body and reads the rest with offset_chars", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-pages");
    const config = createTestToolConfig(tempDir.path, { workspaceId: GLOBAL_WORKSPACE_ID });
    const body = `# Big Skill\n\n${"step\n".repeat(25_000)}`;
    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: `---\nname: test-skill\ndescription: A big skill\n---\n${body}`,
      path: "skills/test-skill/SKILL.md",
      branch: "main",
    });

    try {
      const tool = createSkillsCatalogReadTool(config);
      const pages: string[] = [];
      let offset: number | undefined;
      let snapshot: string | undefined;
      for (let call = 0; call < 5; call++) {
        const result = (await tool.execute!(
          { owner: "o", repo: "r", skillId: "test-skill", offset_chars: offset, snapshot },
          mockToolCallOptions
        )) as SkillsCatalogReadToolResult;
        if (!result.success) throw new Error(result.error);
        expect(result.body.length).toBeLessThanOrEqual(TOOL_TEXT_PAGE_MAX_CHARS);
        // Only the first page carries the (unbounded) frontmatter.
        if (call === 0) expect(result.frontmatter?.name).toBe("test-skill");
        else expect(result).not.toHaveProperty("frontmatter");
        pages.push(result.body);
        offset = result.nextCharOffset;
        snapshot = result.snapshot;
        if (offset == null) break;
        expect(result.note).toContain(`offset_chars: ${offset}, snapshot: "${snapshot ?? ""}")`);
      }

      expect(pages).toHaveLength(3);
      expect(pages.join("")).toBe(body);
    } finally {
      fetchContentSpy.mockRestore();
    }
  });

  describe("pinned copies", () => {
    const skillMd = (revision: string) =>
      `---\nname: pinned-skill\ndescription: A big skill\n---\n${revision}\n${"step\n".repeat(25_000)}`;

    function setup() {
      const tempDir = new TestTempDir("test-skills-catalog-read-pinned");
      const config = createTestToolConfig(tempDir.path, { workspaceId: GLOBAL_WORKSPACE_ID });
      const state = { revision: "rev-1", now: 1_000_000 };
      const fetchSpy = spyOn(catalogFetch, "fetchSkillContent").mockImplementation(() =>
        Promise.resolve({
          content: skillMd(state.revision),
          path: "skills/p/SKILL.md",
          branch: "main",
        })
      );
      const nowSpy = spyOn(Date, "now").mockImplementation(() => state.now);
      const read = async (page?: { nextCharOffset?: number; snapshot?: string }) => {
        const result = (await createSkillsCatalogReadTool(config).execute!(
          {
            owner: "o",
            repo: "r",
            skillId: "pinned-skill",
            offset_chars: page?.nextCharOffset,
            snapshot: page?.snapshot,
          },
          mockToolCallOptions
        )) as SkillsCatalogReadToolResult;
        if (!result.success) throw new Error(result.error);
        return result;
      };
      return {
        state,
        fetchSpy,
        read,
        [Symbol.dispose]: () => {
          fetchSpy.mockRestore();
          nowSpy.mockRestore();
          tempDir[Symbol.dispose]();
        },
      };
    }

    it("serves later pages from the first page's copy, named in the next-page call", async () => {
      using h = setup();
      const first = await h.read();
      expect(first.note).toContain(`snapshot: "${first.snapshot ?? ""}"`);
      // The branch moves after the first page: later pages still read the first copy.
      h.state.revision = "rev-2";
      const second = await h.read(first);
      expect(h.fetchSpy).toHaveBeenCalledTimes(1);
      expect(second.snapshot).toBe(first.snapshot);
      expect(second.note).not.toContain("disagree");
    });

    it("keeps a sequence's copy when another reader starts over on a new revision", async () => {
      using h = setup();
      const readerA = await h.read();
      h.state.revision = "rev-2";
      const readerB = await h.read();
      expect(readerB.snapshot).not.toBe(readerA.snapshot);

      const nextA = await h.read(readerA);
      expect(h.fetchSpy).toHaveBeenCalledTimes(2);
      expect(nextA.snapshot).toBe(readerA.snapshot);
      expect(nextA.note).not.toContain("disagree");
    });

    it("says so when the sequence's copy is gone and the skill changed", async () => {
      using h = setup();
      const first = await h.read();
      // Expired and changed: the new copy can disagree with the first page.
      h.state.now += 11 * 60 * 1000;
      h.state.revision = "rev-2";
      const late = await h.read(first);
      expect(h.fetchSpy).toHaveBeenCalledTimes(2);
      expect(late.note).toContain(`snapshot ${first.snapshot ?? ""} is no longer cached`);
      // An unknown or absent snapshot is a miss too.
      expect((await h.read({ ...first, snapshot: "unknown" })).note).toContain("disagree");
      const noSnapshot = await h.read({ nextCharOffset: first.nextCharOffset });
      expect(noSnapshot.note).toContain("No snapshot was passed");
    });

    it("needs no note when the refetched copy has the same bytes", async () => {
      using h = setup();
      const first = await h.read();
      h.state.now += 11 * 60 * 1000;
      const late = await h.read(first);
      expect(h.fetchSpy).toHaveBeenCalledTimes(2);
      expect(late.note).not.toContain("disagree");
    });
  });

  it("returns parsed skill content on success", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-success");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: VALID_SKILL_MD,
      path: "skills/test-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "test-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter?.name).toBe("test-skill");
      expect(result.frontmatter?.description).toContain("test skill");
      expect(result.body).toContain("Test Skill");
      expect(result.url).toContain("test-owner/test-repo");
    }

    fetchContentSpy.mockRestore();
  });

  it("preserves canonical frontmatter fields such as advertise", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-advertise");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: SKILL_MD_WITH_ADVERTISE,
      path: "skills/hidden-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "hidden-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.frontmatter?.name).toBe("hidden-skill");
      expect(result.frontmatter?.advertise).toBe(false);
    }

    fetchContentSpy.mockRestore();
  });

  it("returns error when fetch fails", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-fetch-fail");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockRejectedValue(
      new Error("Could not find SKILL.md for skill 'missing-skill' in test-owner/test-repo")
    );

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "missing-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }

    fetchContentSpy.mockRestore();
  });

  it("returns error on invalid SKILL.md content", async () => {
    using tempDir = new TestTempDir("test-skills-catalog-read-invalid-skill-md");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const fetchContentSpy = spyOn(catalogFetch, "fetchSkillContent").mockResolvedValue({
      content: "not valid yaml frontmatter",
      path: "skills/test-skill/SKILL.md",
      branch: "main",
    });

    const tool = createSkillsCatalogReadTool(config);
    const result = (await tool.execute!(
      { owner: "test-owner", repo: "test-repo", skillId: "test-skill" },
      mockToolCallOptions
    )) as SkillsCatalogReadToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }

    fetchContentSpy.mockRestore();
  });
});
