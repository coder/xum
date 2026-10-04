import { describe, expect, test } from "bun:test";

import { hasDraftBlock, removeDraftBlock, removeSentText } from "./composerDraftText";

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

describe("removeDraftBlock", () => {
  test("finds a block between two blank lines, not only at the ends", () => {
    expect(removeDraftBlock("alpha\n\nbravo\n\ncharlie", "bravo")).toBe("alpha\n\ncharlie");
    expect(removeDraftBlock("alpha\n\nbravo", "bravo")).toBe("alpha");
    expect(removeDraftBlock("a\n\nfirst\n\nsecond\n\nb", "first\n\nsecond")).toBe("a\n\nb");
  });

  test("leaves text inside a paragraph and partial blocks as they are", () => {
    expect(removeDraftBlock("alpha\n\nsay bravo now\n\ncharlie", "bravo")).toBe(
      "alpha\n\nsay bravo now\n\ncharlie"
    );
    expect(removeDraftBlock("alpha\n\nbravo2\n\ncharlie", "bravo")).toBe(
      "alpha\n\nbravo2\n\ncharlie"
    );
    expect(removeDraftBlock("alpha\n\ncharlie", "")).toBe("alpha\n\ncharlie");
  });

  // #5567: the ends need a blank line too. A word at the end or start of a longer line is the
  // user's text, not a copy of the send.
  test("leaves a word at the end or start of a longer line as it is", () => {
    expect(removeDraftBlock("I said yes", "yes")).toBe("I said yes");
    expect(removeDraftBlock("yes please", "yes")).toBe("yes please");
    expect(removeDraftBlock("first line\nyes", "yes")).toBe("first line\nyes");
    expect(removeDraftBlock("yes\nsecond line", "yes")).toBe("yes\nsecond line");
    expect(hasDraftBlock("alpha\n\nI said yes", "yes")).toBe(false);
  });

  test("finds a block at either end next to a blank line, and the whole text", () => {
    expect(removeDraftBlock("yes\n\nmore", "yes")).toBe("more");
    expect(removeDraftBlock("I said\n\nyes", "yes")).toBe("I said");
    expect(removeDraftBlock("yes", "yes")).toBe("");
    // A word cut at the end does not hide the whole block later in the text.
    expect(removeDraftBlock("say yes\n\nyes\n\nmore", "yes")).toBe("say yes\n\nmore");
  });

  test("keeps the indentation of the block after the removed one", () => {
    expect(removeDraftBlock("alpha\n\nyes\n\n    code", "yes")).toBe("alpha\n\n    code");
    expect(removeDraftBlock("yes\n\n    code", "yes")).toBe("    code");
  });

  test("keeps trailing spaces of the line before the removed block (a Markdown hard break)", () => {
    expect(removeDraftBlock("line  \n\nyes\n\nmore", "yes")).toBe("line  \n\nmore");
    expect(removeDraftBlock("line  \n\nyes", "yes")).toBe("line  ");
  });
});
