import { describe, expect, test } from "bun:test";

import { removeSentText } from "./composerDraftText";

describe("removeSentText", () => {
  test("a send of the whole composer text empties it", () => {
    expect(removeSentText("follow-up", "follow-up")).toBe("");
  });

  test("a draft restored before the sent text stays, even when it contains the sent text", () => {
    expect(removeSentText("follow-up details\n\nfollow-up", "follow-up")).toBe("follow-up details");
  });

  test("text typed after the sent text stays", () => {
    expect(removeSentText("follow-up\n\nmore text", "follow-up")).toBe("more text");
  });

  test("a match inside a word is left as is", () => {
    expect(removeSentText("pre-follow-up", "follow-up")).toBe("pre-follow-up");
  });

  test("the composer is left as is when the sent text is not at either end", () => {
    expect(removeSentText("before follow-up after", "follow-up")).toBe("before follow-up after");
    expect(removeSentText("unrelated", "follow-up")).toBe("unrelated");
  });

  test("an attachment-only send (no text) leaves the composer text", () => {
    expect(removeSentText("restored draft", "")).toBe("restored draft");
  });
});
