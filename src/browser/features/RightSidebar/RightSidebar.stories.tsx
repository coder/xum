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
import { PowerModeProvider } from "@/browser/contexts/PowerModeContext";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { TutorialProvider } from "@/browser/contexts/TutorialContext";
import { WorkspaceProvider } from "@/browser/contexts/WorkspaceContext";
import { SplashScreenProvider } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { TerminalRouterProvider } from "@/browser/terminal/TerminalRouterContext";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { getReviewStateStore } from "@/browser/stores/ReviewStateStore";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createMockORPCClient, type MockSessionUsage } from "@/browser/stories/mocks/orpc";
import { AppWithMocks, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import { blurActiveElement, openSidebarNewTab } from "@/browser/stories/storyPlayHelpers";
import {
  createOnChatAdapter,
  setupSimpleChatStory,
  setupStreamingChatStory,
} from "@/browser/stories/helpers/chatSetup";
import { createStaticChatHandler } from "@/browser/stories/mocks/chatHandlers";
import { textsBelowAaInThemes } from "@/browser/stories/helpers/contrast";
import { setHunkFirstSeen } from "@/browser/stories/helpers/reviews";
import {
  collapseLeftSidebar,
  collapseRightSidebar,
  expandRightSidebar,
  selectWorkspace,
} from "@/browser/stories/helpers/uiState";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  RIGHT_SIDEBAR_WIDTH_KEY,
  SELECTED_WORKSPACE_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { TabType } from "@/browser/types/rightSidebar";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { RightSidebar } from "./RightSidebar.js";

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
    // Same for the review-state store: without a client the review panel never hydrates.
    getReviewStateStore().setClient(client);
    return () => {
      workspaceStore.setClient(null);
      getProvidersConfigStore().setClient(null);
      getReviewStateStore().setClient(null);
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
        <RouterProvider>
          <ProjectProvider>
            <WorkspaceProvider>
              <TerminalRouterProvider>
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
              </TerminalRouterProvider>
            </WorkspaceProvider>
          </ProjectProvider>
        </RouterProvider>
      </APIProvider>
    </ThemeProvider>
  );
}

/** Seed one pane holding exactly these open tabs (the strip shows only opened tabs). */
function seedSidebarLayout(workspaceId: string, tabs: TabType[], activeTab: TabType = tabs[0]) {
  const layout: RightSidebarLayoutState = {
    version: 1,
    openTabsOnly: true,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs, activeTab },
  };
  localStorage.setItem(getRightSidebarLayoutKey(workspaceId), JSON.stringify(layout));
}

/**
 * The selected tab lies fully inside its strip's scroll viewport (not cut off at an edge or
 * hidden behind All tabs). Retries because labels grow after mount (cost badge, counts) and the
 * strip re-scrolls when they do. Stories using it fix the sidebar width themselves, so this
 * holds at any test-runner viewport size.
 */
async function expectSelectedTabVisible(canvasElement: HTMLElement): Promise<void> {
  await waitFor(() => {
    const tab = canvasElement.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const row = tab?.closest<HTMLElement>("[data-tab-scroll-row]");
    if (tab == null || row == null) throw new Error("selected tab not rendered");
    const tabRect = tab.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // Plain throws (not the instrumented expect) so waitFor retries synchronously.
    if (tabRect.left < rowRect.left - 1 || tabRect.right > rowRect.right + 1) {
      throw new Error(
        `selected tab ${Math.round(tabRect.left)}-${Math.round(tabRect.right)} is outside ` +
          `its strip ${Math.round(rowRect.left)}-${Math.round(rowRect.right)}`
      );
    }
  });
}

/**
 * Wait until a diff line's text renders. Matches the panel's whole text, not one element:
 * syntax highlighting splits a line into token spans moments after it first renders, so
 * getByText only matched while the plain line was still up (a race the play could lose).
 */
