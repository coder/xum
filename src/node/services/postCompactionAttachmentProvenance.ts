import type { CompletedReportEntry, PostCompactionAttachment } from "@/common/types/attachment";

/**
 * Post-compaction attachments carry repository-controlled content by channels
 * the request row scan never sees: a loaded-skills attachment re-injects the
 * scope AND body of every project skill read before the boundary, and the
 * completed-reports index carries the title of every child report — text
 * distilled from a report whose context carried project skill content.
 */
export function attachmentsCarryProjectSkillContent(
  attachments: PostCompactionAttachment[] | null
): boolean {
  return (
    attachments?.some((attachment) =>
      attachment.type === "loaded_skills_snapshot"
        ? attachment.skills.some((skill) => skill.scope === "project")
        : attachment.type === "completed_reports_index" &&
          attachment.reports.some((report) => report.carriesProjectSkillContent === true)
    ) === true
  );
}

/**
 * Least-privilege counterpart: project-scope skills drop out (an emptied
 * attachment with them), and a report entry carrying the provenance loses its
 * title and its stamp — the id stays, so the model can still re-fetch the
 * report through task_await, which withholds it on the same verdict. The
 * result carries nothing left for the consent gate to guard.
 */
export function excludeProjectSkillContentFromAttachments(
  attachments: PostCompactionAttachment[] | null
): PostCompactionAttachment[] | null {
  if (attachments === null) {
    return null;
  }
  return attachments.flatMap((attachment): PostCompactionAttachment[] => {
    if (attachment.type === "loaded_skills_snapshot") {
      const skills = attachment.skills.filter((skill) => skill.scope !== "project");
      return skills.length > 0 ? [{ ...attachment, skills }] : [];
    }
    if (attachment.type === "completed_reports_index") {
      return [
        {
          ...attachment,
          reports: attachment.reports.map((report) =>
            report.carriesProjectSkillContent === true ? withoutDerivedText(report) : report
          ),
        },
      ];
    }
    return [attachment];
  });
}

function withoutDerivedText(report: CompletedReportEntry): CompletedReportEntry {
  const { title: _title, carriesProjectSkillContent: _carries, ...handle } = report;
  return handle;
}
