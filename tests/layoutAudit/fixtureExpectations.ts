import type {
  LayoutAuditRule,
  LayoutAuditViewportWidth,
} from "@/common/constants/artifactLayoutAudit";

/** One finding the shipped audit must report: its rule and the full selector it names. */
export interface ExpectedFinding {
  rule: LayoutAuditRule;
  selector: string;
}

const found = (rule: LayoutAuditRule, selector: string): ExpectedFinding => ({ rule, selector });

/**
 * What the shipped audit must report for each fixture page (tests/fixtures/layout-audit, byte
 * identical to lavish-axi's except the pages marked as Xum's own below) at each width: its findings, one entry per finding, as the rule and
 * the selector. Pinning the selector too means a finding that moves to another element, or a
 * second element that starts to fail while the rule count stays the same, fails the run.
 *
 * Upstream's expectations (test/layout-audit-browser.test.js) cover 390 and 1440 for the pages
 * it lists, by count. Every other entry was MEASURED with this port
 * (`bun tests/layoutAudit/runFixtureAudit.ts --print`) and pinned: upstream never ran 768, nor
 * control-broken-occlusion at 390. When a row fails, find the porting difference. Never tune a
 * threshold or edit a fixture to make it pass.
 */
type WidthExpectations = Record<LayoutAuditViewportWidth, readonly ExpectedFinding[]>;

const CLEAN: WidthExpectations = { 390: [], 1440: [], 768: [] };

/** The same findings at every width. */
const everyWidth = (...findings: ExpectedFinding[]): WidthExpectations => ({
  390: findings,
  1440: findings,
  768: findings,
});

export const FIXTURE_EXPECTATIONS: Readonly<Record<string, WidthExpectations>> = {
  "calibration-small-overflow": CLEAN,
  // Upstream: 3 at 390 and 3 at 1440. A clipped control row and two clipped texts. Measured at
  // 768: the same three.
  "control-broken-clipping": everyWidth(
    found("clipped-control", "html > body > main > div:nth-of-type(1)"),
    found("clipped-text", "span#broken-badge"),
    found("clipped-text", "p#broken-copy")
  ),
  // Upstream: 1 at 1440. Measured at 390 and 768: the same one.
  "control-broken-occlusion": everyWidth(
    found("overlapping-text", "html > body > main > section > p:nth-of-type(1)")
  ),
  "control-broken-overflow": {
    // Upstream: 1 at 390, 0 at 1440. Measured at 768: the page fits.
    390: [found("page-horizontal-overflow", "html")],
    1440: [],
    768: [],
  },
  // Upstream: 3 at 390 and 3 at 1440. Measured at 768: the same three.
  "control-broken-reachability": everyWidth(
    found("viewport-unreachable-control", "html > body > button:nth-of-type(1)"),
    found("viewport-unreachable-control", "html > body > button:nth-of-type(2)"),
    found("viewport-unreachable-control", "html > body > button:nth-of-type(3)")
  ),
  // The pages below are Xum's own, each for a detector miss that upstream shares (found in review
  // of the port). Their rows were measured, then checked against what the page does.
  // A span narrower than its paragraph cuts its text. An ellipsis span and screen-reader-only
  // text inside a paragraph are not findings.
  "nested-clipper-in-paragraph": everyWidth(found("clipped-text", "span#cut-tag")),
  // The cover sits below the first screen at every width: only a scroll reaches it.
  "below-fold-covered": everyWidth(found("overlapping-text", "html > body > main > section > p")),
  // The same page with `scroll-behavior: smooth`: the audit's scrolls must not animate.
  "below-fold-covered-smooth-scroll": everyWidth(
    found("overlapping-text", "html > body > main > section > p")
  ),
  // A long page with a sticky header and a fixed chip over scrolling text: no cover.
  "below-fold-clean": CLEAN,
  // An input, a select and an icon-only button have no text node. The input below them is free.
  "faceless-controls-covered": everyWidth(
    found("overlapping-text", "input#name"),
    found("overlapping-text", "select#plan"),
    found("overlapping-text", "button#close")
  ),
  // An ellipsis does not excuse lines lost below a short box. A one-line ellipsis and a line
  // clamp are the author's cut.
  "ellipsis-clipped-lines": everyWidth(found("clipped-text", "p#lost-lines")),
  "occlusion-exclusions-clean": CLEAN,
  "real-animated-entry": CLEAN,
  "real-carousel": CLEAN,
  "real-dashboard": CLEAN,
  "real-editorial": CLEAN,
  "real-heavy-clean": CLEAN,
  "real-plan-clean": CLEAN,
  "real-poster-overlap": CLEAN,
};
