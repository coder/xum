import { describe, expect, test } from "bun:test";
import { applyMergePatch } from "./applyMergePatch";

describe("applyMergePatch", () => {
  test("an undefined value leaves the key as the wire does, and null still deletes it", () => {
    const target = { appearance: { theme: "dark", vimEnabled: true } };

    expect(applyMergePatch(target, { appearance: { theme: undefined } })).toEqual(target);
    expect(applyMergePatch(target, { appearance: { theme: null } })).toEqual({
      appearance: { vimEnabled: true },
    });
  });
});
