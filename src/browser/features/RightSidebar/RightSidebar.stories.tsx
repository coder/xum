/**
 * RightSidebar tab stories - testing dynamic tab data display
 *
 * Uses wide viewport (1600px) to ensure RightSidebar tabs are visible.
 */

import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar/ProjectSidebar";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { AboutDialogProvider } from "@/browser/contexts/AboutDialogContext";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { CommandRegistryProvider } from "@/browser/contexts/CommandRegistryContext";
import { ConfirmDialogProvider } from "@/browser/contexts/ConfirmDialogContext";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { PowerModeProvider } from "@/browser/contexts/PowerModeContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { TutorialProvider } from "@/browser/contexts/TutorialContext";
import { UILayoutsProvider } from "@/browser/contexts/UILayoutsContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import { SplashScreenProvider } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { TerminalRouterProvider } from "@/browser/terminal/TerminalRouterContext";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import type { MockSessionUsage } from "@/browser/stories/mocks/orpc";
import { blurActiveElement } from "@/browser/stories/storyPlayHelpers";
import { setupSimpleChatStory, setupStreamingChatStory } from "@/browser/stories/helpers/chatSetup";
import { setHunkFirstSeen, setReviewSortOrder } from "@/browser/stories/helpers/reviews";
import { expandRightSidebar } from "@/browser/stories/helpers/uiState";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  SELECTED_WORKSPACE_KEY,
  UI_THEME_KEY,
  getAutoCompactionThresholdKey,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { RightSidebar } from "./RightSidebar.js";
import { NOW } from "@/browser/stories/storyTime";

const meta: Meta = {
  title: "Features/RightSidebar/RightSidebar",
  component: RightSidebar,
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1600, height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#1e1e1e" },
        { name: "light", value: "#f5f6f8" },
      ],
    },
    pixel: {
      // Wide variant: these stories need >=1600px, so use the 1900px desktop viewport.
      matrix: { themes: ["dark", "light"], viewports: ["desktop"] },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const STORY_PROJECT_PATH = "/home/user/projects/my-app";

function getWorkspacePath(workspaceId: string): string {
  return `/home/user/.mux/src/my-app/${workspaceId}`;
}

function resetStorybookPersistedStateForStory(): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.removeItem(SELECTED_WORKSPACE_KEY);
  localStorage.setItem(UI_THEME_KEY, JSON.stringify("dark"));
}

function getStorybookRenderKey(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const storyId = params.get("id") ?? params.get("path");
  const viewportBucket = window.innerWidth <= 768 ? "narrow" : "wide";
  return storyId ? `${storyId}:${viewportBucket}` : viewportBucket;
}

