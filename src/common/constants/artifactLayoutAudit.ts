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

/**
 * The whole publish-time audit (run plus session close) must fit in this. Only the removal of the
 * run's folder after a failed close comes on top (agentBrowserLayoutRun.ts).
 */
export const LAYOUT_AUDIT_BUDGET_MS = 15_000;
/** Held back from the run so closing the browser session always has time. */
export const LAYOUT_AUDIT_CLOSE_RESERVE_MS = 3_000;
/** Issues listed in one tool result; the rest are counted in `more`. */
export const LAYOUT_AUDIT_MAX_ISSUES = 10;
/** Longest selector shown in a tool result. Fingerprints use the full selector. */
export const LAYOUT_AUDIT_MAX_SELECTOR_CHARS = 120;
/** Longest guidance line in a tool result. */
export const LAYOUT_AUDIT_MAX_NOTE_CHARS = 240;

/**
 * The page audit's numbers, unchanged from lavish-axi's calibration (src/artifact-sdk.js at
 * commit 69bf309, MIT; see src/browser/layoutAudit/lavish-axi-LICENSE.txt). Change a value only
 * together with a re-run of the fixture corpus (`make test-layout-audit-browser`): the corpus is
 * what makes the values trustworthy, and a false alarm costs more than a missed layout bug.
 */
export const LAYOUT_AUDIT_THRESHOLDS = {
  /** Elements the rules inspect, counted in document order from <body>. */
  maxAuditedElements: 800,
  /** Candidates the overlap rule samples (after its own filters). */
  maxOcclusionCandidates: 200,
  /** A document wider than the viewport by less than max(this, ratio of the width) is cosmetic. */
  pageOverflowMinPx: 24,
  pageOverflowMinViewportRatio: 0.05,
  /** Text must leave its clipping box by MORE than this to count (font ink is not a defect). */
  textEpsilonPx: 1,
  /** A line or box counts as escaped when this share of it is outside, or its center is. */
  minOutsideRatio: 0.2,
  /** A control must escape its clipping ancestor or the viewport edge by at least this. */
  controlMinOutsidePx: 4,
  /** At or below this opacity (or hidden, display none) an element is not audited. */
  hiddenOpacity: 0.01,
  /** Standard "visually hidden" text is at most this wide and tall. */
  visuallyHiddenMaxPx: 2,
  /** Overlap needs at least this many sample points, of which `occlusionMinRatio` are covered. */
  occlusionMinSamples: 5,
  occlusionMinRatio: 0.9,
  /** A cover counts when its background alpha and its opacity are at least this. */
  opaqueMin: 0.95,
  /** Where inside a text line the overlap rule samples, on both axes. */
  samplePositions: [0.2, 0.5, 0.8],
  /** Text lines smaller than this area (px squared) are not sampled. */
  minFragmentArea: 16,
  /** Overlap judges text of at least this many characters (any length for a control). */
  occlusionMinTextChars: 8,
  /** Longest selector path a finding carries. */
  selectorMaxParts: 5,
  /** Findings report overflow to this precision (tenths of a pixel). */
  overflowPrecision: 10,
} as const;

/**
 * A sanity bound on the findings of one page pass, so a broken page result cannot be unbounded.
 * No real pass reaches it: the rules inspect at most `maxAuditedElements` elements and, per
 * element, report at most 5 findings (clipped-control, viewport-unreachable-control on each of
 * two axes, viewport-unreachable-content and clipped-text). The overlap rule adds at most one
 * per sampled candidate, `maxOcclusionCandidates` in all, and the page overflow rule one: 800 x
 * 5 + 200 + 1 = 4201. A pass over the bound is rejected at the boundary, and that width reads
 * as not checked.
 */
export const LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS =
  LAYOUT_AUDIT_THRESHOLDS.maxAuditedElements * 5 +
  LAYOUT_AUDIT_THRESHOLDS.maxOcclusionCandidates +
  1;

/** How the page is let settle before the audit measures it (lavish-axi's values). */
export const LAYOUT_AUDIT_SETTLE = {
  /** Silence that counts as settled, for element resizes and for DOM changes. */
  quietMs: 180,
  /** The longest wait for that silence, for each of the two. */
  quietMaxMs: 2_000,
  /** The longest wait for finite animations to finish. */
  animationMaxMs: 4_000,
  /** Pause between the two samples; a finding must be in both. */
  sampleGapMs: 120,
  /** Animation frames waited before each sample. */
  frames: 2,
} as const;
