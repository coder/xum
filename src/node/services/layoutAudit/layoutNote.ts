import {
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditNotCheckedReason,
} from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditNotChecked } from "@/common/types/artifactLayoutAudit";

/** Short on purpose: the note must fit LAYOUT_AUDIT_MAX_NOTE_CHARS in its longest combination. */
const REASON_TEXT: Record<LayoutAuditNotCheckedReason, string> = {
  "no-agent-browser": "agent-browser not found",
  "tool-env-failed": ".xum/tool_env failed",
  timeout: "timed out",
  aborted: "stopped",
  "browser-failed": "page did not load",
  "script-failed": "audit script failed",
  unsettled: "page kept changing",
  "wrong-viewport": "wrong window size",
};

const ALL_WIDTHS = LAYOUT_AUDIT_VIEWPORTS.map((viewport) => viewport.width).sort((a, b) => a - b);

const CLEAN = `No layout issues at ${ALL_WIDTHS.join(", ").replace(/, (\d+)$/, " and $1")} px.`;
const CLEAN_WHERE_CHECKED = "No issues at the other widths. Do not call the layout verified.";
const NOT_VERIFIED = "Do not call the layout verified.";
const FIX_NEW =
  "Fix each listed element at its width (let text wrap or shrink, keep controls inside their containers), then publish again.";
// "Persistent" is the permission to stop: a fix loop that the audit cannot end by itself would
// otherwise run until the agent gives up on its own.
const FIX_NEW_AND_PERSISTENT =
  "Fix the new issues, then publish again. Issues marked persistent were also reported last time: if you cannot fix them, move on and tell the user.";
const ONLY_PERSISTENT =
  "Every issue was also reported last time: if you cannot fix them, move on and tell the user.";

export interface LayoutNoteInput {
  notChecked: readonly LayoutAuditNotChecked[];
  newCount: number;
  persistentCount: number;
}

/** "390, 768 px (timed out), 1440 px (page kept changing)": widths grouped by their reason. */
function describeNotChecked(notChecked: readonly LayoutAuditNotChecked[]): string {
  const widthsByReason = new Map<LayoutAuditNotCheckedReason, number[]>();
  for (const { viewport, reason } of notChecked) {
    widthsByReason.set(reason, [...(widthsByReason.get(reason) ?? []), viewport]);
  }
  return [...widthsByReason]
    .map(([reason, widths]) => `${widths.join(", ")} px (${REASON_TEXT[reason]})`)
    .join(", ");
}

function actionSentence(input: LayoutNoteInput): string {
  if (input.newCount > 0) return input.persistentCount > 0 ? FIX_NEW_AND_PERSISTENT : FIX_NEW;
  if (input.persistentCount > 0) return ONLY_PERSISTENT;
  if (input.notChecked.length === 0) return CLEAN;
  return input.notChecked.length < ALL_WIDTHS.length ? CLEAN_WHERE_CHECKED : NOT_VERIFIED;
}

/**
 * The one line that tells the agent what to do next. Built from fixed strings only: no selector
 * and no error text reaches it, so a page cannot write into it. Coverage comes first, so a width
 * that was not checked is never read as a width that was clean.
 */
export function layoutNote(input: LayoutNoteInput): string {
  const action = actionSentence(input);
  if (input.notChecked.length === 0) return action;
  return `Not checked at ${describeNotChecked(input.notChecked)}. ${action}`;
}
