import { describe, expect, it } from "bun:test";

import {
  sanitizeErrorMessageForDisplay,
  sanitizeStringForProviderOutput,
  sanitizeUnknownForProviderOutput,
} from "./providerOutputSanitization";

describe("provider output sanitization", () => {
  it("leaves normal provider errors intact", () => {
    expect(sanitizeErrorMessageForDisplay("Forbidden")).toBe("Forbidden");
  });

  it("redacts binary-like error messages with bounded diagnostics", () => {
    const sanitized = sanitizeErrorMessageForDisplay(
      "Invalid JSON response: \u001b\u0000\ufffdpayload"
    );

    expect(sanitized).not.toBe("Invalid JSON response: \u001b\u0000\ufffdpayload");
    expect(sanitized).toContain("nul=1");
    expect(sanitized).toContain("replacement=1");
    expect(sanitized).toContain("preview=");
    expect(sanitized).not.toContain("\u0000");
    expect(sanitized).not.toContain("�");
  });

  it("truncates very large non-binary strings", () => {
    const sanitized = sanitizeStringForProviderOutput("x".repeat(12_010));

    expect(sanitized.length).toBeLessThan(12_100);
    expect(sanitized).toContain("[truncated provider-output;");
  });

  it("keeps long tool output strings at full length and still redacts binary-like ones", () => {
    // Persisted history replays tool results at the length the in-turn step sent them.
    const longText = "line\twith tab\r\n".repeat(2_000);
    const output = { success: true, content: longText };
    expect(sanitizeUnknownForProviderOutput(output)).toBe(output);

    const sanitized = sanitizeUnknownForProviderOutput({
      content: `${longText}\u0000`,
    }) as { content: string };
    expect(sanitized.content).toStartWith("[redacted binary-like provider-output;");
    expect(sanitized.content).toContain(`length=${longText.length + 1}, nul=1`);
  });

  it("keeps text with sparse control characters and redacts dense ones", () => {
    const sparse = `${"a".repeat(100)}\u001b[0m`;
    expect(sanitizeUnknownForProviderOutput(sparse)).toBe(sparse);

    const dense = "\u001b\u007f\u000b".repeat(10);
    expect(sanitizeUnknownForProviderOutput(dense)).toStartWith(
      "[redacted binary-like provider-output; length=30, nul=0, control=30"
    );
  });

  it("preserves supported media payloads for attachment extraction", () => {
    const media = {
      type: "media",
      mediaType: "image/png",
      data: "a".repeat(20_000),
    };

    expect(sanitizeUnknownForProviderOutput(media)).toBe(media);
  });

  it("keeps unchanged tool output references", () => {
    const output = { ok: true, nested: ["still useful"] };

    expect(sanitizeUnknownForProviderOutput(output)).toBe(output);
  });

  it("does not coerce non-plain objects into records", () => {
    const date = new Date("2026-05-14T00:00:00Z");

    expect(sanitizeUnknownForProviderOutput(date)).toBe(date);
  });

  it("recursively sanitizes nested tool output strings", () => {
    const sanitized = sanitizeUnknownForProviderOutput({
      ok: false,
      error: "bad\u0000body",
      nested: [{ message: "still useful" }],
    });

    expect(typeof sanitized).toBe("object");
    expect(sanitized).not.toBeNull();
    const sanitizedRecord = sanitized as {
      ok?: unknown;
      error?: unknown;
      nested?: unknown;
    };
    expect(sanitizedRecord.ok).toBe(false);
    expect(sanitizedRecord.error).not.toBe("bad\u0000body");
    expect(sanitizedRecord.error).toEqual(expect.stringContaining("nul=1"));
    expect(sanitizedRecord.nested).toEqual([{ message: "still useful" }]);
  });
});
