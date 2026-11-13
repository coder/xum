import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { ArtifactToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { generateXumTypes } from "@/node/services/ptc/typeGenerator";

/**
 * The `artifact` result is stored in chat history and read back by the chat card, by builds
 * older and newer than the one that wrote it. `layout` must never be the reason a row fails.
 */
const published = {
  success: true,
  path: "chart.html",
  bytes: 8,
  kind: "html",
  title: "chart",
  pin: null,
};
/** The layout of a parsed success row, or undefined. */
const layoutOf = (data: z.infer<typeof ArtifactToolResultSchema> | undefined) =>
  data?.success === true ? data.layout : undefined;

const layout = {
  checked: false,
  notChecked: [{ viewport: 768, reason: "timeout" }],
  issues: [
    {
      rule: "clipped-text",
      selector: "h1",
      viewport: 390,
      axis: "horizontal",
      overflowPx: 12,
      persistent: true,
    },
  ],
  more: 2,
  note: "Not checked at 768 px (timed out).",
};

describe("ArtifactToolResultSchema layout", () => {
  test("a row stored before layout existed still parses", () => {
    const parsed = ArtifactToolResultSchema.safeParse(published);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ success: true, path: "chart.html" });
    expect(layoutOf(parsed.data)).toBeUndefined();
  });

  test("a row with a layout keeps it", () => {
    const parsed = ArtifactToolResultSchema.safeParse({ ...published, layout });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ success: true, layout });
  });

  test("a layout this build cannot read is dropped, not a failed row", () => {
    const fromNewerBuild = { ...layout, notChecked: [{ viewport: 768, reason: "disk-full" }] };
    for (const unreadable of [fromNewerBuild, "garbage", { checked: "maybe" }, 7]) {
      const parsed = ArtifactToolResultSchema.safeParse({ ...published, layout: unreadable });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toMatchObject({ success: true, path: "chart.html" });
      expect(layoutOf(parsed.data)).toBeUndefined();
    }
  });

  test("a failed result stays strict: layout never rides on an error", () => {
    expect(ArtifactToolResultSchema.safeParse({ success: false, error: "no" }).success).toBe(true);
    expect(
      ArtifactToolResultSchema.safeParse({ success: false, error: "no", layout }).success
    ).toBe(false);
  });
});

describe("PTC result types", () => {
  test("the generated artifact result type declares layout", async () => {
    const artifact = tool({ inputSchema: z.object({ path: z.string() }), execute: () => ({}) });
    const types = await generateXumTypes({ artifact });
    expect(types).toContain("type ArtifactResult =");
    expect(types).toContain("layout?:");
    expect(types).toContain("notChecked:");
    expect(types).toContain('"no-agent-browser"');
  });
});
