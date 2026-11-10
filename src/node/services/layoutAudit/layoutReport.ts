import {
  LAYOUT_AUDIT_MAX_ISSUES,
  LAYOUT_AUDIT_MAX_SELECTOR_CHARS,
  LAYOUT_AUDIT_RULES,
} from "@/common/constants/artifactLayoutAudit";
import type {
  LayoutAuditIssue,
  LayoutAuditNotChecked,
  LayoutAuditPageFinding,
  LayoutAuditReport,
} from "@/common/types/artifactLayoutAudit";
import {
  layoutFingerprint,
  type FingerprintSnapshot,
} from "@/node/services/layoutAudit/layoutFingerprints";
import { layoutNote } from "@/node/services/layoutAudit/layoutNote";
import type { ViewportOutcome } from "@/node/services/layoutAudit/viewportOutcome";

type CompleteOutcome = Extract<ViewportOutcome, { status: "complete" }>;

interface Candidate {
  issue: LayoutAuditIssue;
  /** The full selector: it decides ties, and the fingerprint came from it. */
  selector: string;
  fingerprint: string;
}

/**
 * What the model sees of a selector: control characters become spaces (a page cannot start a
 * line in the model's context) and a long one is cut at the cap, never inside a surrogate pair.
 */
function displaySelector(selector: string): string {
  const text = selector.replace(/\p{Cc}/gu, " ");
  if (text.length <= LAYOUT_AUDIT_MAX_SELECTOR_CHARS) return text;
  return `${text.slice(0, LAYOUT_AUDIT_MAX_SELECTOR_CHARS - 1).replace(/\p{Cs}$/u, "")}…`;
}

/**
 * One finding per fingerprint within a width: the page may report the same rule and selector on
 * both axes, and the larger overflow is the one worth showing.
 */
function strongestPerFingerprint(
  findings: readonly LayoutAuditPageFinding[]
): Map<string, LayoutAuditPageFinding> {
  const strongest = new Map<string, LayoutAuditPageFinding>();
  for (const finding of findings) {
    const fingerprint = layoutFingerprint(finding.rule, finding.selector);
    const known = strongest.get(fingerprint);
    if (known === undefined || finding.overflowPx > known.overflowPx) {
      strongest.set(fingerprint, finding);
    }
  }
  return strongest;
}

function toCandidates(outcome: CompleteOutcome, previous: FingerprintSnapshot): Candidate[] {
  const seenBefore = previous[outcome.viewport.viewportClass];
  return [...strongestPerFingerprint(outcome.findings)].map(([fingerprint, finding]) => ({
    fingerprint,
    selector: finding.selector,
    issue: {
      rule: finding.rule,
      selector: displaySelector(finding.selector),
      viewport: outcome.viewport.width,
      axis: finding.axis,
      overflowPx: Math.min(Math.round(finding.overflowPx), Number.MAX_SAFE_INTEGER),
      ...(seenBefore?.has(fingerprint) === true ? { persistent: true as const } : {}),
    },
  }));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/** New before persistent, then narrow to wide, root causes first, then the biggest overflow. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    Number(a.issue.persistent === true) - Number(b.issue.persistent === true) ||
    a.issue.viewport - b.issue.viewport ||
    LAYOUT_AUDIT_RULES.indexOf(a.issue.rule) - LAYOUT_AUDIT_RULES.indexOf(b.issue.rule) ||
    b.issue.overflowPx - a.issue.overflowPx ||
    compareText(a.selector, b.selector)
  );
}

function toNotChecked(outcome: ViewportOutcome): LayoutAuditNotChecked[] {
  if (outcome.status === "complete") return [];
  const reason = outcome.status === "unsettled" ? "unsettled" : outcome.reason;
  return [{ viewport: outcome.viewport.width, reason }];
}

/**
 * Memory after this pass: a complete width replaces the set of its class (a complete clean pass
 * clears it), and a width that failed or never settled leaves its class as it was. An unsettled
 * or failed pass is uncertainty, not repair, so it neither confirms nor clears a finding.
 */
function nextSnapshot(
  complete: readonly CompleteOutcome[],
  previous: FingerprintSnapshot
): FingerprintSnapshot {
  const next: FingerprintSnapshot = { ...previous };
  for (const outcome of complete) {
    next[outcome.viewport.viewportClass] = new Set(
      outcome.findings.map((finding) => layoutFingerprint(finding.rule, finding.selector))
    );
  }
  return next;
}

/**
 * Pure: outcomes of one audit and the memory before it become the model-facing report and the
 * memory after it. `checked` is true only when every width completed a settled pass. The
 * issues of the widths that did complete are listed either way.
 */
export function buildLayoutReport(
  outcomes: readonly ViewportOutcome[],
  previous: FingerprintSnapshot
): { report: LayoutAuditReport; next: FingerprintSnapshot } {
  const complete = outcomes.filter((outcome): outcome is CompleteOutcome => {
    return outcome.status === "complete";
  });
  const candidates = complete
    .flatMap((outcome) => toCandidates(outcome, previous))
    .sort(compareCandidates);
  const issues = candidates.slice(0, LAYOUT_AUDIT_MAX_ISSUES).map((candidate) => candidate.issue);
  const notChecked = outcomes
    .flatMap(toNotChecked)
    .sort((a, b) => a.viewport - b.viewport);
  const persistentCount = candidates.filter((candidate) => candidate.issue.persistent).length;
  const common = {
    issues,
    ...(candidates.length > issues.length ? { more: candidates.length - issues.length } : {}),
    note: layoutNote({
      notChecked,
      newCount: candidates.length - persistentCount,
      persistentCount,
    }),
  };
  return {
    report: notChecked.length === 0 ? { checked: true, ...common } : { checked: false, notChecked, ...common },
    next: nextSnapshot(complete, previous),
  };
}
