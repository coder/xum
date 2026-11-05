import { describe, expect, test } from "bun:test";
import { PostCompactionAttachmentSchema } from "./continuousCompaction";

describe("PostCompactionAttachmentSchema", () => {
  test("an artifacts index written before versions were removed still parses", () => {
    expect(
      PostCompactionAttachmentSchema.parse({
        type: "artifacts_index",
        artifacts: [
          { path: "old.md", latestVersion: 3, label: "Old" },
          { path: "new.md", title: "New" },
        ],
      })
    ).toEqual({
      type: "artifacts_index",
      artifacts: [{ path: "old.md" }, { path: "new.md", title: "New" }],
    });
  });
});
