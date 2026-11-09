import { describe, expect, test } from "bun:test";
import { createFileChangeNotificationMessage } from "./fileChangeTracker";

function noticeFor(filename: string): string {
  const message = createFileChangeNotificationMessage([{ type: "edited_text_file", filename }]);
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Every line break that a Unicode-aware line splitter knows (JS `\n`, `\r`, plus NEL, LS, PS). */
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

describe("createFileChangeNotificationMessage file names", () => {
  // JSON.stringify leaves these three as raw characters, and each one is a line break for some
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
});
