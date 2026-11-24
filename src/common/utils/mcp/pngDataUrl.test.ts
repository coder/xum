import { describe, expect, test } from "bun:test";
import {
  MCPTestResultSchema,
  MCPToolCallDisplaySchema,
  PngDataUrlSchema,
} from "@/common/orpc/schemas/mcp";
import { isPngDataUrl, isStrictBase64 } from "./pngDataUrl";

// Actual one-pixel PNG, not merely an image MIME label.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOcAAAAASUVORK5CYII=";

describe("PNG data URL boundary", () => {
  test("accepts a PNG and rejects mislabeled bytes and unsafe sources", () => {
    expect(isPngDataUrl(PNG)).toBe(true);
    expect(PngDataUrlSchema.safeParse(PNG).success).toBe(true);
    for (const value of [
      undefined,
      null,
      1,
      "",
      "https://example.com/icon.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:image/png;base64,PHN2Zy8+",
      PNG.replace("iVBORw0KGgo", "iVBORw0KGGo"),
      PNG + "\n",
      PNG + "=",
    ]) {
      expect(isPngDataUrl(value)).toBe(false);
      expect(PngDataUrlSchema.safeParse(value).success).toBe(false);
    }
  });

  test("bounds decoded bytes and checks padding before rendering", () => {
    const bytes = Buffer.alloc(32 * 1024);
    Buffer.from(PNG.split(",")[1], "base64").copy(bytes);
    expect(isPngDataUrl(`data:image/png;base64,${bytes.toString("base64")}`)).toBe(true);
    expect(
      isPngDataUrl(
        `data:image/png;base64,${Buffer.concat([bytes, Buffer.from([0])]).toString("base64")}`
      )
    ).toBe(false);
    for (const value of ["A", "AAA", "A===", "A=AA", "AAAA====", "AA A", "AA\nA", "AB==", "AAB="]) {
      expect(isStrictBase64(value)).toBe(false);
    }
    for (const value of ["AA==", "AAA=", "AAAA"]) expect(isStrictBase64(value)).toBe(true);
  });

  test("drops malformed optional icon values without invalidating identity or old results", () => {
    const display = {
      connection: { key: "fixture", transport: "stdio" },
      identity: { name: "Fixture", version: "1" },
      source: "connection",
    };
    const iconRef = "1234567890abcdef".repeat(2);
    expect(MCPToolCallDisplaySchema.parse({ ...display, iconRef }).iconRef).toBe(iconRef);
    expect(
      MCPToolCallDisplaySchema.parse({ ...display, iconRef: "https://example.com" }).iconRef
    ).toBeUndefined();
    expect(MCPToolCallDisplaySchema.parse(display).iconRef).toBeUndefined();
    const oldResult = { success: true as const, tools: ["echo"] };
    expect(MCPTestResultSchema.parse(oldResult)).toEqual(oldResult);
    expect(MCPTestResultSchema.parse({ ...oldResult, icon: PNG })).toMatchObject({ icon: PNG });
    expect(
      MCPTestResultSchema.parse({ ...oldResult, icon: "data:image/png;base64,PHN2Zy8+" })
    ).toMatchObject({ icon: undefined });
  });
});
