/**
 * Integration test: web_fetch via a real Anthropic LLM.
 *
 * The shared test project is trusted, so tool hooks can run there. In trusted projects
 * Claude 4.6+ gets Xum's hook-wrapped client web_fetch instead of the provider-native
 * webFetch_20250910 (#5840: native tools bypass tool hooks). This verifies the full
 * round-trip: the model calls the tool, Xum fetches the page from the workspace, and the
 * result is streamed back. Untrusted projects keep the native tool (unit-tested in
 * src/common/utils/tools/tools.test.ts).
 */

import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessageWithModel, assertStreamSuccess } from "../helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "../sendMessageTestHelpers";
import { isToolCallStart } from "@/common/orpc/types";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

type ToolCallEndEvent = Extract<WorkspaceChatMessage, { type: "tool-call-end" }>;

/**
 * Poll for a tool-call-end event by toolName after stream-end.
 * tool-call-end can arrive slightly after stream-end (documented in mcpConfig.test.ts),
 * so we poll briefly rather than reading getEvents() once.
 */
async function waitForToolCallEnd(
  collector: { getEvents(): WorkspaceChatMessage[] },
  toolName: string,
  timeoutMs: number
): Promise<ToolCallEndEvent | undefined> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const match = collector
      .getEvents()
      .filter((e): e is ToolCallEndEvent => e.type === "tool-call-end")
      .find((e) => e.toolName === toolName);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

// Sonnet 4.6 — the model that introduced native web_fetch (webFetch_20250910)
const SONNET_4_6 = "anthropic:claude-sonnet-4-6";

describeIntegration("web_fetch integration tests", () => {
  configureTestRetries(2);

  test.concurrent(
    "should call the client web_fetch in a trusted project and summarize example.com",
    async () => {
      await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector }) => {
        const result = await sendMessageWithModel(
          env,
          workspaceId,
          "Use web_fetch to read https://example.com/ and tell me the page's heading.",
          SONNET_4_6,
          {
            // Enable only web_fetch (disable everything else) so the model uses it naturally
            // without forcing toolChoice on every turn. Using "require" would set
            // toolChoice: { type: "tool" } on ALL turns including the post-result text turn,
            // preventing the model from generating a text response.
            toolPolicy: [
              { regex_match: ".*", action: "disable" },
              { regex_match: "web_fetch", action: "enable" },
            ],
          }
        );

        expect(result.success).toBe(true);

        // web_fetch + LLM summarization can take up to 60s
        await collector.waitForEvent("stream-end", 60000);

        assertStreamSuccess(collector);

        const events = collector.getEvents();

        // Assert the model called web_fetch
        const webFetchStart = events
          .filter(isToolCallStart)
          .find((e) => e.toolName === "web_fetch");
        expect(webFetchStart).toBeDefined();
        expect(webFetchStart?.args).toMatchObject({ url: "https://example.com/" });

        // Poll for tool-call-end after stream-end; it can arrive slightly late.
        const webFetchEnd = await waitForToolCallEnd(collector, "web_fetch", 5000);
        expect(webFetchEnd).toBeDefined();

        // The client tool returns { success, ... }; a provider-native result would carry
        // an Anthropic `type` (web_fetch_result / web_fetch_tool_result_error) instead.
        const toolResult = webFetchEnd?.result as Record<string, unknown> | null | undefined;
        expect(toolResult).toBeTruthy();
        expect(typeof toolResult?.success).toBe("boolean");
        expect(toolResult?.type).toBeUndefined();

        // Assert the model produced a substantive text response about the page
        const responseText = collector.getStreamContent();
        expect(responseText.length).toBeGreaterThan(20);
      });
    },
    75000
  );
});