async function waitForDiffText(canvasElement: HTMLElement, text: RegExp): Promise<void> {
  await waitFor(
    () => {
      const panel = canvasElement.querySelector('[role="tabpanel"]');
      if (!text.test(panel?.textContent ?? ""))
        throw new Error(`diff text ${text.source} not rendered`);
    },
    { timeout: 10_000 }
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
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        seedSidebarLayout("ws-costs", ["costs", "review"], "costs");

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
        expandRightSidebar("ws-costs");
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

        seedSidebarLayout("ws-cache-create", ["costs", "review"], "costs");

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
        expandRightSidebar("ws-cache-create");
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
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        seedSidebarLayout("ws-multi-model", ["costs", "review"], "costs");

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
        expandRightSidebar("ws-multi-model");
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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        seedSidebarLayout("ws-review", ["costs", "review"], "costs");

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
        expandRightSidebar("ws-review");
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
        seedSidebarLayout("ws-stats-idle", ["costs", "review"], "costs");
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
        expandRightSidebar("ws-stats-idle");
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
        seedSidebarLayout("ws-stats-streaming", ["costs", "review"], "costs");
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
        expandRightSidebar("ws-stats-streaming");
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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        // Clear persisted layout to ensure review tab appears in fresh default layout
        const workspaceId = "ws-review-sort";
        seedSidebarLayout(workspaceId, ["costs", "review"], "review");
        const now = Date.now();

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

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/sorting",
          userPreferences: { review: { sortOrder: "last-edit" } },
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
        expandRightSidebar("ws-review-sort");
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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-review-file-order";
        seedSidebarLayout(workspaceId, ["costs", "review"], "review");

        const client = setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/file-order",
          userPreferences: { review: { sortOrder: "file-order" } },
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
        expandRightSidebar("ws-review-file-order");
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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        seedSidebarLayout("ws-diff-alignment", ["costs", "review"], "review");

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
        expandRightSidebar("ws-diff-alignment");
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

    // Wait for diff content to render.
    await waitForDiffText(canvasElement, /add\(a: number/i);

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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        seedSidebarLayout("ws-diff-modification", ["costs", "review"], "review");

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
        expandRightSidebar("ws-diff-modification");
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
    await waitForDiffText(canvasElement, /export const config/i);

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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-read-more";
        seedSidebarLayout(workspaceId, ["costs", "review"], "review");

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
        expandRightSidebar("ws-read-more");
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
        seedSidebarLayout("ws-review-file-filter", ["costs", "review"], "review");
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
        expandRightSidebar("ws-review-file-filter");
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

    // In the light themes, the warning "-N" counts and "M" letters were 1.54:1 on white, and every
    // colored text on the selected file row was below WCAG AA, down to 1.16:1. The filter chip
    // shares the row's tint, and its "✕" was 2.85:1 (#6935).
    const tree = await canvas.findByTestId("review-file-tree");
    const selectedName = await within(tree).findByText("Button.tsx");
    // The selected row is the nearest ancestor that paints a background: the selection tint.
    let selectedRow = selectedName.parentElement;
    while (selectedRow && getComputedStyle(selectedRow).backgroundColor === "rgba(0, 0, 0, 0)") {
      selectedRow = selectedRow.parentElement;
    }
    if (!selectedRow || !tree.contains(selectedRow)) throw new Error("No selected-row tint found");
    const row = selectedRow;
    // The file-type icon is aria-hidden: the file name next to it carries the same information.
    const rowTexts = () =>
      [...row.querySelectorAll<HTMLElement>("*")].filter(
        (element) => !element.closest("[aria-hidden='true']") && element.childElementCount === 0
      );
    const deletionCounts = () => canvas.getAllByText(/^[-−]\d+$|^M$/);
    await expect(
      textsBelowAaInThemes(() => [
        filterIndicator,
        ...new Set([...rowTexts(), ...deletionCounts()]),
      ]).join("\n")
    ).toBe("");
  },
};

export const ReviewTabReadMoreBoundaries: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-read-more-boundaries";
        seedSidebarLayout(workspaceId, ["costs", "review"], "review");

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
        expandRightSidebar("ws-read-more-boundaries");
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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "700");
        const workspaceId = "ws-untracked";
        seedSidebarLayout(workspaceId, ["costs", "review"], "review");

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
        expandRightSidebar("ws-untracked");
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
        localStorage.setItem("statsContainer:subTab", JSON.stringify("cost"));
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        seedSidebarLayout("ws-compact-warning", ["costs", "review"], "costs");

        const client = setupSimpleChatStory({
          workspaceId: "ws-compact-warning",
          workspaceName: "feature/compaction",
          projectName: "my-app",
          agentAiDefaults: { compact: { modelString: "openai:gpt-4o" } },
          // 80% of 200k = 160k, which exceeds gpt-4o's 128k context
          userPreferences: {
            ai: { autoCompactionThresholdByModel: { "anthropic:claude-opus-4-1": 80 } },
          },
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
        expandRightSidebar("ws-compact-warning");
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
  const now = Date.now();

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
  // Empty Output is captured beside the narrow launcher; keep this isolated play for debugging.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        seedSidebarLayout("ws-output-empty", ["costs", "review", "output"], "output");

        const client = setupSimpleChatStory({
          workspaceId: "ws-output-empty",
          workspaceName: "feature/logging",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Hello", { historySequence: 1 })],
          logEntries: [],
        });
        expandRightSidebar("ws-output-empty");
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-output-empty" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const output = await within(canvasElement).findByRole("tabpanel", { name: /^output/i });
    // The Output panel is lazy-loaded: its body arrives after the tabpanel.
    await expect(
      await within(output).findByRole("button", { name: "Delete output logs" })
    ).toBeVisible();
    await expect(output.querySelector(".overflow-y-auto")).toBeEmptyDOMElement();
  },
};

/**
 * Output tab selected with mixed log entries.
 */
