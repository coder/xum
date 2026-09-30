import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { GitStatus } from "@/common/types/workspace";
import { GitStatusIndicatorView, type GitStatusIndicatorMode } from "./GitStatusIndicatorView";

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

function renderIndicator(mode: GitStatusIndicatorMode, status: GitStatus) {
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
      onOpenChange={noop}
      onModeChange={noop}
      baseRef="origin/main"
      onBaseChange={noop}
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
