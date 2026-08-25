import { describe, expect, it } from "bun:test";
import { parsePatch } from "diff";
import { AgentSkillPackageSchema } from "@/common/orpc/schemas/agentSkill";
import { MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import {
  KERNEL_RETAINED_CONTAINER_MAX_PARTS,
  KERNEL_RETAINED_MEDIA_BUDGET_BYTES,
} from "@/constants/kernelOutput";
import {
  retainExemptKernelRecordResult,
  retainPersistenceCriticalArgsFields,
  sanitizeMediaRecordCapture,
} from "./types";

interface RetainedContainer {
  type?: string;
  value: Array<{ type?: string; text?: string; data?: string }>;
}

describe("retainExemptKernelRecordResult", () => {
  describe("agent_skill_read", () => {
    const oversizedSkill = {
      scope: "project",
      directoryName: "demo",
      frontmatter: { name: "demo", description: "a demo skill" },
      body: "B".repeat(MAX_FILE_CONTENT_SIZE),
    };

    it("truncates an oversized skill body into a schema-valid bounded package", () => {
      // A valid skill near the 50k snapshot limit serializes above the
      // retained-record cap once frontmatter overhead is added; discarding it
      // would erase the skill instructions from every later turn — the body
      // must degrade like createLoadedSkillSnapshot's own truncation.
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: oversizedSkill,
      }) as { success?: boolean; skill?: { body?: string } };
      expect(retained?.success).toBe(true);
      expect(retained?.skill?.body?.startsWith("BBB")).toBe(true);
      expect(
        retained?.skill?.body?.endsWith(
          "[Skill body truncated at capture to fit the retained-record cap]"
        )
      ).toBe(true);
      expect(JSON.stringify(retained).length).toBeLessThanOrEqual(MAX_FILE_CONTENT_SIZE);
      // The snapshot extractor's schema still accepts the bounded package.
      expect(AgentSkillPackageSchema.safeParse(retained?.skill).success).toBe(true);
    });

    it("falls back to normal bounding for malformed oversized packages", () => {
      const retained = retainExemptKernelRecordResult("agent_skill_read", {
        success: true,
        skill: "not-an-object".repeat(10_000),
      });
      expect(retained).toBeUndefined();
    });
  });

  describe("file_edit_* diff bounding", () => {
    it("retains a parseable hunk-boundary prefix for oversized multi-hunk diffs", () => {
      const hunk1 = `@@ -1,0 +1,1 @@\n+${"a".repeat(30_000)}\n`;
      const diff = `Index: /x.ts\n===\n--- /x.ts\n+++ /x.ts\n${hunk1}@@ -9,0 +10,1 @@\n+${"b".repeat(30_000)}\n`;
      const retained = retainExemptKernelRecordResult("file_edit_replace_string", {
        success: true,
        diff,
      }) as { success?: boolean; diff?: string; diffTruncated?: boolean };
      expect(retained.success).toBe(true);
      expect(retained.diffTruncated).toBe(true);
      expect(retained.diff?.endsWith(hunk1)).toBe(true);
      // combineDiffs must be able to parse and apply the retained prefix.
      const patches = parsePatch(retained.diff!);
      expect(patches[0]?.hunks.length).toBe(1);
    });

    it("drops the diff but keeps the truncation flag when no whole hunk fits", () => {
      const retained = retainExemptKernelRecordResult("file_edit_insert", {
        success: true,
        diff: `@@ -1,0 +1,1 @@\n+${"g".repeat(60_000)}\n`,
      }) as { success?: boolean; diff?: string; diffTruncated?: boolean };
      expect(retained.success).toBe(true);
      expect(retained.diff).toBeUndefined();
      expect(retained.diffTruncated).toBe(true);
    });
  });

  describe("media container budgets", () => {
    it("charges media metadata against the budget (empty-data mediaType attack)", () => {
      // transformMCPResult copies server-controlled MIME types unchanged and
      // the supported-type check accepts any image/ prefix, so a part hiding
      // megabytes in mediaType with an EMPTY data string must still be
      // charged — and the placeholder must not echo the junk label.
      const junkType = `image/${"m".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES)}`;
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          { type: "media", mediaType: junkType, data: "" },
        ],
      }) as RetainedContainer;
      expect(retained.value[0]?.data).toBe("aGVsbG8=");
      expect(retained.value[1]?.type).toBe("text");
      expect(retained.value[1]?.text).toContain("aggregate media budget exceeded");
      expect(retained.value[1]?.text!.length).toBeLessThan(300);
    });

    it("charges non-media sibling parts against the budget", () => {
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          { type: "text", text: "T".repeat(KERNEL_RETAINED_MEDIA_BUDGET_BYTES) },
        ],
      }) as RetainedContainer;
      expect(retained.value[0]?.data).toBe("aGVsbG8=");
      expect(retained.value[1]?.text).toContain("part bounded at capture");
    });

    it("caps the retained part count", () => {
      const retained = retainExemptKernelRecordResult("mcp__shots__take", {
        type: "content",
        value: [
          { type: "media", mediaType: "image/png", data: "aGVsbG8=" },
          ...Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `t${i}` })),
        ],
      }) as RetainedContainer;
      expect(retained.value.length).toBe(KERNEL_RETAINED_CONTAINER_MAX_PARTS + 1);
      expect(retained.value[KERNEL_RETAINED_CONTAINER_MAX_PARTS]?.text).toContain(
        "container part limit exceeded"
      );
    });
  });
});

describe("sanitizeMediaRecordCapture", () => {
  it("passes non-container results through untouched (non-RLM inline-results contract)", () => {
    const result = { success: true, output: "x".repeat(100_000) };
    expect(sanitizeMediaRecordCapture("bash", result)).toBe(result);
  });

  it("bounds containers holding only unsupported media", () => {
    // containsMediaContentPayload would NOT exempt this container (no
    // supported media), but the mode-independent sanitizer must still bound
    // it: classic mode would otherwise persist the raw base64 into records.
    const sanitized = sanitizeMediaRecordCapture("mcp__rec__capture", {
      type: "content",
      value: [{ type: "media", mediaType: "audio/wav", data: "d2F2".repeat(50) }],
    }) as RetainedContainer;
    expect(sanitized.value[0]?.type).toBe("text");
    expect(sanitized.value[0]?.text).toContain("not supported as a model attachment");
  });
});

describe("retainPersistenceCriticalArgsFields", () => {
  it("preserves the validated path for file_edit tools", () => {
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", {
        path: "/a.ts",
        content: "x".repeat(5_000),
      })
    ).toEqual({ path: "/a.ts" });
  });

  it("returns undefined for non-persistence-critical tools and unusable paths", () => {
    expect(retainPersistenceCriticalArgsFields("bash", { path: "/a.ts" })).toBeUndefined();
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", "not-an-object")
    ).toBeUndefined();
    // A path longer than any real filesystem path is guest junk: dropping it
    // beats recording a truncated (wrong) attribution.
    expect(
      retainPersistenceCriticalArgsFields("file_edit_insert", { path: "p".repeat(5_000) })
    ).toBeUndefined();
  });
});