export const OutputTabWithLogs: Story = {
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        seedSidebarLayout("ws-output-logs", ["costs", "review", "output"], "output");

        const client = setupSimpleChatStory({
          workspaceId: "ws-output-logs",
          workspaceName: "feature/logging",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Show logs", { historySequence: 1 })],
          logEntries: createOutputLogEntries(),
        });
        expandRightSidebar("ws-output-logs");
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
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        seedSidebarLayout("ws-output-errors", ["costs", "review", "output"], "output");
        // Persist the level filter to "error" so only error entries display.

        const client = setupSimpleChatStory({
          workspaceId: "ws-output-errors",
          workspaceName: "feature/logging",
          // Only error entries display.
          userPreferences: { ui: { outputTabLevel: "error" } },
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Check errors", { historySequence: 1 })],
          logEntries: createOutputLogEntries(),
        });
        expandRightSidebar("ws-output-errors");
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-output-errors" />
    </RightSidebarStoryShell>
  ),
};

/**
 * A fresh workspace: the strip holds only the New tab, whose launcher lists the tools a pane can
 * open (Codex-style empty tab) instead of showing every tool as an idle tab.
 */
export const NewTabLauncher: Story = {
  // Play-only: NewTabLauncherNarrow captures the launcher (and the strip overflow) for Pixel,
  // which keeps this PR within the snapshot budget.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.removeItem(RIGHT_SIDEBAR_TAB_KEY);
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "400");
        localStorage.removeItem(getRightSidebarLayoutKey("ws-new-tab"));

        const client = setupSimpleChatStory({
          workspaceId: "ws-new-tab",
          workspaceName: "feature/new-tab",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Hello", { historySequence: 1 })],
        });
        // The keyboard play opens Workflows, not just its launcher row.
        client.workflows.listScripts = () => Promise.resolve([]);
        expandRightSidebar("ws-new-tab");
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-new-tab" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("tab", { name: /^new tab/i, selected: true });
    await canvas.findByRole("button", { name: "Review" });
    await expect(canvas.getAllByRole("tab")).toHaveLength(1);

    const launcher = canvasElement.querySelector('[role="tabpanel"][id$="-panel-new"]')!;
    const tools = within(launcher as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")!)
      .filter((name) => name !== "Terminal" && name !== "Side chat");
    for (const name of tools) {
      const row = await canvas.findByRole("button", { name });
      row.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => {
        const tab = canvas.getByRole("tab", { selected: true });
        const panel = document.getElementById(tab.getAttribute("aria-controls")!);
        // Review/Artifacts keep their specialized panel focus; other tools focus their tab.
        return expect(
          document.activeElement === tab || panel?.contains(document.activeElement)
        ).toBe(true);
      });
      await openSidebarNewTab(canvasElement);
    }
    // The strip's "+" hands focus to the launcher, which keeps it.
    const launcherHasFocus = () =>
      canvasElement
        .querySelector('[role="tabpanel"][id$="-panel-new"]')
        ?.contains(document.activeElement) === true;
    await waitFor(() => expect(launcherHasFocus()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(launcherHasFocus()).toBe(true);
  },
};

/**
 * The New tab launcher at the sidebar's minimum width (300px), next to more open tabs than fit:
 * launcher rows wrap their descriptions instead of overflowing, and the strip stays one row
 * that scrolls sideways (hidden scrollbar, faded edges) with All tabs pinned at the end.
 */
export const NewTabLauncherNarrow: Story = {
  // Match Pixel's named desktop exactly; the global Storybook "desktop" is smaller.
  parameters: {
    viewport: {
      options: {
        pixelDesktop: {
          name: "Pixel desktop",
          styles: { width: "1900px", height: "1080px" },
          type: "desktop",
        },
      },
    },
  },
  globals: { viewport: { value: "pixelDesktop", isRotated: false } },
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.removeItem(RIGHT_SIDEBAR_TAB_KEY);
        // Share the existing empty-Output captures instead of spending more Pixel variants.
        // After the border/divider, this gives the launcher ~300px and Output ~400px.
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "705");
        const layout: RightSidebarLayoutState = {
          version: 1,
          openTabsOnly: true,
          nextId: 4,
          focusedTabsetId: "launcher",
          root: {
            type: "split",
            id: "launcher-output",
            direction: "vertical",
            sizes: [300 / 7, 400 / 7],
            children: [
              {
                type: "tabset",
                id: "launcher",
                tabs: ["costs", "review", "instructions", "goal", "workflows", "new"],
                activeTab: "new",
              },
              {
                type: "tabset",
                id: "output",
                tabs: ["costs", "review", "output"],
                activeTab: "output",
              },
            ],
          },
        };
        localStorage.setItem(getRightSidebarLayoutKey("ws-new-tab-narrow"), JSON.stringify(layout));

        const client = setupSimpleChatStory({
          workspaceId: "ws-new-tab-narrow",
          workspaceName: "feature/new-tab",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Hello", { historySequence: 1 })],
          sessionUsage: createSessionUsage(0.12),
          logEntries: [],
        });
        expandRightSidebar("ws-new-tab-narrow");
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-new-tab-narrow" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const newTab = await canvas.findByRole("tab", { name: /^new tab/i, selected: true });
    const launcher = newTab.closest<HTMLElement>("[data-tabset-id]")!;
    const sideChat = within(launcher).getByRole("button", { name: "Side chat" });
    await expect(sideChat).toBeVisible();
    await expect(launcher.getBoundingClientRect().width).toBeGreaterThanOrEqual(295);
    await expect(launcher.getBoundingClientRect().width).toBeLessThanOrEqual(305);
    // The open tabs overflow this narrow strip: the selected New tab stays fully reachable.
    await within(launcher).findByRole("tab", { name: /stats.*\$0\.12/i });
    await expectSelectedTabVisible(launcher);

    const output = await canvas.findByRole("tabpanel", { name: /^output/i });
    await expect(output).toBeVisible();
    // The Output panel is lazy-loaded: its body arrives after the tabpanel.
    await expect(
      await within(output).findByRole("button", { name: "Delete output logs" })
    ).toBeVisible();
    await expect(output.querySelector(".overflow-y-auto")).toBeEmptyDOMElement();
    // Both states must share one capture, not merely exist off-screen or in a hidden tab.
    const outputRect = output.getBoundingClientRect();
    await expect(outputRect.left).toBeGreaterThanOrEqual(launcher.getBoundingClientRect().right);
    await expect(outputRect.right).toBeLessThanOrEqual(window.innerWidth);
    await expect(sideChat.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  },
};

