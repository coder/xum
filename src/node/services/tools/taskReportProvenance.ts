import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { messagesCarryProjectSkillContent } from "@/node/services/agentSkills/loadedSkillSnapshots";

/**
 * Replacement report text for a turn that must not carry project skill
 * content (an untrusted routed turn): the report was distilled from a context
 * that held it, and the tool result is outside the consent gate's redaction.
 */
export const TASK_REPORT_WITHHELD_MESSAGE =
  "[Report withheld: it was distilled from project skill content that Project Trust does not allow to leave the workspace. Restore Project Trust and await the task again to read it.]";

/**
 * Provenance of a workspace turn's report: the target workspace's active
 * segment (the turn ran there, so its rows are the report's context). Fails
 * closed — an unreadable history or no history access classifies as carrying.
 */
export async function workspaceHistoryCarriesProjectSkillContent(
  config: Pick<ToolConfiguration, "historyService">,
  workspaceId: string | undefined
): Promise<boolean> {
  if (workspaceId === undefined || config.historyService === undefined) return true;
  try {
    const history = await config.historyService.getHistoryFromLatestBoundary(workspaceId);
    return !history.success || messagesCarryProjectSkillContent(history.data);
  } catch {
    return true;
  }
}

/**
 * Whether a report is withheld from the turn: its context carried project
 * skill content the turn must not carry. Artifacts distilled from the same
 * context (a git patch whose commits embed the derived text) share the verdict.
 */
export function taskReportWithheld(provenance: { carries: boolean; excludes: boolean }): boolean {
  return provenance.carries && provenance.excludes;
}

/**
 * A completed report in a tool result: withheld (text, title and structured
 * output replaced) when the turn excludes project skill content the report's
 * context carried, stamped `carriesProjectSkillContent` otherwise so the
 * next step's consent gate and request redaction classify the result.
 */
export function applyTaskReportProvenance<
  T extends { reportMarkdown: string; title?: string; structuredOutput?: unknown },
>(
  report: T,
  provenance: { carries: boolean; excludes: boolean }
): T & {
  carriesProjectSkillContent?: boolean;
} {
  if (!provenance.carries) return report;
  if (provenance.excludes) {
    return {
      ...report,
      reportMarkdown: TASK_REPORT_WITHHELD_MESSAGE,
      title: undefined,
      structuredOutput: undefined,
    };
  }
  return { ...report, carriesProjectSkillContent: true };
}