function RightSidebarStoryShell(props: { setup: () => APIClient; children: ReactNode }) {
  const lastRenderKeyRef = useRef<string | null>(null);
  const clientRef = useRef<APIClient | null>(null);

  const renderKey = getStorybookRenderKey();
  const shouldReset = clientRef.current === null || lastRenderKeyRef.current !== renderKey;

  if (shouldReset) {
    resetStorybookPersistedStateForStory();
    lastRenderKeyRef.current = renderKey;
    clientRef.current = null;
  }

  clientRef.current ??= props.setup();

  const workspaceStore = useWorkspaceStoreRaw();
  const client = clientRef.current;

  useEffect(() => {
    // App stories bypass AppLoader, so manually sync WorkspaceStore to the story client.
    workspaceStore.setClient(client);
    // useProvidersConfig consumers read the shared store, which gets its
    // client from AppLoader in the real app — wire it manually here too.
    getProvidersConfigStore().setClient(client);
    return () => {
      workspaceStore.setClient(null);
      getProvidersConfigStore().setClient(null);
    };
  }, [client, workspaceStore]);

  const selectedWorkspace = readPersistedState<WorkspaceSelection | null>(
    SELECTED_WORKSPACE_KEY,
    null
  );
  const workspaceId = selectedWorkspace?.workspaceId ?? "ws-story";

  return (
    <ThemeProvider>
      <APIProvider key={renderKey ?? "right-sidebar-story"} client={clientRef.current}>
        <PolicyProvider>
          <RouterProvider>
            <ProjectProvider>
              <WorkspaceProvider>
                <TerminalRouterProvider>
                  <ExperimentsProvider>
                    <UILayoutsProvider>
                      <TooltipProvider delayDuration={200}>
                        <SettingsProvider>
                          <AboutDialogProvider>
                            <ProviderOptionsProvider>
                              <SplashScreenProvider>
                                <TutorialProvider>
                                  <CommandRegistryProvider>
                                    <PowerModeProvider>
                                      <ConfirmDialogProvider>
                                        <AgentProvider
                                          workspaceId={workspaceId}
                                          projectPath={STORY_PROJECT_PATH}
                                        >
                                          <ThinkingProvider workspaceId={workspaceId}>
                                            <BackgroundBashProvider workspaceId={workspaceId}>
                                              {props.children}
                                            </BackgroundBashProvider>
                                          </ThinkingProvider>
                                        </AgentProvider>
                                      </ConfirmDialogProvider>
                                    </PowerModeProvider>
                                  </CommandRegistryProvider>
                                </TutorialProvider>
                              </SplashScreenProvider>
                            </ProviderOptionsProvider>
                          </AboutDialogProvider>
                        </SettingsProvider>
                      </TooltipProvider>
                    </UILayoutsProvider>
                  </ExperimentsProvider>
                </TerminalRouterProvider>
              </WorkspaceProvider>
            </ProjectProvider>
          </RouterProvider>
        </PolicyProvider>
      </APIProvider>
    </ThemeProvider>
  );
}

function RightSidebarStoryContent(props: { workspaceId: string }) {
  const width = readPersistedState<number>(RIGHT_SIDEBAR_WIDTH_KEY, 400);

  return (
    <RightSidebar
      workspaceId={props.workspaceId}
      workspacePath={getWorkspacePath(props.workspaceId)}
      projectPath={STORY_PROJECT_PATH}
      width={width}
    />
  );
}

/**
 * Helper to create session usage data with costs
 */
function createSessionUsage(cost: number): MockSessionUsage {
  const inputCost = cost * 0.6;
  const outputCost = cost * 0.2;
  const cachedCost = cost * 0.1;
  const reasoningCost = cost * 0.1;

  return {
    byModel: {
      "claude-sonnet-4-20250514": {
        input: { tokens: 10000, cost_usd: inputCost },
        cached: { tokens: 5000, cost_usd: cachedCost },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 2000, cost_usd: outputCost },
        reasoning: { tokens: 1000, cost_usd: reasoningCost },
        model: "claude-sonnet-4-20250514",
      },
    },
    version: 1,
  };
}

/**
 * Costs tab with session cost displayed in tab label ($0.56)
 */
export const CostsTab: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-costs"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-costs",
          workspaceName: "feature/api",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me build an API", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll help you build a REST API.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: createSessionUsage(0.56),
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-costs" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Session usage is fetched async via WorkspaceStore; wait to avoid snapshot races.
    await waitFor(() => {
      canvas.getByRole("tab", { name: /stats.*\$0\.56/i });
    });
  },
};

/**
 * Costs tab showing cache create vs cache read differentiation.
 * Cache create is more expensive than cache read; both render in grey tones.
 * This story uses realistic Anthropic-style usage where most input is cached.
 */
export const CostsTabWithCacheCreate: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "350");
        const modelUsage = {
          // Realistic Anthropic usage: heavy caching, cache create is expensive
          input: { tokens: 2000, cost_usd: 0.006 },
          cached: { tokens: 45000, cost_usd: 0.0045 }, // Cache read: cheap
          cacheCreate: { tokens: 30000, cost_usd: 0.1125 }, // Cache create: expensive!
          output: { tokens: 3000, cost_usd: 0.045 },
          reasoning: { tokens: 0, cost_usd: 0 },
          model: "anthropic:claude-sonnet-4-20250514",
        };

        localStorage.removeItem(getRightSidebarLayoutKey("ws-cache-create"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-cache-create",
          workspaceName: "feature/caching",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Refactor the auth module", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll refactor the authentication module.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: {
            byModel: {
              [modelUsage.model]: modelUsage,
            },
            lastRequest: {
              model: modelUsage.model,
              usage: modelUsage,
              timestamp: 0,
            },
            version: 1,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-cache-create" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure we're on the Stats tab (layout state can persist across stories).
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i }, { timeout: 10_000 });
    await userEvent.click(statsTab);

    // Wait for session usage to load + render.
    await waitFor(
      () => {
        canvas.getByText(/cache create/i);
        canvas.getByText(/cache read/i);
      },
      { timeout: 15_000 }
    );
  },
};

