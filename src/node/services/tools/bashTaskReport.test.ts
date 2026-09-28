import { describe, expect, it } from "bun:test";

import { formatBashOutputReport } from "./bashTaskReport";

describe("formatBashOutputReport", () => {
  it("renders the header, status and trimmed output in a text fence", () => {
    expect(
      formatBashOutputReport({
        processId: "proc_123",
        status: "exited",
        exitCode: 0,
        output: "line1\nline2\n",
      })
    ).toBe(
      [
        "### Bash task: proc_123",
        "",
        "status: exited",
        "exitCode: 0",
        "",
        "```text",
        "line1",
        "line2",
        "```",
      ].join("\n")
    );
  });

  it("picks a fence longer than any backtick run in the output", () => {
    const report = formatBashOutputReport({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "before\n```\nafter\n",
    });

    // A literal ``` output line cannot terminate the block early.
    expect(report.endsWith(["````text", "before", "```", "after", "````"].join("\n"))).toBe(true);
  });

  it("omits the output block when there is no output", () => {
    const report = formatBashOutputReport({
      processId: "proc_123",
      status: "exited",
      exitCode: 0,
      output: "",
    });

    expect(report).toContain("### Bash task: proc_123");
    expect(report).toContain("exitCode: 0");
    expect(report).not.toContain("```");
  });
});
