import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import postcss from "postcss";
import { MOBILE_TOUCH_TARGET_PX } from "@/constants/layout";
import { installDom } from "../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { SkillIndicator } from "./SkillIndicator";

const GLOBALS_CSS = path.join(import.meta.dirname, "../../styles/globals.css");

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
    // An empty box read as a gap in the header, so the slot shows the icon.
    expect(placeholder.querySelector("svg")).not.toBeNull();
  });

  test("gets the same phone touch-target minimum as the loaded button (#6841)", async () => {
    // happy-dom cannot match a coarse-pointer media query, so read the phone rules from
    // globals.css and ask which ones raise the placeholder and the loaded button to the 44px
    // floor. A placeholder narrower than the button moved every header icon after it on load.
    const css = postcss.parse(await fs.promises.readFile(GLOBALS_CSS, "utf8"));
    const floorSelectors: string[] = [];
    css.walkAtRules("media", (media) => {
      if (!/max-width:\s*768px\).*\(pointer:\s*coarse/.test(media.params)) return;
      media.walkRules((rule) => {
        let raisesWidth = false;
        rule.walkDecls("min-width", (decl) => {
          raisesWidth ||= decl.value === `${MOBILE_TOUCH_TARGET_PX}px`;
        });
        if (raisesWidth) floorSelectors.push(rule.selector);
      });
    });
    expect(floorSelectors.length).toBeGreaterThan(0);
    const raisedBy = (el: Element) => floorSelectors.filter((s) => el.matches(s));

    const placeholder = renderIndicator(true).getByTestId("slot").children[0];
    const placeholderRules = raisedBy(placeholder);
    cleanup();
    const loaded = render(
      <TooltipProvider>
        <SkillIndicator
          loadedSkills={[]}
          availableSkills={[{ name: "tdd", description: "tdd", scope: "global" }]}
        />
      </TooltipProvider>
    ).getByRole("button");
    const buttonRules = raisedBy(loaded);

    expect(buttonRules.length).toBeGreaterThan(0);
    expect(placeholderRules).toEqual(buttonRules);
  });

  test("renders nothing once the list is known to be empty", () => {
    const view = renderIndicator(false);
    expect(view.getByTestId("slot").children).toHaveLength(0);
  });
});

describe("SkillIndicator plugin skill names", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("counts a qualified read of a winning plugin skill as that listed skill", () => {
    const tdd = { name: "tdd", description: "pstack tdd", scope: "global" as const };
    const view = render(
      <TooltipProvider>
        <SkillIndicator
          loadedSkills={[{ ...tdd, name: "pstack:tdd" }, tdd]}
          availableSkills={[{ ...tdd, pluginName: "pstack" }]}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("button").getAttribute("aria-label")).toContain("1 of 1 skill loaded");
  });
});

describe("SkillIndicator skill warnings", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("announces warnings without turning the badge into an error count", () => {
    const skill = {
      name: "poteto-mode",
      displayName: "Poteto Mode",
      description: "Router",
      scope: "global" as const,
    };
    const view = render(
      <TooltipProvider>
        <SkillIndicator
          loadedSkills={[skill]}
          availableSkills={[skill]}
          skillWarnings={[
            {
              directoryName: "poteto-mode",
              scope: "global",
              displayPath: "/skills/poteto-mode/SKILL.md",
              message: "display name",
            },
          ]}
        />
      </TooltipProvider>
    );
    const button = view.getByRole("button");
    expect(button.getAttribute("aria-label")).toBe("1 of 1 skill loaded, 1 warning");
    // The badge keeps showing the loaded count in its normal (non-danger) style.
    const badge = button.querySelector("span > span");
    expect(badge?.textContent).toBe("1");
    expect(badge?.className).not.toContain("bg-danger");
  });
});