/**
 * Costs tab with multiple models used in one session.
 * The per-model breakdown table lists each model's tokens and cost.
 */
export const CostsTabMultiModel: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-multi-model"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-multi-model",
          workspaceName: "feature/multi-model",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Plan and implement the parser", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Done: plan reviewed and parser implemented.", {
              historySequence: 2,
            }),
          ],
          sessionUsage: {
            byModel: {
              "anthropic:claude-opus-4-6": {
                input: { tokens: 12000, cost_usd: 0.18 },
                cached: { tokens: 240000, cost_usd: 0.36 },
                cacheCreate: { tokens: 80000, cost_usd: 1.5 },
                output: { tokens: 9000, cost_usd: 0.675 },
                reasoning: { tokens: 4000, cost_usd: 0.3 },
                model: "anthropic:claude-opus-4-6",
              },
              "openai:gpt-5.2": {
                input: { tokens: 30000, cost_usd: 0.0525 },
                cached: { tokens: 50000, cost_usd: 0.021875 },
                cacheCreate: { tokens: 0, cost_usd: 0 },
                output: { tokens: 6000, cost_usd: 0.084 },
                reasoning: { tokens: 8000, cost_usd: 0.112 },
                model: "openai:gpt-5.2",
              },
            },
            version: 1,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-multi-model" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Session usage is fetched async via WorkspaceStore; wait for the
    // per-model breakdown rows to render.
    await waitFor(() => {
      const byModel = canvas.getByTestId("cost-by-model");
      within(byModel).getByText("Opus 4.6");
      within(byModel).getByText("GPT-5.2");
    });
  },
};

/**
 * Review tab selected - click switches from Costs to Review tab
 * Verifies per-tab width persistence: starts at Costs width (350px), switches to Review width (700px)
 */
export const ReviewTab: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-review"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-review",
          workspaceName: "feature/review",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add a new component", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I've added the component.", { historySequence: 2 }),
          ],
          sessionUsage: createSessionUsage(0.42),
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-review" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for session usage to land (avoid theme/mode snapshots diverging on timing).
    await waitFor(() => {
      canvas.getByRole("tab", { name: /stats.*\$0\.42/i });
    });

    // Use findByRole (retry-capable) to handle transient DOM gaps between awaits.
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i });
    await userEvent.click(reviewTab);

    await waitFor(() => {
      canvas.getByRole("tab", { name: /^review/i, selected: true });
    });
  },
};

/**
 * Stats tab (Timing sub-tab) when idle (no timing data) - shows placeholder message
 */
export const StatsTabIdle: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        // Pre-select Timing sub-tab so it shows timing content
        localStorage.setItem("statsContainer:subTab", JSON.stringify("timing"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-stats-idle",
          workspaceName: "feature/stats",
          projectName: "my-app",
          statsTabEnabled: true,
          messages: [
            createUserMessage("msg-1", "Help me with something", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Sure, I can help with that.", { historySequence: 2 }),
          ],
          sessionUsage: createSessionUsage(0.25),
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-stats-idle" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The "Stats" tab (internal key "costs") is default active.
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i });
    await userEvent.click(statsTab);

    await waitFor(() => {
      canvas.getByText(/no timing data yet/i);
    });
  },
};

/**
 * Stats tab (Timing sub-tab) during active streaming - shows timing statistics
 */
