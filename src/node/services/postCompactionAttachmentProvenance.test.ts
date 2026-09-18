import { describe, expect, it } from "bun:test";

import type { PostCompactionAttachment } from "@/common/types/attachment";

import {
  attachmentsCarryProjectSkillContent,
  excludeProjectSkillContentFromAttachments,
} from "./postCompactionAttachmentProvenance";

const projectSkill = {
  name: "done",
  scope: "project" as const,
  sha256: "p",
  body: "PROJECT SKILL BODY",
};
const globalSkill = {
  name: "team-style",
  scope: "global" as const,
  sha256: "g",
  body: "GLOBAL SKILL BODY",
};

const carryingReport = {
  id: "task-carrying",
  kind: "task" as const,
  title: "Applied the project conventions",
  carriesProjectSkillContent: true,
  completedAtMs: 2,
};
const cleanReport = {
  id: "task-clean",
  kind: "task" as const,
  title: "Mapped the tooling",
  carriesProjectSkillContent: false,
  completedAtMs: 1,
};

describe("post-compaction attachment provenance", () => {
  it("classifies project-scope skills and carrying report entries, nothing else", () => {
    expect(attachmentsCarryProjectSkillContent(null)).toBe(false);
    expect(
      attachmentsCarryProjectSkillContent([
        { type: "loaded_skills_snapshot", skills: [globalSkill] },
        { type: "completed_reports_index", reports: [cleanReport] },
        { type: "read_files_reference", paths: ["/repo/src/a.ts"] },
      ])
    ).toBe(false);
    expect(
      attachmentsCarryProjectSkillContent([
        { type: "loaded_skills_snapshot", skills: [globalSkill, projectSkill] },
      ])
    ).toBe(true);
    // A report title distilled from project skill content is repository-
    // derived text by another channel than the snapshot rows.
    expect(
      attachmentsCarryProjectSkillContent([
        { type: "completed_reports_index", reports: [cleanReport, carryingReport] },
      ])
    ).toBe(true);
  });

  it("drops project skills and withholds carrying report titles, keeping the re-fetch handles", () => {
    const attachments: PostCompactionAttachment[] = [
      { type: "loaded_skills_snapshot", skills: [globalSkill, projectSkill] },
      { type: "completed_reports_index", reports: [cleanReport, carryingReport] },
      { type: "read_files_reference", paths: ["/repo/src/a.ts"] },
    ];
    const excluded = excludeProjectSkillContentFromAttachments(attachments);
    expect(excluded).toEqual([
      { type: "loaded_skills_snapshot", skills: [globalSkill] },
      {
        type: "completed_reports_index",
        reports: [cleanReport, { id: "task-carrying", kind: "task", completedAtMs: 2 }],
      },
      { type: "read_files_reference", paths: ["/repo/src/a.ts"] },
    ]);
    expect(JSON.stringify(excluded)).not.toContain("Applied the project conventions");
    // The excluded set carries nothing left to gate.
    expect(attachmentsCarryProjectSkillContent(excluded)).toBe(false);
    // Input untouched.
    expect(attachments[1]).toMatchObject({ reports: [cleanReport, carryingReport] });
  });

  it("removes a loaded-skills attachment emptied by the exclusion and passes null through", () => {
    expect(excludeProjectSkillContentFromAttachments(null)).toBeNull();
    expect(
      excludeProjectSkillContentFromAttachments([
        { type: "loaded_skills_snapshot", skills: [projectSkill] },
        { type: "completed_reports_index", reports: [cleanReport] },
      ])
    ).toEqual([{ type: "completed_reports_index", reports: [cleanReport] }]);
  });
});