/**
 * Many open tabs in a narrow sidebar with a middle tab selected: the strip scrolls that tab
 * fully into view instead of wrapping onto a second line.
 */
export const ManyTabsSingleRow: Story = {
  // Play-only: NewTabLauncherNarrow already captures the overflowing strip for Pixel.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <RightSidebarStoryShell
      setup={() => {
        localStorage.removeItem(RIGHT_SIDEBAR_TAB_KEY);
        localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, "320");
        seedSidebarLayout(
          "ws-many-tabs",
          ["costs", "review", "instructions", "goal", "workflows", "timeline", "output"],
          "timeline"
        );

        const client = setupSimpleChatStory({
          workspaceId: "ws-many-tabs",
          workspaceName: "feature/many-tabs",
          projectName: "my-app",
          messages: [createUserMessage("msg-1", "Hello", { historySequence: 1 })],
          sessionUsage: createSessionUsage(0.34),
        });
        expandRightSidebar("ws-many-tabs");
        return client;
      }}
    >
      <RightSidebarStoryContent workspaceId="ws-many-tabs" />
    </RightSidebarStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("tab", { name: /^timeline/i, selected: true });
    await canvas.findByRole("button", { name: "All tabs" });
    // Wait for the cost badge: it widens Stats after mount, pushing the selected tab right.
    await canvas.findByRole("tab", { name: /stats.*\$0\.34/i });
    await expectSelectedTabVisible(canvasElement);
  },
};

/** Whether a real pointer at the element's center lands on it (what Playwright's click checks). */
function isHitTarget(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit != null && element.contains(hit);
}

/**
 * The right sidebar under a Windows/Linux titlebar-overlay inset. The one-row strip must not be
 * squeezed to nothing, and the selected tab shows whole: capped at the row's width, its label
 * truncates (#7103). Tabs, "+" and All tabs stay clickable.
 */
function titlebarInsetStory(insetPx: number, sidebarWidthPx: number): Story {
  const workspaceId = `ws-inset-${insetPx}`;
  return {
    // Play-only: a regression check, nothing new to look at.
    parameters: { pixel: PIXEL_DISABLED },
    render: () => (
      // On a wrapper, not :root, so the override cannot leak into later stories.
      <div
        className="contents"
        style={{ "--titlebar-right-inset": `${insetPx}px` } as CSSProperties}
      >
        <RightSidebarStoryShell
          setup={() => {
            localStorage.removeItem(RIGHT_SIDEBAR_TAB_KEY);
            localStorage.setItem(RIGHT_SIDEBAR_WIDTH_KEY, String(sidebarWidthPx));
            seedSidebarLayout(workspaceId, ["costs", "review"], "costs");

            const client = setupSimpleChatStory({
              workspaceId,
              workspaceName: "feature/wide-inset",
              projectName: "my-app",
              messages: [createUserMessage("msg-1", "Hello", { historySequence: 1 })],
              // The cost badge makes Stats wider than the row the capped inset leaves.
              sessionUsage: createSessionUsage(0.34),
            });
            expandRightSidebar(workspaceId);
            return client;
          }}
        >
          <RightSidebarStoryContent workspaceId={workspaceId} />
        </RightSidebarStoryShell>
      </div>
    ),
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      const stats = await canvas.findByRole("tab", { name: /stats.*\$0\.34/i, selected: true });
      const review = await canvas.findByRole("tab", { name: /^review/i });
      await expectSelectedTabVisible(canvasElement);
      // "+" (New tab) and All tabs must stay clickable too.
      await waitFor(() => {
        if (!isHitTarget(stats)) throw new Error("selected tab is not under the pointer");
        for (const name of ["New tab", "All tabs"]) {
          if (!isHitTarget(canvas.getByRole("button", { name }))) {
            throw new Error(`${name} is not under the pointer`);
          }
        }
      });
      // Like Playwright: bring the other tab into view, then it must take the click.
      review.scrollIntoView({ block: "nearest", inline: "nearest" });
      await waitFor(() => {
        if (!isHitTarget(review)) throw new Error("unselected tab is not under the pointer");
      });
      await userEvent.click(review);
      await canvas.findByRole("tab", { name: /^review/i, selected: true });
    },
  };
}

