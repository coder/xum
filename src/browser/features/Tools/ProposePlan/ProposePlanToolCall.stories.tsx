import { isPixel } from "@coder/pixel-storybook/storyapi";
import { userEvent, waitFor, within } from "@storybook/test";

import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createProposePlanTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAgentIdKey } from "@/common/constants/storage";

const meta = { ...appMeta, title: "App/Chat/Tools/ProposePlan" };
export default meta;

// The full sticky ToC needs at least 1600px, so the story pins Pixel's 1900px
// desktop viewport instead of the default 1200px laptop width.
const PLAN_TOC_MIN_WIDTH = 1600;
const PLAN_TOC_PIXEL_MATRIX = { viewports: ["desktop"] } as const;

/**
 * Story showing a propose_plan tool call with Plan UI.
 * Tests the plan card rendering with icon action buttons at the bottom.
 */
export const ProposePlan: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan",
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll create a plan for refactoring the authentication module.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createProposePlanTool(
                    "call-plan-1",
                    `# Authentication Module Refactor

## Overview

Refactor the authentication system to improve security and maintainability.

## Tasks

1. **Extract JWT utilities** - Move token generation and validation to dedicated module
2. **Add refresh token support** - Implement secure refresh token rotation
3. **Improve password hashing** - Upgrade to Argon2id with proper salt rounds
4. **Add rate limiting** - Implement per-IP and per-user rate limits
5. **Session management** - Add Redis-backed session store

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
    D --> E[Session management]
\`\`\`

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the ProposePlanToolCall component with a completed plan. " +
          "The plan card displays with the title in the header and icon action buttons " +
          "(Copy, Start Here, Show Text) at the bottom, matching the AssistantMessage aesthetic.",
      },
    },
  },
};

/**
 * Same as ProposePlan but with agent mode set to "plan".
 * Shows the Implement button (no Continue in Auto).
 */
export const ProposePlanInPlanMode: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        window.localStorage.setItem("agentId:ws-plan-mode", JSON.stringify("plan"));

        return setupSimpleChatStory({
          workspaceId: "ws-plan-mode",
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll create a plan for refactoring the authentication module.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createProposePlanTool(
                    "call-plan-1",
                    `# Authentication Module Refactor

## Overview

Refactor the authentication system to improve security and maintainability.

## Tasks

1. **Extract JWT utilities** - Move token generation and validation to dedicated module
2. **Add refresh token support** - Implement secure refresh token rotation
3. **Improve password hashing** - Upgrade to Argon2id with proper salt rounds
4. **Add rate limiting** - Implement per-IP and per-user rate limits
5. **Session management** - Add Redis-backed session store

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
    D --> E[Session management]
\`\`\`

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                  ),
                ],
              }
            ),
          ],
        });
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Same as ProposePlan but with agent mode set to "plan". ' +
          "Shows the Implement button instead of Continue in Auto.",
      },
    },
  },
};

/**
 * Mobile viewport version of ProposePlan.
 *
 * Verifies that on narrow screens the primary plan actions (Implement / Continue in Auto)
 * render as shortcut icons in the left action row (instead of right-aligned buttons).
 */
export const ProposePlanMobile: AppStory = {
  ...ProposePlan,
  parameters: {
    ...ProposePlan.parameters,
    viewport: { defaultViewport: "mobile1" },
    docs: {
      description: {
        story:
          "Renders ProposePlan at an iPhone-sized viewport to verify that Implement / Continue in Auto " +
          "appear as shortcut icons in the left action row (preventing right-side overflow on small screens).",
      },
    },
  },
};

/**
 * #4980: the admin policy allows only Anthropic, and Exec defaults to an OpenAI model.
 * Implement refuses before switching agents and shows why in the card.
 */
export const ProposePlanImplementBlockedByPolicy: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        updatePersistedState(getAgentIdKey("ws-plan-policy"), "plan");

        return setupSimpleChatStory({
          workspaceId: "ws-plan-policy",
          agentAiDefaults: { exec: { modelString: "openai:gpt-5.2" } },
          policyResponse: {
            source: "governor",
            status: { state: "enforced" },
            policy: {
              policyFormatVersion: "0.1",
              providerAccess: [{ id: "anthropic", allowedModels: null }],
              mcp: { allowUserDefined: { stdio: true, remote: true } },
              runtimes: null,
            },
          },
          messages: [
            createUserMessage("msg-1", "Plan the auth refactor", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-2", "Here is the plan.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-1",
                  "# Auth Refactor\n\n1. Extract JWT utilities\n2. Add refresh tokens"
                ),
              ],
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const implement = await canvas.findByRole("button", { name: "Implement" });
    // Explicit timeouts: see ProposePlanWithTableOfContents. Implement enables once the
    // transcript replay caught up; the mock answers policy.get before that.
    await waitFor(
      () => {
        if ((implement as HTMLButtonElement).disabled) throw new Error("Implement still disabled");
      },
      { timeout: 5000 }
    );
    await userEvent.click(implement);
    await waitFor(
      () => {
        const alerts = canvas.queryAllByRole("alert");
        if (!alerts.some((alert) => alert.textContent?.includes("openai:gpt-5.2"))) {
          throw new Error("Expected the policy refusal in the plan card");
        }
      },
      { timeout: 5000 }
    );
  },
  parameters: {
    // Play-only: the Pixel snapshot budget is at its cap.
    pixel: PIXEL_DISABLED,
    docs: {
      description: {
        story:
          "Admin policy excludes the Exec agent's model: Implement stays in plan mode " +
          "and the card says why (#4980).",
      },
    },
  },
};

/**
 * Wide-viewport story that exercises the sticky plan TOC.
 *
 * The TOC lives in an absolutely-positioned `<aside>` outside the centered
 * `max-w-4xl` transcript column, and is gated by a container query on the
 * transcript scrollport. At desktop (1280px) viewport the gate stays closed;
 * the `wide` viewport (1600px) gives the scrollport enough room to reveal
 * the TOC alongside the plan.
 */
export const ProposePlanWithTableOfContents: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-toc",
          messages: [
            createUserMessage("msg-1", "Plan a multi-section refactor with deep structure.", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-2", "Here is the plan with a navigable outline:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-toc",
                  `# Authentication Module Refactor

## Overview

Refactor the auth system to improve security, maintainability, and observability.

## Tasks

### Extract JWT utilities

Move token generation and validation to a dedicated module.

### Add refresh token support

Implement secure refresh token rotation.

### Improve password hashing

Upgrade to Argon2id with proper salt rounds.

### Add rate limiting

Implement per-IP and per-user rate limits.

## Implementation Order

\`\`\`mermaid
graph TD
    A[Extract JWT utils] --> B[Add refresh tokens]
    B --> C[Improve hashing]
    C --> D[Add rate limiting]
\`\`\`

## Rollout

### Staging soak

Two-week staging soak with synthetic traffic.

### Production cutover

Blue/green cutover with automatic rollback on auth-error spikes.

## Success Criteria

- All existing tests pass
- New tests for refresh token flow
- Security audit passes
- Performance benchmarks maintained`
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  globals: {
    viewport: { value: "wide", isRotated: false },
  },
  play: async ({ canvasElement }) => {
    const shouldAssertFullToc = isPixel() || window.innerWidth >= PLAN_TOC_MIN_WIDTH;
    if (!shouldAssertFullToc) {
      return;
    }

    const canvas = within(canvasElement);
    const toc = await canvas.findByTestId("plan-toc-nav");
    // Explicit timeout: preview.tsx's configure({ asyncUtilTimeout }) targets the
    // storybook/test module, not this @storybook/test import, so waitFor would
    // otherwise give up after 1s while the container query settles on loaded CI runners.
    await waitFor(
      () => {
        // Fail if the pinned viewport no longer reveals the full sticky ToC.
        if (window.getComputedStyle(toc).display === "none" || toc.getClientRects().length === 0) {
          // The reveal is a pure CSS container query, so include the widths that
          // drive it: a failure here is a sizing regression, not a timing race.
          const transcript = document.querySelector('[style*="container"], .plan-toc-aware')
            ? [...document.querySelectorAll<HTMLElement>("*")].find((el) =>
                getComputedStyle(el).containerName.includes("transcript")
              )
            : undefined;
          throw new Error(
            "Expected the full plan TOC to be visible in the wide Storybook story " +
              `(innerWidth=${window.innerWidth}, innerHeight=${window.innerHeight}, ` +
              `transcriptContainerWidth=${transcript?.offsetWidth ?? "not-found"})`
          );
        }
      },
      { timeout: 10_000 }
    );
  },
  parameters: {
    viewport: { defaultViewport: "wide" },
    pixel: {
      matrix: PLAN_TOC_PIXEL_MATRIX,
    },
    docs: {
      description: {
        story:
          "Wide-viewport rendering of a multi-section plan. The sticky " +
          '"Contents" navigation appears in the left gutter beside the plan ' +
          "card, anchored to the plan's vertical bounds via `position: sticky` " +
          "inside an absolutely-positioned `<aside>`. " +
          "Visibility is purely CSS-driven (container query + visibility class) " +
          "so toggling the plan tool expanded/collapsed produces no layout jank.",
      },
    },
  },
};

/**
 * Story showing a propose_plan with a code block containing long horizontal content.
 * Tests that code blocks wrap correctly instead of overflowing the container.
 */
export const ProposePlanWithLongCodeBlock: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-plan-overflow",
          messages: [
            createUserMessage("msg-1", "The CI is failing with this error, can you help?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP,
            }),
            createAssistantMessage("msg-2", "I see the issue. Here's my plan to fix it:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP,
              toolCalls: [
                createProposePlanTool(
                  "call-plan-1",
                  `# Fix CI Pipeline Failure

## Problem

The deployment step is failing due to a configuration mismatch:

\`\`\`json
{"error":"ConfigurationError","message":"Environment variable AWS_REGION is required but not set","stack":"at validateConfig (deploy.js:42)","context":{"requiredVars":["AWS_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"],"missingVars":["AWS_REGION"]}}
\`\`\`

## Solution

1. Add the missing \`AWS_REGION\` environment variable to the CI configuration
2. Update the deployment script to provide better error messages
3. Add a pre-flight check to catch missing variables earlier`
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Tests that code blocks within plans wrap correctly instead of overflowing. " +
          "The long JSON error line should wrap within the plan card.",
      },
    },
  },
};