export const StatsTabStreaming: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        // Pre-select Timing sub-tab so it shows timing content
        localStorage.setItem("statsContainer:subTab", JSON.stringify("timing"));

        const client = setupStreamingChatStory({
          workspaceId: "ws-stats-streaming",
          workspaceName: "feature/streaming",
          projectName: "my-app",
          statsTabEnabled: true,
          messages: [
            createUserMessage("msg-1", "Write a comprehensive test suite", { historySequence: 1 }),
          ],
          streamingMessageId: "msg-2",
          historySequence: 2,
          streamText: "I'll create a test suite for you. Let me start by analyzing...",
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-stats-streaming" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The "Stats" tab (internal key "costs") should already be active.
    const statsTab = await canvas.findByRole("tab", { name: /^stats/i });
    await userEvent.click(statsTab);

    await waitFor(() => {
      canvas.getByRole("tab", { name: /^stats/i, selected: true });
    });

    // Verify timing section is rendered (use testid since "Timing" appears in both
    // the sub-tab toggle and the section header)
    await waitFor(() => {
      canvas.getByTestId("timing-section");
    });

    // Verify timing table components are displayed
    await waitFor(() => {
      canvas.getByText(/model time/i);
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW TAB SORTING STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sample git diff output for review panel stories
 */
const SAMPLE_DIFF_OUTPUT = `diff --git a/src/utils/format.ts b/src/utils/format.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils/format.ts
@@ -0,0 +1,12 @@
+export function formatDate(date: Date): string {
+  return date.toISOString();
+}
+
+export function formatCurrency(amount: number): string {
+  return \`$\${amount.toFixed(2)}\`;
+}
+
+export function formatPercentage(value: number): string {
+  return \`\${(value * 100).toFixed(1)}%\`;
+}
+
diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index def5678..ghi9012 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,8 +1,15 @@
 import React from 'react';
 
-export const Button = ({ children }) => {
+interface ButtonProps {
+  children: React.ReactNode;
+  variant?: 'primary' | 'secondary';
+  onClick?: () => void;
+}
+
+export const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {
   return (
-    <button className="btn">
+    <button className={\`btn btn-\${variant}\`} onClick={onClick}>
       {children}
     </button>
   );
diff --git a/src/api/client.ts b/src/api/client.ts
index 111aaa..222bbb 100644
--- a/src/api/client.ts
+++ b/src/api/client.ts
@@ -5,6 +5,10 @@ const BASE_URL = '/api';
 export async function fetchData(endpoint: string) {
   const response = await fetch(\`\${BASE_URL}/\${endpoint}\`);
+  if (!response.ok) {
+    throw new Error(\`HTTP error: \${response.status}\`);
+  }
   return response.json();
 }
`;

const SAMPLE_NUMSTAT_OUTPUT = `12\t0\tsrc/utils/format.ts
10\t3\tsrc/components/Button.tsx
4\t0\tsrc/api/client.ts`;

// Hunk IDs generated from the diff content (these match what diffParser produces)
// We use approximate hunk IDs based on how generateHunkId works
const HUNK_IDS = {
  format: "hunk-1a2b3c4d",
  button: "hunk-5e6f7g8h",
  client: "hunk-9i0j1k2l",
};

/**
 * Review tab with hunks sorted by "Last edit" (LIFO order).
 * Shows timestamps in hunk headers indicating when each change was first seen.
 */
export const ReviewTabSortByLastEdit: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        // Clear persisted layout to ensure review tab appears in fresh default layout
        const workspaceId = "ws-review-sort";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));
        const now = NOW;

        // Set up first-seen timestamps for hunks (oldest to newest: format -> button -> client)
        // We use placeholder IDs since exact hash depends on content
        setHunkFirstSeen(workspaceId, {
          // format.ts was seen 2 hours ago
          [HUNK_IDS.format]: now - 2 * 60 * 60 * 1000,
          // Button.tsx was seen 30 minutes ago
          [HUNK_IDS.button]: now - 30 * 60 * 1000,
          // client.ts was seen 5 minutes ago
          [HUNK_IDS.client]: now - 5 * 60 * 1000,
        });

        // Set sort order to "last-edit"
        setReviewSortOrder("last-edit");

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/sorting",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add utilities and refactor button", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Done! Added format utilities and improved Button.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-review-sort" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure the Review tab is active. Storybook can preserve prior sidebar state
    // between captures, so persisted tab selection might not apply until interaction.
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Verify the sort dropdown shows "Last edit"
    // Use a more specific selector since there are multiple combobox elements
    const sortSelect = await canvas.findByRole("combobox", { name: /sort hunks by/i });
    await expect(sortSelect).toHaveValue("last-edit");

    // Wait for hunks to load - look for file paths in the diff
    // Use getAllByText since files appear in both file tree and hunk headers
    await waitFor(() => {
      canvas.getAllByText(/format\.ts/i);
      canvas.getAllByText(/Button\.tsx/i);
      canvas.getAllByText(/client\.ts/i);
    });

    // Verify relative time indicators are shown (e.g., "5m ago", "30m ago", "2h ago")
    // These come from the firstSeenAt timestamps we set
    await waitFor(async () => {
      // At least one relative time indicator should be visible
      const timeIndicators = canvas.getAllByText(/ago|just now/i);
      await expect(timeIndicators.length).toBeGreaterThan(0);
    });
  },
};

