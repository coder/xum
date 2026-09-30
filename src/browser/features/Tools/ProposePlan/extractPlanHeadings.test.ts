import { describe, expect, test } from "bun:test";
import { extractPlanHeadings } from "./extractPlanHeadings";

describe("extractPlanHeadings", () => {
  test("returns empty array for empty input", () => {
    expect(extractPlanHeadings("")).toEqual([]);
  });

  test("extracts ATX headings with correct level + text", () => {
    const md = `# Title\n\nintro\n\n## Section A\n\nbody\n\n### Subsection\n\nmore`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Title" },
      { renderIndex: 1, level: 2, text: "Section A" },
      { renderIndex: 2, level: 3, text: "Subsection" },
    ]);
  });

  test("accepts trailing closing # markers on ATX headings", () => {
    const md = `# Title #\n## With trailing ##`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Title" },
      { renderIndex: 1, level: 2, text: "With trailing" },
    ]);
  });

  test("accepts ATX headings indented by up to three spaces", () => {
    const md = ` ## One space\n  ### Two spaces\n   #### Three spaces\n    ##### Four-space code\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "One space" },
      { renderIndex: 1, level: 3, text: "Two spaces" },
      { renderIndex: 2, level: 4, text: "Three spaces" },
      { renderIndex: 3, level: 2, text: "After" },
    ]);
  });

  test("counts empty ATX headings so later renderIndex values stay aligned", () => {
    const md = `#\n\n## Visible after blank heading`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 1, level: 2, text: "Visible after blank heading" },
    ]);
  });

  test("strips inline formatting in heading text", () => {
    const md = `# **Bold** and _italic_\n## With \`code\` inline\n### [Linked](https://example.com) heading\n#### ~~strike~~ through`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Bold and italic" },
      { renderIndex: 1, level: 2, text: "With code inline" },
      { renderIndex: 2, level: 3, text: "Linked heading" },
      { renderIndex: 3, level: 4, text: "strike through" },
    ]);
  });

  test("ignores hashtags without space after the markers", () => {
    const md = `#nothashtag\n# Real heading`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 1, text: "Real heading" }]);
  });

  test("skips ATX-looking lines inside fenced code blocks", () => {
    const md = `# Real heading\n\n\`\`\`markdown\n# Not a heading\n## Also not\n\`\`\`\n\n## After code`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Real heading" },
      { renderIndex: 1, level: 2, text: "After code" },
    ]);
  });

  test("handles tilde-fenced code blocks too", () => {
    const md = `# Outer\n\n~~~\n# Not a heading\n~~~\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Outer" },
      { renderIndex: 1, level: 2, text: "After" },
    ]);
  });

  test("does not treat tilde fence as closing a backtick fence", () => {
    // The tilde line is content inside the backtick fence, not a closer.
    const md = `\`\`\`\n# Hidden\n~~~\n# Still hidden\n\`\`\`\n\n# Visible`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 1, text: "Visible" }]);
  });

  test("counts headings inside blockquote and list containers", () => {
    const md = `> # Quoted\n\n- ## Listed\n\n## Real\n\n## Next`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Quoted" },
      { renderIndex: 1, level: 2, text: "Listed" },
      { renderIndex: 2, level: 2, text: "Real" },
      { renderIndex: 3, level: 2, text: "Next" },
    ]);
  });

  test("does not count list-contained indented code as headings", () => {
    const md = `-     # Not a heading\n1.     ## Not a heading either\n\n## Visible`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Visible" }]);
  });

  test("skips headings inside container-prefixed fenced code blocks", () => {
    const md = `> \`\`\`markdown\n> # Hidden quoted heading\n> \`\`\`\n\n- \`\`\`markdown\n  ## Hidden list heading\n  \`\`\`\n\n## Visible`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Visible" }]);
  });

  test("recognizes setext h1 and h2 underlines", () => {
    const md = `Title One\n=========\n\nbody\n\nTitle Two\n---------\n\nmore`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Title One" },
      { renderIndex: 1, level: 2, text: "Title Two" },
    ]);
  });

  test("combines multi-line setext heading text", () => {
    const md = `Foo\nBar\n---\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Foo Bar" },
      { renderIndex: 1, level: 2, text: "After" },
    ]);
  });

  test("allows inline HTML paragraph text as a setext heading", () => {
    const md = `<em>Roadmap</em>\n---\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Roadmap" },
      { renderIndex: 1, level: 2, text: "After" },
    ]);
  });

  test("recognizes setext headings inside blockquotes", () => {
    const md = `> Quoted title\n> ===\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Quoted title" },
      { renderIndex: 1, level: 2, text: "After" },
    ]);
  });

  test("does not trim four-space-indented setext underlines into headings", () => {
    const md = `Title\n    ---\n\n> Quoted title\n>     ===\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "After" }]);
  });

  test("ignores markdown-looking headings inside raw HTML blocks", () => {
    const md = `<div>\n# Hidden ATX\n\nAfter html\n---\n\n<section>\nTitle inside section\n---\n</section>\n\n## Visible`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "After html" },
      { renderIndex: 1, level: 2, text: "Visible" },
    ]);
  });

  test("does not treat raw HTML blocks followed by rules as setext headings", () => {
    const md = `<div>Intro</div>\n---\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "After" }]);
  });

  test("allows setext text that starts with list punctuation but is not a list", () => {
    const md = `-foo\n---\n\n+bar\n===\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "-foo" },
      { renderIndex: 1, level: 1, text: "+bar" },
      { renderIndex: 2, level: 2, text: "After" },
    ]);
  });

  test("does not confuse thematic breaks with setext underlines", () => {
    const md = `Some intro paragraph.\n\n---\n\n# Heading`;
    // The `---` here is preceded by a blank line, so it's a thematic break, not
    // a setext underline. The TOC should only contain the ATX heading.
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 1, text: "Heading" }]);
  });

  test("does not treat ordered-list items followed by rules as setext headings", () => {
    const md = `1. Step one\n---\n\n2) Step two\n---\n\n## Actual heading`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Actual heading" }]);
  });

  test("does not count heading markup inside single-line non-rendered HTML contexts", () => {
    const md = `<!-- <h2>Comment heading</h2> -->\n<script><h2>Script heading</h2></script>\n<style><h2>Style heading</h2></style>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Outside" }]);
  });

  test("does not count HTML-looking headings inside script or style blocks", () => {
    const md = `<script>\n<h2>Hidden script heading</h2>\n</script>\n\n<style>\n<h3>Hidden style heading</h3>\n</style>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Outside" }]);
  });

  test("ignores headings inside unsupported raw HTML blocks", () => {
    const md = `<custom><h2>Unsupported</h2></custom>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Outside" }]);
  });

  test("counts raw HTML headings nested inside raw HTML blocks", () => {
    const md = `<div>\n<h2>Inner HTML heading</h2>\n</div>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Inner HTML heading" },
      { renderIndex: 1, level: 2, text: "Outside" },
    ]);
  });

  test("does not count tab-indented raw HTML headings outside HTML blocks", () => {
    const md = `\t<h2>Code sample heading</h2>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Outside" }]);
  });

  test("does not count four-space-indented raw HTML headings outside HTML blocks", () => {
    const md = `    <h2>Code sample heading</h2>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 2, text: "Outside" }]);
  });

  test("counts indented raw HTML headings inside raw HTML blocks", () => {
    const md = `<div>\n    <h2>Inner HTML heading</h2>\n</div>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Inner HTML heading" },
      { renderIndex: 1, level: 2, text: "Outside" },
    ]);
  });

  test("counts raw HTML heading tags with surrounding inline content", () => {
    const md = `<h2>Intro</h2> trailing text\n<h2>A</h2><h3>B</h3>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Intro" },
      { renderIndex: 1, level: 2, text: "A" },
      { renderIndex: 2, level: 3, text: "B" },
      { renderIndex: 3, level: 2, text: "Outside" },
    ]);
  });

  test("counts multiline raw HTML headings so later renderIndex values stay aligned", () => {
    const md = `<h2>\nMultiline HTML heading\n</h2>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Multiline HTML heading" },
      { renderIndex: 1, level: 2, text: "Outside" },
    ]);
  });

  test("preserves text after nested inline tags inside raw HTML headings", () => {
    const md = `<h2><em>Auth</em> rollout</h2>\n\n## Next`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Auth rollout" },
      { renderIndex: 1, level: 2, text: "Next" },
    ]);
  });

  test("counts implicitly closed raw HTML headings to preserve DOM index alignment", () => {
    const md = `<h2>Implicit close\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Implicit close" },
      { renderIndex: 1, level: 2, text: "Outside" },
    ]);
  });

  test("stops implicitly closed raw HTML headings before the next heading tag", () => {
    const md = `<h2>Intro<h3>Nested close\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Intro" },
      { renderIndex: 1, level: 3, text: "Nested close" },
      { renderIndex: 2, level: 2, text: "Outside" },
    ]);
  });

  test("counts raw HTML headings inside pre blocks to preserve DOM index alignment", () => {
    const md = `<pre><h2>Rendered from raw HTML</h2></pre>\n\n## Outside`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Rendered from raw HTML" },
      { renderIndex: 1, level: 2, text: "Outside" },
    ]);
  });

  test("does not count escaped raw HTML headings inside inline code", () => {
    const md = `Intro \`<h2>Code</h2>\` <h2>Real</h2>\n\n## Next`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Real" },
      { renderIndex: 1, level: 2, text: "Next" },
    ]);
  });

  test("counts raw HTML headings inside inline paragraph tokens", () => {
    const md = `Intro <h2>Inline Section</h2>\n\n## Next`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 2, text: "Inline Section" },
      { renderIndex: 1, level: 2, text: "Next" },
    ]);
  });

  test("counts raw HTML headings so renderIndex stays aligned", () => {
    const md = `# Markdown one\n\n<h2>Inline HTML two</h2>\n\n### Markdown three`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Markdown one" },
      { renderIndex: 1, level: 2, text: "Inline HTML two" },
      { renderIndex: 2, level: 3, text: "Markdown three" },
    ]);
  });

  test("counts empty raw HTML headings so later renderIndex values stay aligned", () => {
    const md = `<h2></h2>\n\n## After empty HTML heading`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 1, level: 2, text: "After empty HTML heading" },
    ]);
  });

  test("preserves stable render indices across mixed content", () => {
    const md = [
      "# A",
      "",
      "para",
      "",
      "## B",
      "",
      "```",
      "# inside-fence",
      "```",
      "",
      "### C",
      "",
      "<h4>D</h4>",
      "",
      "##### E",
    ].join("\n");

    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "A" },
      { renderIndex: 1, level: 2, text: "B" },
      { renderIndex: 2, level: 3, text: "C" },
      { renderIndex: 3, level: 4, text: "D" },
      { renderIndex: 4, level: 5, text: "E" },
    ]);
  });
});
