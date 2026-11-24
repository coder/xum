import { describe, expect, test } from "bun:test";
import type { BashToolResult } from "@/common/types/tools";
import { describeSandboxDenials } from "./sandboxDenialSummary";

function blocked(...sandboxDenials: string[]): BashToolResult {
  return {
    success: false,
    error: "Command exited with code 1",
    output: "",
    exitCode: 1,
    wall_duration_ms: 5,
    sandboxDenials,
  };
}

describe("describeSandboxDenials", () => {
  test("a lone denial counts no others", () => {
    expect(describeSandboxDenials(blocked("write /Users/me/.zshrc"))).not.toContain("more");
  });

  test("a known kind is put in words; any other report shows as the backend sent it", () => {
    const known = describeSandboxDenials(blocked("write /Users/me/.zshrc"));
    expect(known).toContain("/Users/me/.zshrc");
    expect(known).not.toContain("write /Users/me/.zshrc");
    // A report without a target does not match "<kind> <target>" at all.
    for (const report of ["mach-lookup com.apple.foo", "file-ioctl"]) {
      expect(describeSandboxDenials(blocked(report))).toContain(report);
    }
  });
});
