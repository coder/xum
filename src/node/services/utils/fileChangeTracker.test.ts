import { describe, expect, test } from "bun:test";
import { createFileChangeNotificationMessage } from "./fileChangeTracker";

function noticeFor(filename: string): string {
  const message = createFileChangeNotificationMessage([{ type: "edited_text_file", filename }]);
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * The line breaks a name could add to the notice: JS `\n` and `\r`, plus NEL, LS and PS. Some
 * splitters also read VT, FF and FS/GS/RS as line breaks. The regex leaves them out because
 * JSON.stringify escapes every character below U+0020, so none of them can reach the notice raw.
 */
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

describe("createFileChangeNotificationMessage file names", () => {
  // JSON.stringify leaves NEL, LS and PS as raw characters, and each one is a line break for some
  // splitter (Python's str.splitlines, Markdown renderers), so a name that holds one could start
  // a new line of the notice that is not its own.
  test.each([
    ["U+0085", "\u0085", "\\u0085"],
    ["U+2028", "\u2028", "\\u2028"],
    ["U+2029", "\u2029", "\\u2029"],
  ])(
    "a name that holds %s stays on the notice's first line as an escape",
    (_label, char, escape) => {
      const plain = noticeFor("/repo/a-b.ts");

      const text = noticeFor(`/repo/a${char}b.ts`);

      expect(text).not.toContain(char);
      expect(text).toContain(`a${escape}b.ts`);
      // The same lines as for a name without the character: frame, one note, frame.
      expect(text.split(LINE_BREAK)).toHaveLength(plain.split(LINE_BREAK).length);
    }
  );

  // A replace without the `g` flag handles the first match only: every test above has one
  // character per name, so each of them passes without it.
  test("every occurrence in a name is escaped, for a repeated and a mixed name", () => {
    const plain = noticeFor("/repo/a-b.ts");

    const text = noticeFor("/repo/a\u0085b\u2028c\u2029d\u2028e\u0085f<g<h.ts");

    expect(text).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(text).toContain("a\\u0085b\\u2028c\\u2029d\\u2028e\\u0085f\\u003cg\\u003ch.ts");
    // The frame's own two tags are the only `<` left.
    expect(text.match(/</g)).toHaveLength(2);
    expect(text.split(LINE_BREAK)).toHaveLength(plain.split(LINE_BREAK).length);
  });
});
