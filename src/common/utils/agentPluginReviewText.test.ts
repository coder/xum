import { describe, expect, test } from "bun:test";

import { containsUnicodeTags, revealUnicodeTags } from "./agentPluginReviewText";

/** Tag characters (U+E0020-U+E007F) carry ASCII one-to-one, so a run of them spells hidden text. */
const tags = (ascii: string) =>
  [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

const LANGUAGE_TAG = "\u{E0001}";
const CANCEL_TAG = "\u{E0000}";
const subdivisionFlag = (region: string) => `\u{1F3F4}${tags(region)}\u{E007F}`;

describe("revealUnicodeTags", () => {
  test("marks a language tag, whose payload would otherwise be half-invisible", () => {
    // U+E0001 leads a language tag and maps to no ASCII, so leaving it out of the class would draw
    // `<U+E0065><U+E006E>` for an "en" block while its own character stayed invisible.
    expect(revealUnicodeTags(`${LANGUAGE_TAG}${tags("en")}keep`)).toBe(
      "<U+E0001><U+E0065><U+E006E>keep"
    );
  });

  test("marks the cancel tag and a tag run alike", () => {
    expect(revealUnicodeTags(`${CANCEL_TAG}${tags("AB")}`)).toBe("<U+E0000><U+E0041><U+E0042>");
  });

  test("leaves a real subdivision flag intact, and marks a lookalike", () => {
    // England/Scotland/Wales are the only RGI flags: their tags are the emoji, while `usca` renders
    // as a plain black flag and is a payload.
    for (const region of ["gbeng", "gbsct", "gbwls"]) {
      expect(revealUnicodeTags(`ship ${subdivisionFlag(region)}`)).toBe(
        `ship ${subdivisionFlag(region)}`
      );
    }
    expect(revealUnicodeTags(`\u{1F3F4}${tags("usca")}\u{E007F}`)).toBe(
      `\u{1F3F4}<U+E0075><U+E0073><U+E0063><U+E0061><U+E007F>`
    );
  });

  test("is byte-identical for text with no tags", () => {
    for (const plain of ["", "shipping now", "emoji 👍🏻 ❤️", "é", "a\u200bb"]) {
      expect(revealUnicodeTags(plain)).toBe(plain);
    }
  });
});

describe("containsUnicodeTags", () => {
  test("flags a language tag as a payload", () => {
    // The predicate decides whether an invisible-only row earns a transcript row, so a false here
    // silently deletes provider-visible text.
    expect(containsUnicodeTags(LANGUAGE_TAG)).toBe(true);
    expect(containsUnicodeTags(CANCEL_TAG)).toBe(true);
    expect(containsUnicodeTags(`${LANGUAGE_TAG}${tags("en")}`)).toBe(true);
  });

  test("does not flag ordinary text or an RGI flag", () => {
    expect(containsUnicodeTags("")).toBe(false);
    expect(containsUnicodeTags("shipping now, zero-width space ​")).toBe(false);
    expect(containsUnicodeTags(subdivisionFlag("gbwls"))).toBe(false);
    expect(containsUnicodeTags(`a${subdivisionFlag("gbsct")}b`)).toBe(false);
  });

  test("still flags a payload disguised as a non-RGI flag", () => {
    expect(containsUnicodeTags(`\u{1F3F4}${tags("usca")}\u{E007F}`)).toBe(true);
  });
});
