import "./dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { shouldRunIntegrationTests } from "../testUtils";
import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../ipc/helpers";
import type { TestEnvironment } from "../ipc/setup";
import { detectDefaultTrunkBranch } from "@/node/git";
import { createMuxMessage } from "@/common/types/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Actual one-pixel PNGs with different payload bytes: what the host hands out per iconRef.
const PNG_A =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOcAAAAASUVORK5CYII=";
const PNG_B = PNG_A.replace("AAwMCAO+", "AAwMCAO/");
const REF_A = "a".repeat(32);
const REF_B = "b".repeat(32);
const REF_GONE = "c".repeat(32);
const ICONS: Record<string, string> = { [REF_A]: PNG_A, [REF_B]: PNG_B };

const NOTION_SEARCH = "mcp__notion__notion_ai_search";
const NOTION_FETCH = "mcp__notion__notion_fetch";
const NOTION_PAGES = "mcp__notion__notion_create_pages";
const LOCAL_SEARCH = "mcp__local_docs__search";
const INFO_BUTTON = "Server information: notion-work";

function snapshot(iconRef: string | undefined, version = "1.2.0"): MCPToolCallDisplay {
  return {
    connection: { key: "notion-work", transport: "http", origin: "https://mcp.notion.com" },
    identity: { name: "Notion MCP", version, title: "Notion" },
    source: "connection",
    ...(iconRef ? { iconRef } : {}),
  };
}

async function seedHistory(env: TestEnvironment, workspaceId: string) {
  // Seed through the environment's own history service, not a second instance.
  const history = env.services.toORPCContext().historyService;
  const text = { content: [{ type: "text", text: "ok" }] };
  for (const message of [
    createMuxMessage("u1", "user", "Find the setup guide."),
    createMuxMessage("a1", "assistant", "", undefined, [
      {
        type: "dynamic-tool",
        toolCallId: "local",
        toolName: LOCAL_SEARCH,
        state: "output-available",
        input: { query: "setup" },
        output: text,
      },
      {
        type: "dynamic-tool",
        toolCallId: "search",
        toolName: NOTION_SEARCH,
        state: "output-available",
        input: { query: "setup guide" },
        output: text,
        mcpServer: snapshot(REF_A),
      },
      {
        type: "dynamic-tool",
        toolCallId: "fetch",
        toolName: NOTION_FETCH,
        state: "output-available",
        input: { id: "guide" },
        output: text,
        // Same configured key, later capture with a different icon.
        mcpServer: snapshot(REF_B, "1.3.0"),
      },
      {
        type: "dynamic-tool",
        toolCallId: "pages",
        toolName: NOTION_PAGES,
        state: "output-available",
        input: { title: "Notes" },
        output: text,
        // Ref the host no longer knows (restart/eviction): identity stays, icon is generic.
        mcpServer: snapshot(REF_GONE),
      },
      {
        type: "dynamic-tool",
        toolCallId: "code",
        toolName: "code_execution",
        state: "output-available",
        input: { code: "await mux.tool('notion_ai_search', { query: 'q' });" },
        output: { success: true, result: 1, toolCalls: [], consoleOutput: [], duration_ms: 1 },
        nestedCalls: [
          {
            toolCallId: "nested-search",
            toolName: NOTION_SEARCH,
            input: { query: "q" },
            output: text,
            state: "output-available",
            mcpServer: snapshot(REF_A),
          },
          {
            toolCallId: "nested-bash",
            toolName: "bash",
            input: { script: "ls" },
            output: { output: "" },
            state: "output-available",
          },
        ],
      },
    ]),
    createMuxMessage("a2", "assistant", "Done."),
  ]) {
    const result = await history.appendToHistory(workspaceId, message);
    if (!result.success) throw new Error(result.error);
  }
}

/** Header row (expand · badge · name · status) and card for a rendered tool call. */
function toolCard(root: HTMLElement, toolName: string, index = 0) {
  const name = within(root).getAllByText(toolName, { exact: true })[index];
  if (!name?.parentElement?.parentElement) throw new Error(`Tool row ${toolName} not found`);
  return { header: name.parentElement, card: name.parentElement.parentElement, name };
}

