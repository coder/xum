import { describe, expect, it } from "bun:test";
import { describeArchiveMergedIssues } from "./archiveMergedIssues";

const base = {
  archivedWorkspaceIds: ["a", "b"],
  skippedWorkspaceIds: ["c"],
  errors: [],
  warnings: [],
};

describe("describeArchiveMergedIssues", () => {
  it("raises no alert when every archive succeeded without warnings", () => {
    expect(describeArchiveMergedIssues(base)).toBeNull();
  });

  it("lists warnings alone, with no error count, when nothing failed", () => {
    const alert = describeArchiveMergedIssues({
      ...base,
      warnings: [{ workspaceId: "ws-1", warning: "sandbox kept" }],
    });
    expect(alert).toContain("ws-1: sandbox kept");
    expect(alert).toContain("Warnings: 1");
    expect(alert).not.toContain("Errors");
  });

  it("names errors in the title and lists errors before warnings", () => {
    const alert = describeArchiveMergedIssues({
      ...base,
      errors: [{ workspaceId: "ws-2", error: "dirty" }],
      warnings: [{ workspaceId: "ws-1", warning: "sandbox kept" }],
    });
    expect(alert?.split("\n")[0]).toContain("errors");
    expect(alert).toContain("Archived: 2");
    expect(alert).toContain("Skipped: 1");
    const text = alert ?? "";
    expect(text.indexOf("ws-2: dirty")).toBeLessThan(text.indexOf("ws-1: sandbox kept"));
  });

  it("shows only the first issues and counts the rest", () => {
    const errors = Array.from({ length: 7 }, (_, i) => ({ workspaceId: `ws-${i}`, error: "x" }));
    const alert = describeArchiveMergedIssues({ ...base, errors });
    expect(alert).toContain("ws-4: x");
    expect(alert).not.toContain("ws-5: x");
    expect(alert).toContain("2 more");
  });
});
