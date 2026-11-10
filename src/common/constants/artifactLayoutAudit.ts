/**
 * Publish-time layout audit of HTML artifacts (experiment: "artifacts"): the values the page
 * script, the agent-browser driver and the report share. This file has no imports, because the
 * page bundle (scripts/gen_layout_audit_script.ts) pulls it in.
 */

/**
 * The widths every HTML publish is checked at, in RUN order. 390 and 1440 are the widths the
 * ported audit was calibrated at, so they run first; 768 runs last and is the one a tight time
 * budget drops. Reports list viewports by width. `viewportClass` is part of a finding's
 * fingerprint, so a later change of a width inside its class keeps the persistence memory.
 */
export const LAYOUT_AUDIT_VIEWPORTS = [
  { width: 390, height: 844, viewportClass: "phone" },
  { width: 1440, height: 1000, viewportClass: "desktop" },
  { width: 768, height: 1024, viewportClass: "tablet" },
] as const;
export type LayoutAuditViewport = (typeof LAYOUT_AUDIT_VIEWPORTS)[number];
export type LayoutAuditViewportWidth = LayoutAuditViewport["width"];
export type LayoutAuditViewportClass = LayoutAuditViewport["viewportClass"];

/** Rule ids, all severity "error". The order is the report's sort order: root causes first. */
export const LAYOUT_AUDIT_RULES = [
  "page-horizontal-overflow",
  "viewport-unreachable-control",
  "viewport-unreachable-content",
  "clipped-control",
  "clipped-text",
  "overlapping-text",
] as const;
export type LayoutAuditRule = (typeof LAYOUT_AUDIT_RULES)[number];

/**
 * Why a width has no result. Any of these means "not checked", never "clean".
 * Stored in chat history with the tool result: add reasons, never rename one.
 */
export const LAYOUT_AUDIT_NOT_CHECKED_REASONS = [
  // `command -v agent-browser` failed on the workspace runtime.
  "no-agent-browser",
  // .xum/tool_env failed to source (trusted projects only).
  "tool-env-failed",
  // The run hit its deadline before this width's result was complete.
  "timeout",
  // The tool call was cancelled.
  "aborted",
  // agent-browser could not set the viewport, open the page or run the script.
  "browser-failed",
  // The script threw in the page or returned something that is not a page result.
  "script-failed",
  // The pass ran but the page kept animating or changing, so its findings are not trusted.
  "unsettled",
  // The page reported a different width than the one requested.
  "wrong-viewport",
] as const;
export type LayoutAuditNotCheckedReason = (typeof LAYOUT_AUDIT_NOT_CHECKED_REASONS)[number];

/** The whole publish-time audit (run plus session close) must fit in this. */
export const LAYOUT_AUDIT_BUDGET_MS = 15_000;
/** Held back from the run so closing the browser session always has time. */
export const LAYOUT_AUDIT_CLOSE_RESERVE_MS = 3_000;
/** Issues listed in one tool result; the rest are counted in `more`. */
export const LAYOUT_AUDIT_MAX_ISSUES = 10;
/** Longest selector shown in a tool result. Fingerprints use the full selector. */
export const LAYOUT_AUDIT_MAX_SELECTOR_CHARS = 120;
/** Findings one page pass may return (bounds the driver's output, not the model's view). */
export const LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS = 50;
/** Longest guidance line in a tool result. */
export const LAYOUT_AUDIT_MAX_NOTE_CHARS = 240;
