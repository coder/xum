import { describe, expect, test } from "bun:test";
import { History } from "happy-dom";
import { snapshotHistoryMethods } from "./historyPrototype.testHarness";

describe("snapshotHistoryMethods", () => {
  test("snapshots pushState and replaceState of Happy DOM's History", () => {
    const snapshot = snapshotHistoryMethods(History.prototype);
    expect(snapshot.map(([name]) => name)).toEqual(["pushState", "replaceState"]);
    for (const [name, descriptor] of snapshot) {
      expect(descriptor.value).toBe(
        Object.getOwnPropertyDescriptor(History.prototype, name)?.value
      );
    }
  });

  test("throws, naming the method, when the target has no own descriptor for it", () => {
    expect(() => snapshotHistoryMethods({ pushState: () => undefined })).toThrow(
      'has no own "replaceState"'
    );
    expect(() => snapshotHistoryMethods({})).toThrow('has no own "pushState"');
    // An inherited method is not the own descriptor the restore redefines.
    expect(() => snapshotHistoryMethods(Object.create(History.prototype) as object)).toThrow(
      'has no own "pushState"'
    );
  });
});
