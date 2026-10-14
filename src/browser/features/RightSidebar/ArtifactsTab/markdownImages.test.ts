import { describe, expect, test } from "bun:test";
import { findRelativeMarkdownImages, mapMarkdownImageUrls } from "./markdownImages";

describe("markdown image rewriting", () => {
  const doc = [
    "![chart](img/chart.png)",
    '![t](<my img.png> "Title") and ![r](https://example.com/r.png)',
    "```md",
    "![code](img/not-me.png)",
    "```",
    "![inline data](data:image/png;base64,AA)",
  ].join("\n");

  test("finds relative images outside code fences", () => {
    expect(findRelativeMarkdownImages(doc)).toEqual(["img/chart.png", "my img.png"]);
  });

  test("a fence closes only on a bare marker line of the same character and length", () => {
    const fenced = (inner: string) => ["```", inner, "![x](a.png)", "```"].join("\n");
    // Trailing text, a different character, or a shorter run is code, not a close.
    expect(findRelativeMarkdownImages(fenced("````not-a-close"))).toEqual([]);
    expect(findRelativeMarkdownImages(fenced("~~~"))).toEqual([]);
    expect(findRelativeMarkdownImages(["````", "```", "![x](a.png)", "````"].join("\n"))).toEqual(
      []
    );
    // A bare longer run of the same character does close it.
    expect(findRelativeMarkdownImages(["```", "````  ", "![x](a.png)"].join("\n"))).toEqual([
      "a.png",
    ]);
  });

  test("rewrites only the URLs the transform returns", () => {
    const out = mapMarkdownImageUrls(doc, (url) => (url === "img/chart.png" ? "data:x" : null));
    expect(out.split("\n")[0]).toBe("![chart](data:x)");
    expect(out.split("\n")[3]).toBe("![code](img/not-me.png)");
    expect(mapMarkdownImageUrls('![a](b.png "T")', () => "data:y")).toBe('![a](data:y "T")');
  });
});