/** An inset wider than the pane (Linux e2e reported one larger than the whole sidebar). */
export const TabsReachableUnderWideTitlebarInset = titlebarInsetStory(2000, 400);
/** The 138 px Windows/Linux fallback inset at the sidebar's 300 px minimum width. */
export const SelectedTabFitsUnderTitlebarInset = titlebarInsetStory(138, 300);

const OVERVIEW_WORKSPACE_ID = "ws-overview";

function overviewSideChat(id: string, title: string, createdAt: string): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace({ id, name: id, projectName: "my-app", title, createdAt }),
    sideChatParentWorkspaceId: OVERVIEW_WORKSPACE_ID,
  };
}

/**
 * The collapsed right sidebar (Codex desktop style): instead of a full-height rail it floats a
 * bounded overview card over the chat's top-right corner, and the chat keeps the full width.
 * Rendered in the whole app because the card is positioned against the workspace shell.
 */
export const CollapsedOverview: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  render: () => (
    <AppWithMocks
      setup={() => {
        const client = setupSimpleChatStory({
          workspaceId: OVERVIEW_WORKSPACE_ID,
          workspaceName: "feature/settlement-reconciler",
          messages: [
            createUserMessage("msg-1", "Why did the reconciler withdraw the hedge?", {
              historySequence: 1,
            }),
            createAssistantMessage(
              "msg-2",
              "The order filled for about 49 seconds, then the reconciler reduced it from 25 to " +
                "12 contracts and withdrew the rest. That was a per-order action, not a " +
                "portfolio-wide revision cancellation.",
              { historySequence: 2 }
            ),
          ],
          gitStatus: { ahead: 3, dirty: 2, outgoingAdditions: 29692, outgoingDeletions: 6248 },
          sessionUsage: {
            byModel: {
              "claude-opus-4-5": {
                input: { tokens: 820_000, cost_usd: 4.1 },
                cached: { tokens: 2_400_000, cost_usd: 1.2 },
                cacheCreate: { tokens: 90_000, cost_usd: 0.56 },
                output: { tokens: 64_000, cost_usd: 1.6 },
                reasoning: { tokens: 21_000, cost_usd: 0.53 },
                model: "claude-opus-4-5",
              },
            },
            version: 1,
          },
          additionalWorkspaces: [
            overviewSideChat("side-bq", "Give me the BQ migration", "2026-01-01T10:00:00.000Z"),
            overviewSideChat(
              "side-hedger",
              "How real-time is the hedger?",
              "2026-01-01T11:00:00.000Z"
            ),
          ],
        });
        collapseLeftSidebar();
        // Exercise the app's default: no saved collapsed flag for the workspace.
        collapseRightSidebar();
        return client;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sidebar = await canvas.findByRole(
      "complementary",
      { name: "Workspace insights" },
      { timeout: 15_000 }
    );
    const card = await waitFor(() => {
      const element = sidebar.querySelector<HTMLElement>(".right-sidebar-overview-card");
      if (!element) throw new Error("Overview card not mounted yet");
      return element;
    });
    const sideChats = await within(card).findByRole("region", { name: "Side chats" });
    await within(sideChats).findByText("How real-time is the hedger?");
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: /Changes/ })).toHaveTextContent("+29,692")
    );
    // The session's cost leads the card.
    await within(card).findByRole("button", { name: /\$7\.99/ });
    // The toggle shows beside the card: the card has no expand control of its own.
    await expect(canvas.getByRole("button", { name: "Expand right sidebar" })).toBeVisible();

    // Bounded: the card is a fraction of the workspace's height, and the chat is not narrowed
    // by a collapsed rail: it reaches the workspace's right edge.
    const shell = canvasElement.querySelector<HTMLElement>("[data-workspace-shell]");
    await expect(shell).not.toBeNull();
    await waitFor(async () => {
      const shellRect = shell!.getBoundingClientRect();
      await expect(card.getBoundingClientRect().height).toBeLessThan(shellRect.height / 2);
      await expect(canvas.getByRole("main").getBoundingClientRect().right).toBe(shellRect.right);
    });
    // The transcript makes room for the card: it sits as far from the card as from the left
    // edge of the chat, instead of centering under it.
    const transcript = canvas.getByRole("log", { name: "Conversation transcript" });
    await waitFor(async () => {
      const column = transcript.getBoundingClientRect();
      const leftGap = column.left - canvas.getByRole("main").getBoundingClientRect().left;
      const rightGap = card.getBoundingClientRect().left - column.right;
      await expect(rightGap).toBeGreaterThan(0);
      await expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    });
  },
};

