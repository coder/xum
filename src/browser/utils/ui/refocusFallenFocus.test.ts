import "../../../../tests/ui/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { refocusFallenFocus } from "./refocusFallenFocus";

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanupDom?.();
  cleanupDom = null;
});

/** Lets pending MutationObserver callbacks run. */
const flushObservers = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function buildPanel() {
  const panel = document.createElement("div");
  panel.tabIndex = 0;
  const first = document.createElement("button");
  const second = document.createElement("button");
  panel.append(first, second);
  document.body.append(panel);
  return { panel, first, second };
}

test("focus that falls to <body> with a removed node returns to the element", async () => {
  const { panel, first } = buildPanel();
  const stop = refocusFallenFocus(panel);
  first.focus();
  first.remove();
  await flushObservers();
  expect(document.activeElement).toBe(panel);
  stop();
});

// A browser moves focus in steps: focusout (relatedTarget: the next control) with focus on <body>,
// then focusin. A tooltip that closes on the blur mutates the page in between (#6200).
test("a focus move in flight is not taken over by the element", async () => {
  const { panel, first, second } = buildPanel();
  const tooltip = document.body.appendChild(document.createElement("div"));
  const stop = refocusFallenFocus(panel);
  first.focus();
  first.blur();
  first.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: second }));
  tooltip.remove();
  await flushObservers();
  expect(document.activeElement).toBe(document.body);

  second.focus();
  await flushObservers();
  expect(document.activeElement).toBe(second);
  // The move ended: a later fall to <body> is caught again.
  second.remove();
  await flushObservers();
  expect(document.activeElement).toBe(panel);
  stop();
});

test("the undo stops watching", async () => {
  const { panel, first } = buildPanel();
  refocusFallenFocus(panel)();
  first.focus();
  first.remove();
  await flushObservers();
  expect(document.activeElement).toBe(document.body);
});