/**
 * Review tab with hunks sorted by file order (default).
 * Demonstrates switching between sort modes.
 */
export const ReviewTabSortByFileOrder: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-review-file-order";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        // Set sort order to "file-order" (default)
        setReviewSortOrder("file-order");

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/file-order",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Make some changes", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Changes made.", { historySequence: 2 }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-review-file-order" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active (Storybook may preserve prior tab state).
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Verify the sort dropdown shows "File order"
    // Use a more specific selector since there are multiple combobox elements
    const sortSelect = await canvas.findByRole("combobox", { name: /sort hunks by/i });
    await expect(sortSelect).toHaveValue("file-order");

    // Wait for hunks to load - use getAllByText since files appear in both file tree and hunk headers
    await waitFor(() => {
      canvas.getAllByText(/format\.ts/i);
    });

    // Switch to "Last edit" sorting
    await userEvent.selectOptions(sortSelect, "last-edit");

    await expect(sortSelect).toHaveValue("last-edit");
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DIFF LAYOUT STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Diff with mixed line types for visual alignment testing.
 * Tests that the padding strip at top/bottom of diff aligns correctly with
 * the gutter and code areas in the actual diff lines.
 *
 * Key visual checks:
 * - Top padding strip (green for additions) aligns with first + line's gutter/code split
 * - Bottom padding strip aligns with last line's gutter/code split
 * - The more saturated gutter background ends exactly at the indicator column
 * - The less saturated code background starts at the indicator column
 */
const ALIGNMENT_TEST_DIFF = `diff --git a/src/test.ts b/src/test.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/test.ts
@@ -0,0 +1,8 @@
+// This file tests diff padding alignment
+export function add(a: number, b: number): number {
+  return a + b;
+}
+
+export function subtract(a: number, b: number): number {
+  return a - b;
+}
`;

const ALIGNMENT_TEST_NUMSTAT = `8\t0\tsrc/test.ts`;

/**
 * Review tab with diff focused on padding alignment verification.
 * The saturated green gutter (line numbers) should align perfectly with
 * the top/bottom padding strips. The indicator column (+/-) should have
 * the less saturated code background.
 */
export const DiffPaddingAlignment: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-diff-alignment"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-diff-alignment",
          workspaceName: "feature/alignment-test",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add math utilities", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added the utilities.", { historySequence: 2 }),
          ],
          gitDiff: {
            diffOutput: ALIGNMENT_TEST_DIFF,
            numstatOutput: ALIGNMENT_TEST_NUMSTAT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-diff-alignment" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active.
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    // Wait for Review tab to be selected.
    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Wait for diff content to render
    await waitFor(() => {
      canvas.getByText(/add\(a: number/i);
    });

    // Visual verification: the padding strip should align with the diff gutter
  },
};

/**
 * Diff with context lines (modifications) for alignment testing.
 * Shows a mix of context lines (no background), removals (red), and additions (green).
 * Verifies padding alignment works for the most common diff pattern.
 */
const MODIFICATION_DIFF = `diff --git a/src/config.ts b/src/config.ts
index aaa1111..bbb2222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,7 +1,9 @@
 export const config = {
-  timeout: 1000,
-  retries: 3,
+  timeout: 5000,
+  retries: 5,
+  maxConnections: 10,
   debug: false,
+  verbose: true,
 };
`;

