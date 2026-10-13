import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { SkillIndicator } from "./SkillIndicator";

describe("SkillIndicator while skills load (#6221)", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const renderIndicator = (loading: boolean) =>
    render(
      <TooltipProvider>
        <div data-testid="slot">
          <SkillIndicator loadedSkills={[]} availableSkills={[]} loading={loading} />
        </div>
      </TooltipProvider>
    );

  test("keeps its slot while the list is unknown, so the header does not shift when it loads", () => {
    const view = renderIndicator(true);
    const slot = view.getByTestId("slot");
    // Nothing to read or press yet: an inert, hidden box of the button's size.
    expect(view.queryByRole("button")).toBeNull();
    expect(slot.children).toHaveLength(1);
    const placeholder = slot.children[0];
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.className).toContain("h-6");
    expect(placeholder.className).toContain("w-6");
  });

  test("renders nothing once the list is known to be empty", () => {
    const view = renderIndicator(false);
    expect(view.getByTestId("slot").children).toHaveLength(0);
  });
});
