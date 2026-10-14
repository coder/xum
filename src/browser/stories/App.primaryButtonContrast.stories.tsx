/**
 * Primary buttons (text on the accent color) reach WCAG AA (4.5:1) at rest and on a real hover in
 * all four themes (#6022). Each story renders one real component per hover pattern:
 * - the shared <Button> default variant (hover background token),
 * - the Workflow empty state's Run button (was hover:opacity-90),
 * - the AGENTS.md init banner's Run /init button (was hover:bg-accent/80).
 *
 * The play hovers through `.storybook/test-runner.ts`, which gives only these stories a real
 * Playwright hover. Under the test runner a missing hook fails the play instead of skipping.
 */

import { expect, waitFor, within } from "@storybook/test";

import { AgentsInitBanner } from "@/browser/components/AgentsInitBanner/AgentsInitBanner";
import { Button } from "@/browser/components/Button/Button";
import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { WorkflowEmptyState } from "@/browser/features/RightSidebar/Workflows/WorkflowEmptyState";
import { textContrast } from "@/browser/stories/helpers/contrast";
import type { AvailableWorkflow } from "@/common/types/workflow";

import { lightweightMeta, PIXEL_DISABLED, type AppStory } from "./meta.js";

export default {
  ...lightweightMeta,
  title: "App/PrimaryButtonContrast",
};

const PROBE = "data-contrast-probe";

/** One arg-less, runnable workflow, so the empty state shows an enabled Run button. */
const SCRIPT: AvailableWorkflow = {
  descriptor: {
    name: "review-pr",
    description: "Review the open pull request.",
    scope: "project",
    executable: true,
  },
  scriptPath: "workflows/review-pr.js",
  args: [],
};

function PrimaryButtons() {
  return (
    <div className="bg-background flex min-h-screen flex-col items-start gap-6 p-6">
      <Button>Save changes</Button>
      <div className="w-80">
        <WorkflowEmptyState scripts={[SCRIPT]} onRun={() => undefined} busyScriptPath={null} />
      </div>
      <div className="w-[36rem]">
        <AgentsInitBanner onRunInit={() => undefined} onDismiss={() => undefined} />
      </div>
    </div>
  );
}

interface HoverHooks {
  __storybookHover?: (selector: string) => Promise<void>;
  __storybookUnhover?: () => Promise<void>;
}

const underTestRunner = () => navigator.userAgent.includes("StorybookTestRunner");

/** Waits until every finite transition or animation on `element` has finished. */
async function settle(element: HTMLElement) {
  // Reading a computed style flushes the style change, so the transition is registered first.
  void getComputedStyle(element).backgroundColor;
  const finite = element
    .getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
  await Promise.all(finite.map((animation) => animation.finished));
}

/** The lowest computed opacity on `element` or any ancestor (1 when nothing is dimmed). */
function minOpacity(element: HTMLElement): number {
  let lowest = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    lowest = Math.min(lowest, Number(getComputedStyle(node).opacity));
  }
  return lowest;
}

interface ProbeResult {
  probe: string;
  state: "rest" | "hover";
  ratio: number;
  opacity: number;
}

async function measure(button: HTMLElement, probe: string, state: ProbeResult["state"]) {
  await settle(button);
  return { probe, state, ratio: textContrast(button), opacity: minOpacity(button) };
}

async function expectPrimaryButtonsReadable(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  // The real enabled controls, one per hover pattern. The probes are set here, not in the
  // components, so production markup does not change for the test.
  const controls = await waitFor(
    () => {
      const found: Array<[string, HTMLElement]> = [
        ["button-default", canvas.getByRole("button", { name: "Save changes" })],
        ["workflow-run", canvas.getByRole("button", { name: "Run" })],
        ["banner-run-init", canvas.getByRole("button", { name: "Run /init" })],
      ];
      for (const [, element] of found) {
        if (element.hasAttribute("disabled")) throw new Error(`${element.textContent} is disabled`);
      }
      return found;
    },
    { timeout: 15_000 }
  );
  await expect(controls).toHaveLength(3);
  for (const [probe, element] of controls) element.setAttribute(PROBE, probe);

  const hooks = window as Window & HoverHooks;
  const canHover = hooks.__storybookHover != null && hooks.__storybookUnhover != null;
  if (underTestRunner() && !canHover) {
    throw new Error("hover hook missing: .storybook/test-runner.ts did not register it");
  }

  const results: ProbeResult[] = [];
  for (const [probe, element] of controls) {
    results.push(await measure(element, probe, "rest"));
    if (!canHover) continue;
    try {
      await hooks.__storybookHover?.(`[${PROBE}="${probe}"]`);
      if (!element.matches(":hover")) throw new Error(`${probe} is not hovered`);
      results.push(await measure(element, probe, "hover"));
    } finally {
      await hooks.__storybookUnhover?.();
    }
  }

  // Opacity is checked on its own: the contrast helper composites background alpha, not opacity.
  const failing = results
    .filter((result) => result.ratio < 4.5 || result.opacity < 1)
    .map(
      (result) =>
        `${result.probe} ${result.state} ${result.ratio.toFixed(2)}:1` +
        (result.opacity < 1 ? ` opacity ${result.opacity}` : "")
    );
  // Thrown, not expect().toBe(), so the runner shows the whole list instead of a truncated diff.
  if (failing.length > 0) throw new Error(`below AA: ${failing.join("; ")}`);
}

const primaryButtonStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  // Behavioral contract only: Pixel's own stories show the colors.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <PrimaryButtons />,
  play: async ({ canvasElement }) => {
    await expectPrimaryButtonsReadable(canvasElement);
  },
});

export const Light = primaryButtonStory("light");
export const FlexokiLight = primaryButtonStory("flexoki-light");
export const Dark = primaryButtonStory("dark");
export const FlexokiDark = primaryButtonStory("flexoki-dark");