const MODIFICATION_NUMSTAT = `4\t2\tsrc/config.ts`;

/**
 * Review tab with modification diff (context + additions + removals).
 * Tests padding alignment when the first line is context (neutral) and
 * the diff contains mixed line types.
 */
export const DiffPaddingAlignmentModification: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-diff-modification"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-diff-modification",
          workspaceName: "feature/config-update",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Update config values", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Updated config.", { historySequence: 2 }),
          ],
          gitDiff: {
            diffOutput: MODIFICATION_DIFF,
            numstatOutput: MODIFICATION_NUMSTAT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-diff-modification" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active.
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    // Wait for diff content to render
    await waitFor(
      () => {
        canvas.getByText(/export const config/i);
      },
      { timeout: 10_000 }
    );

    // Visual verification for mixed diff types
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// READ-MORE CONTEXT EXPANSION STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sample file content for read-more feature testing.
 * This simulates a longer file where only a portion is shown in the diff.
 */
const BUTTON_FILE_CONTENT = [
  "// Button component with variants",
  "// Created for the design system",
  "//",
  "// Supports: primary, secondary variants",
  "// Accessible by default",
  "",
  "import React from 'react';",
  "",
  "interface ButtonProps {",
  "  children: React.ReactNode;",
  "  variant?: 'primary' | 'secondary';",
  "  onClick?: () => void;",
  "}",
  "",
  "export const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {",
  "  return (",
  "    <button className={`btn btn-${variant}`} onClick={onClick}>",
  "      {children}",
  "    </button>",
  "  );",
  "};",
  "",
  "// Default export for convenience",
  "export default Button;",
];

/**
 * Diff that only shows lines 7-21 of the Button file.
 * The read-more feature should be able to expand to show lines 1-6 above
 * and lines 22-24 below.
 */
const READ_MORE_DIFF_OUTPUT = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index def5678..ghi9012 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -7,8 +7,15 @@ import React from 'react';
 
-export const Button = ({ children }) => {
+interface ButtonProps {
+  children: React.ReactNode;
+  variant?: 'primary' | 'secondary';
+  onClick?: () => void;
+}
+
+export const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {
   return (
-    <button className="btn">
+    <button className={\`btn btn-\${variant}\`} onClick={onClick}>
       {children}
     </button>
   );
`;

const READ_MORE_NUMSTAT_OUTPUT = `10\t3\tsrc/components/Button.tsx`;

/**
 * Review tab with read-more feature to expand context above/below hunks.
 * Click ▲ to show more context above, ▼ to show more context below.
 */
export const ReviewTabReadMore: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-read-more";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/button-types",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add TypeScript types to Button", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Done! Added ButtonProps interface.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: READ_MORE_DIFF_OUTPUT,
            numstatOutput: READ_MORE_NUMSTAT_OUTPUT,
            fileContents: new Map([["src/components/Button.tsx", BUTTON_FILE_CONTENT]]),
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-read-more" />
    </RightSidebarStoryShell>
  ),
  // No play function - interaction testing covered by tests/ui/readMore.integration.test.ts
};

/**
 * Review tab testing boundary behavior (BOF/EOF).
 * Uses a small file where expanding quickly reaches file boundaries.
 */
const SMALL_FILE_CONTENT = [
  "// Tiny utility",
  "export const add = (a: number, b: number) => a + b;",
  "export const sub = (a: number, b: number) => a - b;",
];

const SMALL_FILE_DIFF_OUTPUT = `diff --git a/src/utils/math.ts b/src/utils/math.ts
index aaa1111..bbb2222 100644
--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,2 +1,3 @@
 // Tiny utility
 export const add = (a: number, b: number) => a + b;
+export const sub = (a: number, b: number) => a - b;
`;

const SMALL_FILE_NUMSTAT_OUTPUT = `1\t0\tsrc/utils/math.ts`;

/**
 * Review tab with file filter active - shows the filter indicator prominently
 * User has clicked on a file in the tree to filter hunks to just that file.
 */
export const ReviewTabWithFileFilter: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");

        const workspaceId = "ws-review-file-filter";

        // Set active file filter - this would be set when user clicks a file in tree
        localStorage.setItem(
          `review-file-filter:${workspaceId}`,
          JSON.stringify("src/components/Button.tsx")
        );

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/file-filter",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Refactor button component", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Updated Button.tsx with proper types.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-review-file-filter" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active.
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Wait for file tree to load
    await waitFor(() => {
      canvas.getByText("Files");
    });

    // Verify file filter indicator is visible in the header (has clear button with ✕)
    const filterIndicator = await canvas.findByRole("button", {
      name: /^Button\.tsx\s*✕$/,
    });
    await expect(filterIndicator).toBeInTheDocument();
    await expect(filterIndicator).toHaveTextContent("Button.tsx");
  },
};

export const ReviewTabReadMoreBoundaries: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-read-more-boundaries";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/math-utils",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add subtraction utility", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added sub function.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SMALL_FILE_DIFF_OUTPUT,
            numstatOutput: SMALL_FILE_NUMSTAT_OUTPUT,
            fileContents: new Map([["src/utils/math.ts", SMALL_FILE_CONTENT]]),
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-read-more-boundaries" />
    </RightSidebarStoryShell>
  ),
  // No play function - interaction testing covered by tests/ui/readMore.integration.test.ts
};

