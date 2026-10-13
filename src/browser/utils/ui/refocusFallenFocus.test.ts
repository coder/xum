import "../../../../tests/ui/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { refocusFallenFocus } from "./refocusFallenFocus";

let cleanupDom: (() => void) | null = null;
let originalMutationObserver: typeof MutationObserver;
/** The callbacks of the observers that are still connected. */
let observers: Set<() => void>;

/**
 * A stand-in for happy-dom's MutationObserver: happy-dom delivers records on a timer and holds
 * its listener through a WeakRef, so a GC during an await can drop the observer and the test
 * would see no delivery (CI). The test delivers "a mutation happened" itself, synchronously.
 */
class FakeMutationObserver {
  private readonly notify: () => void;
  constructor(callback: MutationCallback) {
    this.notify = () => callback([], this as unknown as MutationObserver);
  }
  observe() {
    observers.add(this.notify);
  }
  disconnect() {
    observers.delete(this.notify);
  }
  takeRecords() {
    return [];
  }
}

/** Delivers one mutation to every connected observer, as the browser does after a DOM change. */
const deliverMutation = () => {
  for (const notify of [...observers]) notify();
};

beforeEach(() => {
  cleanupDom = installDom();
  observers = new Set();
  originalMutationObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
});

afterEach(() => {
  globalThis.MutationObserver = originalMutationObserver;
  cleanupDom?.();
  cleanupDom = null;
});

function buildPanel() {
  const panel = document.createElement("div");
  panel.tabIndex = 0;
  const first = document.createElement("button");
  const second = document.createElement("button");
  panel.append(first, second);
  document.body.append(panel);
  return { panel, first, second };
}

test("focus that falls to <body> with a removed node returns to the element", () => {
  const { panel, first } = buildPanel();
  const stop = refocusFallenFocus(panel);
  first.focus();
  first.remove();
  deliverMutation();
  expect(document.activeElement).toBe(panel);
  stop();
});

// A browser moves focus in steps: focusout (relatedTarget: the next control) with focus on <body>,
// then focusin. A tooltip that closes on the blur mutates the page in between (#6200).
test("a focus move in flight is not taken over by the element", () => {
  const { panel, first, second } = buildPanel();
  const stop = refocusFallenFocus(panel);
  first.focus();
  first.blur();
  first.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: second }));
  deliverMutation();
  expect(document.activeElement).toBe(document.body);

  second.focus();
  deliverMutation();
  expect(document.activeElement).toBe(second);
  // The move ended: a later fall to <body> is caught again.
  second.remove();
  deliverMutation();
  expect(document.activeElement).toBe(panel);
  stop();
});

// #6291: a focusout can name a node that stays in the page but never takes focus (made inert or
// hidden in a focusout handler). No focusin follows, so the guard must not outlive the move's task.
test("a focus move that never lands stops guarding after its task", async () => {
  const { panel, first, second } = buildPanel();
  const stop = refocusFallenFocus(panel);
  first.focus();
  first.blur();
  first.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: second }));
  // Same task: the move may still land, so the guard holds.
  deliverMutation();
  expect(document.activeElement).toBe(document.body);

  // A later task: no focusin came and no further mutation comes. The skipped mutation is checked
  // again when the guard expires, so focus does not stay on <body>.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(second.isConnected).toBe(true);
  expect(document.activeElement).toBe(panel);
  stop();
});

// The expiry rechecks only a mutation the guard skipped: a focusout alone (a click on blank
// space) keeps waiting for a mutation, as before #6291.
test("an expired focus move with no skipped mutation does not take focus", async () => {
  const { panel, first, second } = buildPanel();
  const stop = refocusFallenFocus(panel);
  first.focus();
  first.blur();
  first.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true, relatedTarget: second }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(document.body);
  stop();
});

test("the undo stops watching", () => {
  const { panel, first } = buildPanel();
  refocusFallenFocus(panel)();
  first.focus();
  first.remove();
  deliverMutation();
  expect(document.activeElement).toBe(document.body);
  expect(observers.size).toBe(0);
});
