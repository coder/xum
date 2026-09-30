import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { removeDroppedCacheKeys } from "./legacyLocalStorageCleanup";

describe("removeDroppedCacheKeys", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanupDom();
  });

  test("removes only keys with a dropped cache prefix", () => {
    const keptKeys = ["statusState:c", "input:d", "x-planContent:e", "notpostCompactionState:f"];
    // Adjacent dropped keys: removing while iterating by index would skip the second one.
    const droppedKeys = ["planContent:a", "planContent:a2", "postCompactionState:b"];
    for (const key of [...droppedKeys, ...keptKeys]) {
      window.localStorage.setItem(key, JSON.stringify({ value: key }));
    }

    removeDroppedCacheKeys();

    const remaining = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index)
    );
    expect(remaining.sort()).toEqual([...keptKeys].sort());
  });
});