/**
 * Review tab with untracked files banner shown prominently above hunks.
 * The banner is collapsible and shows a "Track All Files" button when expanded.
 */
export const ReviewTabWithUntrackedFiles: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("review"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-untracked";
        localStorage.removeItem(getRightSidebarLayoutKey(workspaceId));

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/new-feature",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add new utilities", { historySequence: 1 }),
            createAssistantMessage("msg-2", "Added new files and utilities.", {
              historySequence: 2,
            }),
          ],
          gitDiff: {
            diffOutput: SAMPLE_DIFF_OUTPUT,
            numstatOutput: SAMPLE_NUMSTAT_OUTPUT,
            untrackedFiles: [
              "src/utils/newHelper.ts",
              "src/components/NewComponent.tsx",
              "tests/newHelper.test.ts",
            ],
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-untracked" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Ensure Review tab is active
    const reviewTab = await canvas.findByRole("tab", { name: /^review/i }, { timeout: 10_000 });
    await userEvent.click(reviewTab);

    await waitFor(
      () => {
        canvas.getByRole("tab", { name: /^review/i, selected: true });
      },
      { timeout: 10_000 }
    );

    // Wait for the untracked files banner to appear
    await waitFor(() => {
      canvas.getByText(/3 untracked files/i);
    });

    // Expand the banner to show file list and Track All button
    const bannerButton = canvas.getByText(/untracked files/i);
    await userEvent.click(bannerButton);

    // Wait for expanded content
    await waitFor(() => {
      canvas.getByText("src/utils/newHelper.ts");
      canvas.getByText("Track All Files");
    });

    // Double-RAF for scroll stabilization after banner expansion changes layout
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Blur focus for clean screenshot
    blurActiveElement();
  },
};

/**
 * Stats tab showing compaction model context warning in the always-visible
 * context usage section. When the compaction model (gpt-4o, 128k) has a smaller
 * context window than the auto-compact threshold (80% of 200k = 160k), a warning appears.
 */
export const CompactionModelWarning: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("costs"));
        localStorage.setItem("costsTab:viewMode", JSON.stringify("session"));
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-compact-warning"));

        // Set auto-compact threshold to 80% for anthropic:claude-opus-4-1
        // 80% of 200k = 160k, which exceeds gpt-4o's 128k context
        updatePersistedState(getAutoCompactionThresholdKey("anthropic:claude-opus-4-1"), 80);

        const client = setupSimpleChatStory({
          workspaceId: "ws-compact-warning",
          workspaceName: "feature/compaction",
          projectName: "my-app",
          agentAiDefaults: { compact: { modelString: "openai:gpt-4o" } },
          messages: [
            createUserMessage("msg-1", "Help me refactor this large codebase", {
              historySequence: 1,
            }),
            createAssistantMessage("msg-2", "I'll help you refactor the codebase.", {
              historySequence: 2,
              model: "anthropic:claude-opus-4-1",
              contextUsage: { inputTokens: 150000, outputTokens: 2000 },
            }),
          ],
          sessionUsage: {
            byModel: {
              "anthropic:claude-opus-4-1": {
                input: { tokens: 150000, cost_usd: 2.25 },
                cached: { tokens: 0, cost_usd: 0 },
                cacheCreate: { tokens: 0, cost_usd: 0 },
                output: { tokens: 2000, cost_usd: 0.15 },
                reasoning: { tokens: 0, cost_usd: 0 },
                model: "anthropic:claude-opus-4-1",
              },
            },
            version: 1,
          },
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-compact-warning" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for the warning to appear
    await waitFor(() => {
      canvas.getByText(/compaction model context/i);
    });
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the compaction model context warning when the configured compaction model (gpt-4o, 128k) " +
          "has a smaller context window than the auto-compact threshold (80% of 200k = 160k tokens).",
      },
    },
  },
};

