/**
 * Fresh-process regression for the Radix rebind in tests/ui/dom.ts. Driven by
 * domIsolation.test.ts through a child `bun test`; it needs a process where no document
 * exists yet, so it is not part of the normal `bun test src` discovery (root = src) and its
 * .tsx name keeps it out of Jest's *.test.ts match.
 *
 * Import order is the scenario: Radix evaluates before the harness, exactly as a
 * document-less hooks/contexts suite does in the shared unit run. Static ESM imports mirror
 * those suites' module graph (a require() chain would load Radix's separate CJS entry).
 */
import * as Popover from "@radix-ui/react-popover";
import {
  documentBeforeHarness,
  radixLayoutEffectBeforeHarness,
} from "./domIsolation.radixOrder.capture";
import { installDom } from "./dom";
import { expect, test } from "bun:test";
import * as React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

test("a Popover opened after installDom mounts its content even though Radix loaded without a document", () => {
  // Precondition: with no document, Radix pinned its noop instead of the real hook.
  expect(documentBeforeHarness).toBe("undefined");
  expect(radixLayoutEffectBeforeHarness).not.toBe(React.useLayoutEffect);
  const uninstall = installDom();
  try {
    const view = render(
      <Popover.Root>
        <Popover.Trigger>open</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content>popover body</Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
    expect(document.body.textContent).not.toContain("popover body");
    fireEvent.click(view.getByText("open"));
    // Portal/Presence mount through Radix's layout effect; the noop leaves the body empty.
    expect(document.body.textContent).toContain("popover body");
  } finally {
    cleanup();
    uninstall();
  }
});