describeIntegration("MCP tool call identity in chat", () => {
  beforeAll(preloadTestModules);

  test("shows frozen per-call identity and icons without changing expansion or plain rows", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const getIcon = jest.spyOn(env.services.mcpServerManager, "getIcon");
    const getIcons = jest
      .spyOn(env.services.mcpServerManager, "getIcons")
      .mockImplementation((iconRefs: readonly string[]) =>
        Promise.resolve(Object.fromEntries(iconRefs.map((ref) => [ref, ICONS[ref] ?? null])))
      );
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;
    try {
      const created = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName: generateBranchName("mcp-tool-identity"),
        trunkBranch: await detectDefaultTrunkBranch(repoPath),
      });
      if (!created.success) throw new Error(created.error);
      workspaceId = created.metadata.id;
      await seedHistory(env, workspaceId);

      view = renderApp({ apiClient: env.orpc, metadata: created.metadata });
      await setupWorkspaceView(view, created.metadata, workspaceId);
      const root = view.container;
      const canvas = within(root);
      await canvas.findByText(NOTION_FETCH, { exact: true }, { timeout: 30_000 });

      // Plain row: unchanged, no badge.
      const local = toolCard(root, LOCAL_SEARCH);
      expect(within(local.header).queryByRole("button", { name: /Server information/ })).toBeNull();

      // Branded rows: badge with the short display name; each keeps its own captured icon.
      const search = toolCard(root, NOTION_SEARCH);
      const searchBadge = within(search.header).getByRole("button", { name: INFO_BUTTON });
      expect(searchBadge.textContent).toContain("Notion");
      await waitFor(() => {
        if (searchBadge.querySelector("img")?.getAttribute("src") !== PNG_A)
          throw new Error("Icon A not resolved");
      });
      const fetch = toolCard(root, NOTION_FETCH);
      const fetchBadge = within(fetch.header).getByRole("button", { name: INFO_BUTTON });
      await waitFor(() => {
        if (fetchBadge.querySelector("img")?.getAttribute("src") !== PNG_B)
          throw new Error("Icon B not resolved");
      });

      // Unknown ref: identity shows, icon falls back to the generic glyph.
      const pages = toolCard(root, NOTION_PAGES);
      const pagesBadge = within(pages.header).getByRole("button", { name: INFO_BUTTON });
      await waitFor(() => {
        if (!getIcons.mock.calls.some(([refs]) => refs.includes(REF_GONE)))
          throw new Error("Unknown ref not looked up");
      });
      expect(pagesBadge.querySelector("img")).toBeNull();
      expect(pagesBadge.querySelector("svg")).not.toBeNull();

      // Nested PTC row carries its own snapshot through the same renderer.
      const nested = toolCard(root, NOTION_SEARCH, 1);
      const nestedBadge = within(nested.header).getByRole("button", { name: INFO_BUTTON });
      await waitFor(() => {
        if (nestedBadge.querySelector("img")?.getAttribute("src") !== PNG_A)
          throw new Error("Nested icon not resolved");
      });
      expect(
        within(toolCard(root, "bash").header).queryByRole("button", { name: /Server information/ })
      ).toBeNull();
      // Every distinct ref on screen travels in ONE bulk lookup; rows sharing a
      // ref (top-level + nested A) coalesce, and the singular lookup is unused.
      expect(getIcons).toHaveBeenCalledTimes(1);
      expect([...getIcons.mock.calls[0][0]].sort()).toEqual([REF_A, REF_B, REF_GONE].sort());
      expect(getIcon).not.toHaveBeenCalled();

      // Badge click opens details without expanding the tool; Escape closes; header click expands.
      fireEvent.click(searchBadge);
      const popover = await within(document.body).findByRole("dialog", {
        name: "About notion-work",
      });
      expect(within(popover).getByText("v1.2.0")).toBeTruthy();
      expect(within(popover).getByText("http · https://mcp.notion.com")).toBeTruthy();
      expect(within(search.card).queryByText("Arguments")).toBeNull();
      fireEvent.keyDown(popover, { key: "Escape" });
      await waitFor(() => {
        if (within(document.body).queryByRole("dialog", { name: "About notion-work" }))
          throw new Error("Popover still open");
      });
      fireEvent.click(search.name);
      await within(search.card).findByText("Arguments");
      fireEvent.click(search.name);
      await waitFor(() => {
        if (within(search.card).queryByText("Arguments")) throw new Error("Still expanded");
      });

      // Reconfiguring the server does not relabel or re-icon historical rows.
      const added = await env.orpc.mcp.add({
        name: "notion-work",
        transport: "http",
        url: "https://mcp.example.com/mcp",
      });
      if (!added.success) throw new Error(added.error);
      expect(searchBadge.querySelector("img")?.getAttribute("src")).toBe(PNG_A);
      expect(fetchBadge.querySelector("img")?.getAttribute("src")).toBe(PNG_B);
      expect(within(fetch.header).getByRole("button", { name: INFO_BUTTON })).toBe(fetchBadge);
    } finally {
      if (view) await cleanupView(view, cleanupDom);
      else cleanupDom();
      if (workspaceId) {
        await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      }
      jest.restoreAllMocks();
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});
