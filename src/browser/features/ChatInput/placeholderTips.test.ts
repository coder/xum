import { afterEach, describe, expect, test } from "bun:test";
import { PLACEHOLDER_TIPS, getPlaceholderTip, getPlaceholderTips } from "./placeholderTips";

interface StorybookGlobal {
  __MUX_STORYBOOK__?: boolean;
}

const TWENTY_MIN_MS = 20 * 60 * 1000;

describe("PLACEHOLDER_TIPS", () => {
  test("tips are unique", () => {
    const unique = new Set(PLACEHOLDER_TIPS);
    expect(unique.size).toBe(PLACEHOLDER_TIPS.length);
  });

  test("leads with the /orchestrate tip so the pinned Storybook slot promotes the new skill", () => {
    // /orchestrate is unadvertised in the system-prompt skill index, so the
    // tip carousel is one of the few discovery surfaces users will see it on.
    // Placing it at the lead slot has two consequences this assertion locks in:
    //   1) It's the tip a user sees on degenerate-timer fallback.
    //   2) It's the tip every visual snapshot renders via the Storybook pin.
    // Demoting it from index 0 would silently regress both surfaces, so we
    // assert the position rather than just the presence.
    expect(PLACEHOLDER_TIPS[0]).toMatch(/\/orchestrate\b/);
  });

  test("advertises durable workflows only when the Dynamic Workflows experiment is on", () => {
    // workflow_run is registered only under the experiment, so the default
    // list must not point users at a tool the agent does not have. The
    // variant swaps a single slot in place so the rotation stays aligned.
    const withWorkflows = getPlaceholderTips({ dynamicWorkflows: true });
    expect(PLACEHOLDER_TIPS.some((tip) => /workflow/i.test(tip))).toBe(false);
    expect(withWorkflows.some((tip) => /workflow/i.test(tip))).toBe(true);
    expect(withWorkflows).toHaveLength(PLACEHOLDER_TIPS.length);
    expect(withWorkflows.filter((tip, i) => tip !== PLACEHOLDER_TIPS[i])).toHaveLength(1);
  });
});

describe("getPlaceholderTip", () => {
  afterEach(() => {
    // Always clear the storybook flag so one test's pin-mode doesn't leak
    // into the next test's rotation assertions.
    delete (globalThis as StorybookGlobal).__MUX_STORYBOOK__;
  });

  test("returns the same tip for every call inside a single 20-minute bucket", () => {
    // Anchor at a bucket boundary so any ms within the next 20 min must hash
    // to the same tip. If they don't, switching workspaces / re-rendering
    // inside the same bucket would reshuffle the tip — which is the exact
    // flicker we're trying to prevent.
    const bucketStart = TWENTY_MIN_MS * 100; // arbitrary aligned anchor
    const tip = getPlaceholderTip(bucketStart);
    expect(getPlaceholderTip(bucketStart + 1)).toBe(tip);
    expect(getPlaceholderTip(bucketStart + TWENTY_MIN_MS - 1)).toBe(tip);
  });

  test("advances to the next tip when the bucket boundary crosses", () => {
    // Crossing the boundary must rotate — otherwise the carousel is silently
    // stuck and the discoverability rationale is broken.
    const bucketStart = TWENTY_MIN_MS * 100;
    const before = getPlaceholderTip(bucketStart);
    const after = getPlaceholderTip(bucketStart + TWENTY_MIN_MS);
    expect(after).not.toBe(before);
  });

  test("wraps with modulo so long-running clocks never lose the placeholder", () => {
    // Far-future timestamps should still resolve to a tip rather than
    // undefined / out-of-bounds.
    const bigFuture = TWENTY_MIN_MS * PLACEHOLDER_TIPS.length * 5 + TWENTY_MIN_MS * 3;
    expect(PLACEHOLDER_TIPS).toContain(getPlaceholderTip(bigFuture));
  });

  test("falls back to the lead tip on non-finite or negative inputs", () => {
    // Defensive: mocked timers, broken clocks, or accidentally-passed
    // sentinels should never produce undefined or throw.
    expect(getPlaceholderTip(-1)).toBe(PLACEHOLDER_TIPS[0]);
    expect(getPlaceholderTip(Number.NaN)).toBe(PLACEHOLDER_TIPS[0]);
    expect(getPlaceholderTip(Number.POSITIVE_INFINITY)).toBe(PLACEHOLDER_TIPS[0]);
  });

  test("pins the default-arg call to the lead tip when running under Storybook", () => {
    // Storybook visual snapshots render 100+ stories that include ChatInput. Without
    // pinning, every reorder or insertion into PLACEHOLDER_TIPS shifts the
    // tip the wall-clock bucket lands on and forces a baseline re-accept on
    // every one of those stories. The fix is a runtime flag set by
    // .storybook/preview.tsx that short-circuits the carousel to slot 0.
    (globalThis as StorybookGlobal).__MUX_STORYBOOK__ = true;

    // Default-arg path: pinned regardless of wall-clock time.
    expect(getPlaceholderTip()).toBe(PLACEHOLDER_TIPS[0]);

    // Explicit nowMs must still rotate even with the flag set, otherwise
    // unit tests that depend on rotation math would silently no-op when
    // someone forgets to clear the flag.
    const bucketStart = TWENTY_MIN_MS * 100;
    const before = getPlaceholderTip(bucketStart);
    const after = getPlaceholderTip(bucketStart + TWENTY_MIN_MS);
    expect(after).not.toBe(before);
  });
});