/**
 * Helper to create realistic output log entries with mixed levels and locations.
 */
function createOutputLogEntries() {
  const now = NOW;

  return [
    {
      timestamp: now - 5 * 60_000,
      level: "info" as const,
      message: "Server bootstrap complete on http://localhost:3000",
      location: "src/node/server.ts:42",
    },
    {
      timestamp: now - 4 * 60_000,
      level: "debug" as const,
      message: "Loaded 18 routes from API manifest",
      location: "src/node/router.ts:88",
    },
    {
      timestamp: now - 3 * 60_000,
      level: "warn" as const,
      message: "Deprecated endpoint /v1/users called by legacy client",
      location: "src/node/api/users.ts:133",
    },
    {
      timestamp: now - 2 * 60_000,
      level: "info" as const,
      message: "Redis cache warmup finished with 243 keys",
      location: "src/node/cache/warmup.ts:57",
    },
    {
      timestamp: now - 90_000,
      level: "error" as const,
      message: "Database connection timeout after 5000ms",
      location: "src/node/db/pool.ts:219",
    },
    {
      timestamp: now - 60_000,
      level: "debug" as const,
      message: "Cache hit for user profile query",
      location: "src/node/cache/queryCache.ts:74",
    },
    {
      timestamp: now - 45_000,
      level: "warn" as const,
      message: "Retrying webhook delivery (attempt 2/3)",
      location: "src/node/webhooks/sender.ts:161",
    },
    {
      timestamp: now - 30_000,
      level: "error" as const,
      message: "Failed to parse JSON payload from upstream service",
      location: "src/node/integrations/partnerClient.ts:204",
    },
    {
      timestamp: now - 15_000,
      level: "info" as const,
      message: "Background cleanup job completed successfully",
      location: "src/node/jobs/cleanup.ts:96",
    },
  ];
}

/**
 * Output tab selected with an empty log feed.
 */
export const OutputTabEmpty: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("output"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-output-empty"));
        localStorage.removeItem("output-tab-level");

        const client = setupSimpleChatStory({
          workspaceId: "ws-output-empty",
          workspaceName: "feature/logging",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Hello", { historySequence: 1 })],
          logEntries: [],
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-output-empty" />
    </RightSidebarStoryShell>
  ),
};

/**
 * Output tab selected with mixed log entries.
 */
export const OutputTabWithLogs: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("output"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-output-logs"));
        localStorage.removeItem("output-tab-level");

        const client = setupSimpleChatStory({
          workspaceId: "ws-output-logs",
          workspaceName: "feature/logging",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Show logs", { historySequence: 1 })],
          logEntries: createOutputLogEntries(),
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-output-logs" />
    </RightSidebarStoryShell>
  ),
};

/**
 * Output tab with persisted level filter set to "error".
 */
export const OutputTabErrorsOnly: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, JSON.stringify("output"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-output-errors"));
        // Persist the level filter to "error" so only error entries display.
        localStorage.setItem("output-tab-level", JSON.stringify("error"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-output-errors",
          workspaceName: "feature/logging",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Check errors", { historySequence: 1 })],
          logEntries: createOutputLogEntries(),
        });
        expandRightSidebar();
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-output-errors" />
    </RightSidebarStoryShell>
  ),
};
