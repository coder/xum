import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { GitStatus } from "@/common/types/workspace";
import type { GitStatusIndicatorMode } from "@/common/constants/storage";
import { GitStatusIndicatorView } from "./GitStatusIndicatorView";

let cleanupDom: (() => void) | null = null;

const noop = () => undefined;

const gitStatus = (overrides: Partial<GitStatus>): GitStatus => ({
  branch: "feature",
  ahead: 0,
  behind: 0,
  dirty: false,
  outgoingAdditions: 0,
  outgoingDeletions: 0,
  incomingAdditions: 0,
  incomingDeletions: 0,
  ...overrides,
});

function renderIndicator(
  mode: GitStatusIndicatorMode,
  status: GitStatus,
  options?: {
    tapTogglesMode?: boolean;
    onModeChange?: (mode: GitStatusIndicatorMode) => void;
    onOpenChange?: (open: boolean) => void;
  }
) {
  return render(
    <GitStatusIndicatorView
      mode={mode}
      gitStatus={status}
      branchHeaders={null}
      commits={null}
      dirtyFiles={null}
      isLoading={false}
      errorMessage={null}
      isOpen={false}
      onOpenChange={options?.onOpenChange ?? noop}
      onModeChange={options?.onModeChange ?? noop}
      baseRef="origin/main"
      onBaseChange={noop}
      tapTogglesMode={options?.tapTogglesMode}
    />
  );
}

function counterPill(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("button > span.bg-surface-tertiary");
}

describe("GitStatusIndicatorView counter pill", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("groups both line counters into one pill split by a divider", () => {
    const { container } = renderIndicator(
      "line-delta",
      gitStatus({ outgoingAdditions: 233, outgoingDeletions: 12 })
    );

    const pill = counterPill(container);
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("+233");
    expect(pill?.textContent).toContain("-12");
    expect(pill?.querySelectorAll("span.w-px")).toHaveLength(1);
  });

  it("omits the divider when only one line counter is present", () => {
    const { container } = renderIndicator(
      "line-delta",
      gitStatus({ outgoingAdditions: 233, outgoingDeletions: 0 })
    );

    const pill = counterPill(container);
    expect(pill?.textContent).toContain("+233");
    expect(pill?.querySelectorAll("span.w-px")).toHaveLength(0);
  });

  it("groups both commit counters into one pill split by a divider", () => {
    const { container } = renderIndicator("divergence", gitStatus({ ahead: 233, behind: 12 }));

    const pill = counterPill(container);
    expect(pill?.textContent).toContain("↑233");
    expect(pill?.textContent).toContain("↓12");
    expect(pill?.querySelectorAll("span.w-px")).toHaveLength(1);
  });

  it("does not render an empty pill for dirty-only divergence", () => {
    const { container } = renderIndicator("divergence", gitStatus({ dirty: true }));

    expect(counterPill(container)).toBeNull();
    expect(container.textContent).toContain("*");
  });

  it("keeps the incoming-only fallback outside the pill in line mode", () => {
    const { container } = renderIndicator(
      "line-delta",
      gitStatus({ behind: 16, incomingAdditions: 120, incomingDeletions: 30 })
    );

    expect(counterPill(container)).toBeNull();
    expect(container.textContent).toContain("↓150");
  });

  it("reports lines rather than the behind commit count in line mode", () => {
    const status = gitStatus({ behind: 16, incomingAdditions: 120, incomingDeletions: 30 });

    const lineMode = renderIndicator("line-delta", status);
    expect(lineMode.container.textContent).not.toContain("↓16");
    cleanup();

    const commitMode = renderIndicator("divergence", status);
    expect(commitMode.container.textContent).toContain("↓16");
  });
});

describe("GitStatusIndicatorView tap-to-toggle", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const withLinesAndCommits = gitStatus({ ahead: 2, outgoingAdditions: 10 });

  it.each([
    ["line-delta", "Show commits", "divergence"],
    ["divergence", "Show lines", "line-delta"],
  ] as const)(
    "in %s mode a tap switches modes and keeps the dialog closed",
    (mode, label, next) => {
      const onModeChange = mock((_mode: GitStatusIndicatorMode) => undefined);
      const onOpenChange = mock((_open: boolean) => undefined);
      const view = renderIndicator(mode, withLinesAndCommits, {
        tapTogglesMode: true,
        onModeChange,
        onOpenChange,
      });

      fireEvent.click(view.getByRole("button", { name: label }));

      expect(onModeChange.mock.calls).toEqual([[next]]);
      expect(onOpenChange).not.toHaveBeenCalled();
    }
  );

  it("opens the divergence dialog instead when tap-to-toggle is off", () => {
    const onModeChange = mock((_mode: GitStatusIndicatorMode) => undefined);
    const onOpenChange = mock((_open: boolean) => undefined);
    const view = renderIndicator("line-delta", withLinesAndCommits, { onModeChange, onOpenChange });

    fireEvent.click(view.getByRole("button", { name: "View git divergence details" }));

    expect(onOpenChange.mock.calls).toEqual([[true]]);
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it.each([
    ["line-delta", gitStatus({ ahead: 3 }), "Show commits", "+0"],
    ["divergence", gitStatus({ outgoingAdditions: 7 }), "Show lines", "↑0"],
  ] as const)(
    "keeps an empty %s mode tappable while the other mode has content",
    (mode, status, label, zeroCount) => {
      const view = renderIndicator(mode, status, { tapTogglesMode: true });

      expect(view.getByRole("button", { name: label }).textContent).toBe(zeroCount);
    }
  );

  it("shows no tap target when both modes are empty", () => {
    const view = renderIndicator("line-delta", gitStatus({}), { tapTogglesMode: true });

    expect(view.queryByRole("button")).toBeNull();
  });

  it("shows no zero count without tap-to-toggle", () => {
    const view = renderIndicator("line-delta", gitStatus({ ahead: 3 }));

    expect(view.queryByRole("button")).toBeNull();
  });
});
