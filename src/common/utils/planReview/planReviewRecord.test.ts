import { describe, expect, test } from "bun:test";

import {
  getPlanSnapshotLineCount,
  isAnchorWithinSnapshot,
  normalizePlanSnapshotContent,
} from "./planReviewRecord";

describe("normalizePlanSnapshotContent", () => {
  test("maps CRLF and lone CR line endings to LF so anchors match Markdown line positions", () => {
    // CommonMark treats a bare carriage return as a line ending, so a CR-only plan renders as
    // several addressable lines; the snapshot must count them the same way.
    expect(normalizePlanSnapshotContent("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    const crOnly = normalizePlanSnapshotContent("# Title\rline two\rline three");
    expect(getPlanSnapshotLineCount(crOnly)).toBe(3);
    expect(isAnchorWithinSnapshot({ startLine: 3, endLine: 3 }, crOnly)).toBe(true);
    // Already-normalized text is returned unchanged.
    expect(normalizePlanSnapshotContent("a\nb\n")).toBe("a\nb\n");
  });
});