/**
 * Where the transcript column would lose width to the card (a 1000px workspace here), the card
 * stays hidden; the toggle still expands the sidebar.
 */
export const CollapsedOverviewYieldsToTranscript: Story = {
  ...CollapsedOverview,
  // Inside the meta's 1600px frame: a fixed width, so the test runner's window size cannot
  // decide which of the two shows.
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 1000, height: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["desktop"] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Expand right sidebar" }, { timeout: 15_000 });
    // The toggle shows before the card: WorkspaceShell loads the sidebar lazily (#6206), so
    // wait for the card to mount. It is hidden, so no role query can find it.
    const card = await waitFor(
      () => {
        const element = canvasElement.querySelector<HTMLElement>(".right-sidebar-overview-card");
        if (!element) throw new Error("Overview card not mounted yet");
        return element;
      },
      { timeout: 15_000 }
    );
    await expect(getComputedStyle(card).visibility).toBe("hidden");
    // The layout still shows the (zero-width) sidebar, so its shortcuts keep expanding it
    // rather than taking the narrow-layout fallbacks.
    const sidebar = canvasElement.querySelector<HTMLElement>('[aria-label="Workspace insights"]');
    await expect(sidebar).not.toBeNull();
    await expect(getComputedStyle(sidebar!).display).not.toBe("none");
    // Without its card the sidebar is no landmark: assistive tech would find it empty.
    await expect(canvas.queryByRole("complementary", { name: "Workspace insights" })).toBeNull();
  },
};

/**
 * Sliding out, the panel stays painted but takes no focus: Tab right after collapsing does not
 * land on a control that unmounts when the slide ends. The 1000px workspace hides the card, so
 * nothing else in the sidebar can take that focus.
 */
export const CollapsingPanelTakesNoFocus: Story = {
  ...CollapsedOverviewYieldsToTranscript,
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      "button",
      { name: "Expand right sidebar" },
      { timeout: 15_000 }
    );
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    const sidebar = await canvas.findByRole("complementary", { name: "Workspace insights" });
    await waitFor(() => {
      if (sidebar.querySelector('[role="tablist"]') == null || sidebar.getAnimations().length > 0) {
        throw new Error("The sidebar is still sliding open");
      }
    });

    await userEvent.keyboard("{Enter}");
    await expect(toggle).toHaveAccessibleName("Expand right sidebar");
    await userEvent.tab();
    // Still sliding out after the Tab, so the panel was there to tab into.
    await expect(sidebar.querySelector('[role="tablist"]')).not.toBeNull();
    await expect(sidebar.contains(document.activeElement)).toBe(false);
  },
};

/** A scratch workspace's side chat with no usage yet: its collapsed sidebar has nothing to show. */
function setupEmptyOverview(): APIClient {
  const scratchWorkspace = (id: string, title: string) => {
    const path = `/home/user/.mux/scratch/${id}`;
    return {
      ...createWorkspace({
        id,
        name: `scratch-${id}`,
        projectName: "Scratch",
        projectPath: path,
        title,
        runtimeConfig: { type: "local" },
      }),
      kind: "scratch" as const,
      namedWorkspacePath: path,
    };
  };
  const parent = scratchWorkspace("scratch-parent", "Scratch");
  const sideChat = {
    ...scratchWorkspace("scratch-side-chat", "Side question"),
    sideChatParentWorkspaceId: parent.id,
  };
  const workspaces = [parent, sideChat];
  selectWorkspace(sideChat);
  collapseLeftSidebar();
  collapseRightSidebar();
  return createMockORPCClient({
    projects: new Map([
      [
        SCRATCH_PROJECT_CONFIG_KEY,
        {
          projectKind: "system",
          trusted: true,
          workspaces: workspaces.map((workspace) => ({
            kind: "scratch" as const,
            path: workspace.namedWorkspacePath,
            id: workspace.id,
            name: workspace.name,
            runtimeConfig: { type: "local" as const },
          })),
        },
      ],
    ]),
    workspaces,
    onChat: createOnChatAdapter(
      new Map([
        [
          sideChat.id,
          createStaticChatHandler([
            createUserMessage("msg-1", "What does the hedger do?", { historySequence: 1 }),
            createAssistantMessage("msg-2", "It offsets the open position.", {
              historySequence: 2,
            }),
          ]),
        ],
      ])
    ),
  });
}

/**
 * A collapsed sidebar with nothing to summarize shows no card, so the transcript takes the room
 * a card would have had, and no empty landmark is left in its place.
 */
export const CollapsedEmptyOverviewReservesNothing: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={setupEmptyOverview} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Expand right sidebar" }, { timeout: 15_000 });
    const card = await waitFor(
      () => {
        const element = canvasElement.querySelector<HTMLElement>(".right-sidebar-overview-card");
        if (!element) throw new Error("Overview card not mounted yet");
        return element;
      },
      { timeout: 15_000 }
    );
    await expect(getComputedStyle(card).display).toBe("none");
    // The 1600px workspace has room for a card, but reserves none for this one.
    await expect(getPaddingRight(getChatScrollport(canvasElement))).toBe(15);
    await expect(canvas.queryByRole("complementary", { name: "Workspace insights" })).toBeNull();
  },
};

