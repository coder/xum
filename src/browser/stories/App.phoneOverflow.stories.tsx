/**
 * Phone-width overflow checks for #5769: the workspace footer must fit the screen, and a capped
 * bash Script block must show that more of the command sits below the cut.
 */
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ComponentType } from "react";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { STABLE_TIMESTAMP } from "./mocks/workspaces";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { waitForScrollStabilization } from "./storyPlayHelpers.js";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

const meta = { ...appMeta, title: "App/PhoneViewports/Overflow" };
export default meta;

// Fixed-width frame (the Storybook test runner plays at desktop window size, so the story forces
// the phone width itself).
function PhoneFrame(Story: ComponentType) {
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

const LONG_SCRIPT = [
  "set -euo pipefail",
  "for i in 1 2 3; do",
  '  curl -sS https://api.anthropic.com/v1/messages -H "content-type: application/json" -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -d \'{"model":"claude-haiku-4-5","max_tokens":64}\'',
  "  sleep 5",
  "done",
  "echo one",
  "echo two",
  "echo three",
  "echo four",
  "echo five",
].join("\n");

const LONG_BRANCH = "bugbash-playground-with-a-long-name";

const PR_DETECTION_JSON = JSON.stringify({
  number: 5769,
  url: "https://github.com/a-long-organization-name/a-long-repository-name/pull/5769",
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  title: "Phone footer fits",
  isDraft: false,
  headRefName: LONG_BRANCH,
  baseRefName: "main",
  statusCheckRollup: [],
});

// A detected PR swaps the project label for the PR's owner/repo, which can be long too.
function detectLongRepoPR(_workspaceId: string, script: string) {
  return Promise.resolve({
    success: true as const,
    output: script.includes("gh pr view") ? PR_DETECTION_JSON : "",
    exitCode: 0,
    wall_duration_ms: 5,
  });
}

export const FooterAndScriptBlock: AppStory = {
  // A phone viewport for local viewing (the fixed frame does not move innerWidth).
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-phone-overflow",
          // A long branch name: the footer row must truncate it instead of scrolling sideways.
          workspaceName: LONG_BRANCH,
          projectName: "demo-app",
          executeBash: detectLongRepoPR,
          messages: [
            createUserMessage("msg-1", "Call the API three times", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "Done.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 50000,
              toolCalls: [
                {
                  type: "dynamic-tool",
                  toolCallId: "call-bash-long",
                  toolName: "bash",
                  state: "output-available",
                  input: {
                    script: LONG_SCRIPT,
                    timeout_secs: 30,
                    run_in_background: false,
                    display_name: "Call the API",
                  },
                  output: { success: true, output: "ok", exitCode: 0, wall_duration_ms: 900 },
                },
              ],
            }),
          ],
        })
      }
    />
  ),
  decorators: [PhoneFrame],
  // No Pixel capture: the snapshot budget (scripts/check-storybook-snapshot-budget.mjs) is full,
  // and Pixel's animation reset would also remove the scroll-driven fade this story checks.
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForScrollStabilization(storyRoot);

    const narrow = window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`).matches;
    const footerRow = await waitFor(() => {
      const row = storyRoot.querySelector<HTMLElement>(
        '[data-testid="workspace-footer-bar"] > div'
      );
      if (!row) throw new Error("Footer row not rendered");
      return row;
    });
    await waitFor(() => {
      // Phone widths drop "Last prompt" from the footer; wider windows (the test runner) still
      // wait for it so the fit check covers the full row.
      if (!narrow && !footerRow.textContent?.includes("Last prompt")) {
        throw new Error("Footer still loading");
      }
      if (!storyRoot.querySelector('[data-testid="workspace-footer-repository"]')) {
        throw new Error("PR repository label not shown yet");
      }
      // Everything fits: nothing sits past the right edge, so no item can look missing.
      void expect(footerRow.scrollWidth).toBeLessThanOrEqual(footerRow.clientWidth);
    });

    // The collapsed header shows the script's first line (a tooltip can repeat it).
    const [header] = await within(storyRoot).findAllByText(/^set -euo pipefail/);
    await userEvent.click(header);
    const script = await waitFor(() => {
      const pre = [...storyRoot.querySelectorAll("pre")].find((el) =>
        el.textContent?.startsWith("set -euo pipefail")
      );
      if (!pre) throw new Error("Script block not expanded");
      return pre;
    });
    // The block is capped, so part of the command is below the cut ...
    await waitFor(() => expect(script.scrollHeight).toBeGreaterThan(script.clientHeight));
    const bottomFade = () => getComputedStyle(script).getPropertyValue("--scroll-fade-end").trim();
    // ... and the bottom edge fades out to say so.
    await waitFor(() => expect(bottomFade()).not.toMatch(/^(0px)?$/));
    // Scrolled to the end, nothing is cut, so the bottom fade goes away.
    script.scrollTop = script.scrollHeight;
    await waitFor(() => expect(bottomFade()).toBe("0px"));
  },
};

/**
 * The phone footer at its fullest: diff numbers and a long PR repo leave the branch little width.
 * Plays cannot emulate a coarse pointer, so the test runner's postVisit hook replays this story
 * on a touch-emulated small phone and fails if the row clips a control below its touch target.
 * The play only waits until everything that row shows has loaded.
 */
export const FooterTouchTargets: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-phone-footer-touch",
          workspaceName: LONG_BRANCH,
          projectName: "demo-app",
          gitStatus: {
            ahead: 2,
            dirty: 1,
            outgoingAdditions: 635,
            outgoingDeletions: 67,
            headBranch: LONG_BRANCH,
          },
          executeBash: detectLongRepoPR,
          messages: [
            createUserMessage("msg-1", "Check the footer", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP,
            }),
          ],
        })
      }
    />
  ),
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitFor(() => {
      if (!storyRoot.querySelector('[data-testid="workspace-footer-repository"]')) {
        throw new Error("PR repository label not shown yet");
      }
      // Git status reports the branch and the diff numbers together.
      if (!within(storyRoot).queryByRole("button", { name: "Copy branch name" })) {
        throw new Error("Branch not resolved yet");
      }
    });
  },
};
