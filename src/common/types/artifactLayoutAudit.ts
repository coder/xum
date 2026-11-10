import { z } from "zod";
import {
  LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS,
  LAYOUT_AUDIT_MAX_ISSUES,
  LAYOUT_AUDIT_MAX_NOTE_CHARS,
  LAYOUT_AUDIT_NOT_CHECKED_REASONS,
  LAYOUT_AUDIT_RULES,
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditViewportWidth,
} from "@/common/constants/artifactLayoutAudit";

const LayoutAuditAxisSchema = z.enum(["horizontal", "vertical"]);
export type LayoutAuditAxis = z.infer<typeof LayoutAuditAxisSchema>;

/** One finding as the page script reports it. The selector is the full one. */
export const LayoutAuditPageFindingSchema = z.object({
  rule: z.enum(LAYOUT_AUDIT_RULES),
  selector: z.string().min(1),
  axis: LayoutAuditAxisSchema,
  overflowPx: z.number().finite().nonnegative(),
});
export type LayoutAuditPageFinding = z.infer<typeof LayoutAuditPageFindingSchema>;

/**
 * What the page script resolves to. `complete: false` means the pass could not vouch for the
 * page (it crashed, or the page never settled): its findings are not evidence, and an empty
 * list is not a clean result.
 */
export const LayoutAuditPagePassSchema = z.object({
  complete: z.boolean(),
  viewportWidth: z.number().finite(),
  findings: z.array(LayoutAuditPageFindingSchema).max(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS),
});
export type LayoutAuditPagePass = z.infer<typeof LayoutAuditPagePassSchema>;

const widths = LAYOUT_AUDIT_VIEWPORTS.map((viewport) => viewport.width);
const LayoutAuditViewportWidthSchema = z
  .number()
  .refine((value): value is LayoutAuditViewportWidth => widths.some((width) => width === value));

export const LayoutAuditIssueSchema = z.object({
  rule: z.enum(LAYOUT_AUDIT_RULES),
  /** Shortened for display. */
  selector: z.string(),
  viewport: LayoutAuditViewportWidthSchema,
  axis: LayoutAuditAxisSchema,
  /** Whole pixels. Not part of the fingerprint. */
  overflowPx: z.number().int().nonnegative(),
  /** The last complete check of this path at this viewport class found the same issue. */
  persistent: z.literal(true).optional(),
});
export type LayoutAuditIssue = z.infer<typeof LayoutAuditIssueSchema>;

const LayoutAuditNotCheckedSchema = z.object({
  viewport: LayoutAuditViewportWidthSchema,
  reason: z.enum(LAYOUT_AUDIT_NOT_CHECKED_REASONS),
});
export type LayoutAuditNotChecked = z.infer<typeof LayoutAuditNotCheckedSchema>;

const reportFields = {
  issues: z.array(LayoutAuditIssueSchema).max(LAYOUT_AUDIT_MAX_ISSUES),
  /** Issues found but not listed. */
  more: z.number().int().positive().optional(),
  /** One line: what the agent should do next. */
  note: z.string().max(LAYOUT_AUDIT_MAX_NOTE_CHARS),
};

/**
 * The `layout` field of an `artifact` tool result. `checked: true` only when every width
 * completed a settled pass. A union, so `notChecked` exists exactly when `checked` is false: a
 * failure cannot be written as a clean result. Stored in chat history: change it additively.
 */
export const LayoutAuditReportSchema = z.discriminatedUnion("checked", [
  z.object({ checked: z.literal(true), ...reportFields }),
  z.object({
    checked: z.literal(false),
    notChecked: z.array(LayoutAuditNotCheckedSchema).min(1).max(LAYOUT_AUDIT_VIEWPORTS.length),
    ...reportFields,
  }),
]);
export type LayoutAuditReport = z.infer<typeof LayoutAuditReportSchema>;