/** The chat scrollport, whose right padding is the room the transcript leaves for the card. */
function getChatScrollport(canvasElement: HTMLElement): HTMLElement {
  return canvasElement.querySelector<HTMLElement>(".chat-reserved-inline-end-scrollport")!;
}

function getPaddingRight(element: HTMLElement): number {
  return parseFloat(getComputedStyle(element).paddingRight);
}

/**
 * A window resize across the card's breakpoint moves the transcript's room for the card at once:
 * only the sidebar's own slide eases it.
 */
export const CollapsedOverviewRoomFollowsResize: Story = {
  ...CollapsedOverview,
  decorators: [
    (Story: ComponentType) => (
      <div data-testid="shell-frame" style={{ width: 1600, height: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sidebar = await canvas.findByRole(
      "complementary",
      { name: "Workspace insights" },
      { timeout: 15_000 }
    );
    await waitFor(() =>
      expect(sidebar.querySelector(".right-sidebar-overview-card")).not.toBeNull()
    );
    const scrollport = getChatScrollport(canvasElement);
    await waitFor(() => expect(getPaddingRight(scrollport)).toBeGreaterThan(100));

    canvas.getByTestId("shell-frame").style.width = "1000px";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await expect(getPaddingRight(scrollport)).toBe(15);
  },
};

interface ToggleFrame {
  toggle: DOMRect;
  sidebarWidth: number;
  card: boolean;
  panel: boolean;
  chatPadding: number;
}

/** Samples the toggle and the sidebar on every animation frame while `act` runs, and after. */
async function sampleToggleFrames(
  canvasElement: HTMLElement,
  act: () => Promise<unknown>
): Promise<ToggleFrame[]> {
  const canvas = within(canvasElement);
  const toggle = canvas.getByTestId("right-sidebar-toggle-bar").querySelector("button")!;
  const sidebar = canvas.getByRole("complementary", { name: "Workspace insights" });
  const scrollport = getChatScrollport(canvasElement);
  const frames: ToggleFrame[] = [];
  let sampling = true;
  const sample = () => {
    frames.push({
      toggle: toggle.getBoundingClientRect(),
      sidebarWidth: sidebar.getBoundingClientRect().width,
      card: sidebar.querySelector(".right-sidebar-overview-card") != null,
      panel: sidebar.querySelector('[role="tablist"]') != null,
      chatPadding: getPaddingRight(scrollport),
    });
    if (sampling) requestAnimationFrame(sample);
  };
  sample();
  await act();
  // The slide takes 200ms; sample well past it.
  await new Promise((resolve) => setTimeout(resolve, 600));
  sampling = false;
  return frames;
}

async function expectSameRect(actual: DOMRect, expected: DOMRect) {
  for (const key of ["left", "top", "width", "height"] as const) {
    await expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(0.1);
  }
}

/**
 * The right sidebar's toggle (like the left one) is one element in both states: it keeps its
 * size, place and focus while the docked width slides, and the header (collapsed) and the tab
 * strip (expanded) reserve its room on their own line.
 */
export const ToggleStaysPutWhileSliding: Story = {
  ...CollapsedOverview,
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sidebar = await canvas.findByRole(
      "complementary",
      { name: "Workspace insights" },
      { timeout: 15_000 }
    );
    await waitFor(() =>
      expect(sidebar.querySelector(".right-sidebar-overview-card")).not.toBeNull()
    );
    const toggle = canvas.getByRole("button", { name: "Expand right sidebar" });
    const header = canvas.getByTestId("workspace-menu-bar");
    const headerRoom = header.querySelector<HTMLElement>("button.right-sidebar-toggle")!;
    // Focus first: focus() may scroll the 1600px frame into the test runner's narrower window.
    toggle.focus();
    const rest = toggle.getBoundingClientRect();
    await expectSameRect(headerRoom.getBoundingClientRect(), rest);

    const opening = await sampleToggleFrames(canvasElement, () => userEvent.keyboard("{Enter}"));
    await expect(toggle).toHaveAccessibleName("Collapse right sidebar");
    await expect(toggle).toHaveFocus();
    for (const frame of opening) await expectSameRect(frame.toggle, rest);
    const openWidth = opening[opening.length - 1].sidebarWidth;
    await expect(openWidth).toBeGreaterThan(200);
    await expect(
      opening.some((frame) => frame.sidebarWidth > 1 && frame.sidebarWidth < openWidth - 1)
    ).toBe(true);
    // Expanding drops the card at once; the panel slides in.
    await expect(opening.some((frame) => frame.card && frame.panel)).toBe(false);

    // The row sits in a wrapper that holds its desktop no-drag region.
    const strip = canvas.getByRole("tablist", { name: "Sidebar views" }).parentElement!
      .parentElement!;
    const stripRoom = strip.querySelector<HTMLElement>('button[aria-hidden="true"]')!;
    await expectSameRect(stripRoom.getBoundingClientRect(), rest);
    await expect(strip.getBoundingClientRect().height).toBe(header.getBoundingClientRect().height);

    const closing = await sampleToggleFrames(canvasElement, () => userEvent.keyboard("{Enter}"));
    await expect(toggle).toHaveAccessibleName("Expand right sidebar");
    await expect(toggle).toHaveFocus();
    for (const frame of closing) await expectSameRect(frame.toggle, rest);
    await expect(closing[closing.length - 1].sidebarWidth).toBe(0);
    await expect(
      closing.some((frame) => frame.sidebarWidth > 1 && frame.sidebarWidth < openWidth - 1)
    ).toBe(true);
    // The card is revealed under the panel as it slides out.
    await expect(closing.some((frame) => frame.card && frame.panel)).toBe(true);
    // The transcript's room for the card eases in with the slide instead of squeezing the
    // column the moment the sidebar starts collapsing.
    const reservedPadding = closing[closing.length - 1].chatPadding;
    await expect(reservedPadding).toBeGreaterThan(100);
    await expect(
      closing.some((frame) => frame.chatPadding > 16 && frame.chatPadding < reservedPadding - 1)
    ).toBe(true);
    await expect(closing[closing.length - 1].panel).toBe(false);
  },
};

/**
 * Dragging the resize handle past the snap point collapses the sidebar, and dragging back
 * reopens it, at once: the width (and the transcript's room for the card) follows the pointer
 * instead of sliding behind it.
 */
export const DragCollapseSnapsWithoutSliding: Story = {
  ...CollapsedOverview,
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sidebar = await canvas.findByRole(
      "complementary",
      { name: "Workspace insights" },
      { timeout: 15_000 }
    );
    await waitFor(() =>
      expect(sidebar.querySelector(".right-sidebar-overview-card")).not.toBeNull()
    );
    await userEvent.click(canvas.getByRole("button", { name: "Expand right sidebar" }));
    // Past the toggle's own slide, and the transcript's easing with it.
    await waitFor(() => {
      const sliding =
        sidebar.querySelector(".right-sidebar-overview-card") != null ||
        sidebar.getAnimations().length > 0 ||
        getChatScrollport(canvasElement).getAnimations().length > 0;
      if (sliding) throw new Error("The sidebar is still sliding open");
    });
    const openWidth = sidebar.getBoundingClientRect().width;
    await expect(openWidth).toBeGreaterThan(200);
    const handle = sidebar.querySelector<HTMLElement>("[data-sidebar-resize-handle]")!;
    const start = handle.getBoundingClientRect();
    const pointer = { pointerId: 7, isPrimary: true, bubbles: true, clientY: start.top + 100 };
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: start.left }));
    await nextFrame();

    const dragTo = (clientX: number) => async () => {
      document.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX }));
      await nextFrame();
    };
    const closing = await sampleToggleFrames(canvasElement, dragTo(start.left + openWidth + 50));
    await expect(closing[closing.length - 1].sidebarWidth).toBe(0);
    await expect(closing[closing.length - 1].panel).toBe(false);
    const reservedPadding = closing[closing.length - 1].chatPadding;
    await expect(reservedPadding).toBeGreaterThan(100);
    for (const frame of closing) {
      await expect([0, openWidth]).toContain(frame.sidebarWidth);
      await expect([15, reservedPadding]).toContain(frame.chatPadding);
    }

    const opening = await sampleToggleFrames(canvasElement, dragTo(start.left));
    document.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: start.left }));
    await expect(opening[opening.length - 1].sidebarWidth).toBe(openWidth);
    for (const frame of opening) await expect([0, openWidth]).toContain(frame.sidebarWidth);
  },
};

/**
 * The shell's toggle bar reserves the full titlebar overlay inset, and the tab strip caps its own
 * (see TabsReachableUnderWideTitlebarInset), so under a wide inset the bar's box reaches over the
 * strip. Linux e2e reports 513px: its viewport is wider than the real window. The strip's
 * controls under the bar must still take clicks.
 */
export const StripReachableUnderToggleBar: Story = {
  ...CollapsedOverview,
  decorators: [
    (Story: ComponentType) => (
      // On a wrapper, not :root, so the override cannot leak into later stories.
      <div className="contents" style={{ "--titlebar-right-inset": "513px" } as CSSProperties}>
        <Story />
      </div>
    ),
  ],
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Expand right sidebar" }, { timeout: 15_000 })
    );
    const allTabs = await canvas.findByRole("button", { name: "All tabs" }, { timeout: 15_000 });
    await waitFor(() => {
      // Like Playwright: bring it into view (the 1600px frame can be wider than the window),
      // again on each retry, since it mounts while the panel is still sliding in.
      allTabs.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (!isHitTarget(allTabs)) throw new Error("All tabs is not under the pointer");
    });
  },
};
