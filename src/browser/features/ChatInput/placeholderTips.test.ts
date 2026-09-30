import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PLACEHOLDER_TIPS, getPlaceholderTip, getPlaceholderTips } from "./placeholderTips";

interface StorybookGlobal {
  __MUX_STORYBOOK__?: boolean;
}

const TWENTY_MIN_MS = 20 * 60 * 1000;

/** The tip the carousel shows while the wall clock reads `nowMs`. */
function tipAt(nowMs: number): string {
  const now = spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    return getPlaceholderTip();
  } finally {
    now.mockRestore();
  }
}

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
    const tip = tipAt(bucketStart);
    expect(tipAt(bucketStart + 1)).toBe(tip);
    expect(tipAt(bucketStart + TWENTY_MIN_MS - 1)).toBe(tip);
  });

  test("advances to the next tip when the bucket boundary crosses", () => {
    // Crossing the boundary must rotate — otherwise the carousel is silently
    // stuck and the discoverability rationale is broken.
    const bucketStart = TWENTY_MIN_MS * 100;
    const before = tipAt(bucketStart);
    const after = tipAt(bucketStart + TWENTY_MIN_MS);
    expect(after).not.toBe(before);
  });

  test("wraps with modulo so long-running clocks never lose the placeholder", () => {
    // Far-future timestamps should still resolve to a tip rather than
    // undefined / out-of-bounds.
    const bigFuture = TWENTY_MIN_MS * PLACEHOLDER_TIPS.length * 5 + TWENTY_MIN_MS * 3;
    expect(PLACEHOLDER_TIPS).toContain(tipAt(bigFuture));
  });

  test("falls back to the lead tip on a non-finite or negative clock", () => {
    // Defensive: mocked timers or broken clocks should never produce
    // undefined or throw.
    expect(tipAt(-1)).toBe(PLACEHOLDER_TIPS[0]);
    expect(tipAt(Number.NaN)).toBe(PLACEHOLDER_TIPS[0]);
    expect(tipAt(Number.POSITIVE_INFINITY)).toBe(PLACEHOLDER_TIPS[0]);
  });

  test("pins the lead tip when running under Storybook", () => {
    // Storybook visual snapshots render 100+ stories that include ChatInput. Without
    // pinning, every reorder or insertion into PLACEHOLDER_TIPS shifts the
    // tip the wall-clock bucket lands on and forces a baseline re-accept on
    // every one of those stories. The fix is a runtime flag set by
    // .storybook/preview.tsx that short-circuits the carousel to slot 0.
    const bucketStart = TWENTY_MIN_MS * 100;
    // Without the flag these buckets rotate away from the lead tip, so the
    // pinned assertions below cannot pass by coincidence.
    expect(tipAt(bucketStart)).not.toBe(PLACEHOLDER_TIPS[0]);
    expect(tipAt(bucketStart + TWENTY_MIN_MS)).not.toBe(PLACEHOLDER_TIPS[0]);

    (globalThis as StorybookGlobal).__MUX_STORYBOOK__ = true;
    // Pinned regardless of wall-clock time.
    expect(tipAt(bucketStart)).toBe(PLACEHOLDER_TIPS[0]);
    expect(tipAt(bucketStart + TWENTY_MIN_MS)).toBe(PLACEHOLDER_TIPS[0]);
  });
});
