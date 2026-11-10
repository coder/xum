import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { holdSidebarInput, type HeldSidebarInput } from "./deferredSidebarInput";

describe("holdSidebarInput", () => {
  let restoreDom: () => void;
  beforeEach(() => {
    restoreDom = installDom();
  });
  afterEach(() => {
    restoreDom();
  });

  // The Artifacts tab key toggles the sidebar, and its handler ignores held keys. A replay that
  // dropped `repeat` turned each held repeat into a fresh press that flipped the sidebar again.
  test("replays a held key as held, and a fresh press as fresh", () => {
    const held: HeldSidebarInput[] = [];
    const release = holdSidebarInput(held);
    const chord = { key: "K", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true };
    window.dispatchEvent(new window.KeyboardEvent("keydown", chord));
    window.dispatchEvent(new window.KeyboardEvent("keydown", { ...chord, repeat: true }));
    release();

    const replayed: boolean[] = [];
    const record = (e: KeyboardEvent) => replayed.push(e.repeat);
    window.addEventListener("keydown", record);
    try {
      for (const replay of held) replay();
    } finally {
      window.removeEventListener("keydown", record);
    }
    expect(replayed).toEqual([false, true]);
  });
});
