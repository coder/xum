import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  consumePendingPluginsSectionIntent,
  peekPendingPluginsSectionIntent,
  publishPluginsSectionIntent,
  subscribePluginsSectionIntents,
  type PluginsSectionIntent,
} from "./pluginsSectionIntents";

// The listener set is module state shared with other test files: a subscription that outlives a
// failed assertion would swallow their buffered intents.
const unsubscribers: Array<() => void> = [];
function subscribe(alreadyRead: PluginsSectionIntent | null) {
  const received: PluginsSectionIntent[] = [];
  unsubscribers.push(
    subscribePluginsSectionIntents((intent) => received.push(intent), alreadyRead)
  );
  return received;
}

beforeEach(() => {
  consumePendingPluginsSectionIntent();
});
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  consumePendingPluginsSectionIntent();
});

describe("subscribePluginsSectionIntents", () => {
  test("does not deliver the intent the section read when it mounted", () => {
    publishPluginsSectionIntent({ type: "open-add-panel" });
    const read = peekPendingPluginsSectionIntent();

    const received = subscribe(read);

    expect(received).toEqual([]);
    expect(peekPendingPluginsSectionIntent()).toBeNull();
  });

  test("delivers an intent published after the section read the buffer", () => {
    publishPluginsSectionIntent({ type: "open-add-panel" });
    const read = peekPendingPluginsSectionIntent();
    // The section renders before its effects run: this lands between its read and its subscribe.
    publishPluginsSectionIntent({ type: "confirm-uninstall", name: "alpha" });

    const received = subscribe(read);

    expect(received).toEqual([{ type: "confirm-uninstall", name: "alpha" }]);
    expect(peekPendingPluginsSectionIntent()).toBeNull();
  });

  test("delivers an intent published after a mount that read an empty buffer", () => {
    const read = peekPendingPluginsSectionIntent();
    publishPluginsSectionIntent({ type: "refresh" });

    const received = subscribe(read);

    expect(received).toEqual([{ type: "refresh" }]);
  });
});
