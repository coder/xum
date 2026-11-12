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

const OVERFLOW_AND_REACH = [
  found("viewport-unreachable-control", "button#fab"),
  found("clipped-text", "p#spill"),
  found("clipped-text", "div#clamp"),
];
const OVERFLOW_AND_REACH_WIDE = [found("page-horizontal-overflow", "html"), ...OVERFLOW_AND_REACH];

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
  // The tag's visible text fits. Hidden text past its edge still has line boxes: no finding.
  "nested-clipper-hidden-text": CLEAN,
  // The cover sits below the first screen at every width: only a scroll reaches it.
  "below-fold-covered": everyWidth(found("overlapping-text", "html > body > main > section > p")),
  // The same page with `scroll-behavior: smooth`: the audit's scrolls must not animate.
  "below-fold-covered-smooth-scroll": everyWidth(
    found("overlapping-text", "html > body > main > section > p")
  ),
  // A long page with a sticky header and a fixed chip over scrolling text: no cover.
  "below-fold-clean": CLEAN,
  // An input, a select and an icon-only button have no text node, and neither has an input inside
  // a label (the label's text is no face for it). The input at the end is free.
  "faceless-controls-covered": everyWidth(
    found("overlapping-text", "input#name"),
    found("overlapping-text", "select#plan"),
    found("overlapping-text", "button#close"),
    found("overlapping-text", "input#in-label")
  ),
  // An ellipsis does not excuse lines lost below a short box. A one-line ellipsis and a line
  // clamp are the author's cut.
  "ellipsis-clipped-lines": everyWidth(found("clipped-text", "p#lost-lines")),
  // Four sections, each read wrongly before the element facts were fixed. A textarea that holds
  // text, covered inside its label, was a miss: a browser gives that text no line, so the control is
  // sampled by its box. The menu row was reported as clipped-text instead of the clipped-control it
  // is: a button with role menuitem is a control. The card was a miss: a paragraph with
  // `display: contents` has no box, and its one long word is cut by the card (its ellipsis cuts and
  // excuses nothing). The note was a false alarm (clipped-text): the long line that is hidden inside
  // the clipping note does not clip it.
  "text-controls-and-boundaries": everyWidth(
    found("clipped-control", "div#menu"),
    found("clipped-text", "div#card"),
    found("overlapping-text", "textarea#notes")
  ),
  // An image that widens the page (at 390 and 768, where 900 px does not fit), a fixed control
  // past the right edge, a text box with no height whose text spills, and a word cut sideways in a
  // line-clamped box are findings. A sticky control below the fold and a wrapper with no box that
  // has `overflow: hidden` are not.
  "overflow-and-reach": {
    390: OVERFLOW_AND_REACH_WIDE,
    1440: OVERFLOW_AND_REACH,
    768: OVERFLOW_AND_REACH_WIDE,
  },
  "occlusion-exclusions-clean": CLEAN,
  "real-animated-entry": CLEAN,
  "real-carousel": CLEAN,
  "real-dashboard": CLEAN,
  "real-editorial": CLEAN,
  "real-heavy-clean": CLEAN,
  "real-plan-clean": CLEAN,
  "real-poster-overlap": CLEAN,
};
