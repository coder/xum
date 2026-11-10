import type {
  LayoutAuditRule,
  LayoutAuditViewportWidth,
} from "@/common/constants/artifactLayoutAudit";

/**
 * What the shipped audit must report for each fixture page (tests/fixtures/layout-audit, byte
 * identical to lavish-axi's) at each width: the rules of its findings, one entry per finding.
 *
 * Upstream's expectations (test/layout-audit-browser.test.js) cover 390 and 1440 for the pages
 * it lists. Every other entry was MEASURED with this port (`bun tests/layoutAudit/runFixtureAudit.ts
 * --print`) and pinned: upstream never ran 768, nor control-broken-occlusion at 390. When a row
 * fails, find the porting difference. Never tune a threshold or edit a fixture to make it pass.
 */
type WidthExpectations = Record<LayoutAuditViewportWidth, readonly LayoutAuditRule[]>;

const CLEAN: WidthExpectations = { 390: [], 1440: [], 768: [] };

export const FIXTURE_EXPECTATIONS: Readonly<Record<string, WidthExpectations>> = {
  "calibration-small-overflow": CLEAN,
  "control-broken-clipping": {
    // Upstream: 3 at 390 and 3 at 1440. A clipped control row and two clipped texts.
    390: ["clipped-control", "clipped-text", "clipped-text"],
    1440: ["clipped-control", "clipped-text", "clipped-text"],
    // Measured: the same three failures.
    768: ["clipped-control", "clipped-text", "clipped-text"],
  },
  "control-broken-occlusion": {
    // Upstream: 1 at 1440. Measured at 390 and 768: the same one.
    390: ["overlapping-text"],
    1440: ["overlapping-text"],
    768: ["overlapping-text"],
  },
  "control-broken-overflow": {
    // Upstream: 1 at 390, 0 at 1440. Measured at 768: the page fits.
    390: ["page-horizontal-overflow"],
    1440: [],
    768: [],
  },
  "control-broken-reachability": {
    // Upstream: 3 at 390 and 3 at 1440. Measured at 768: the same three.
    390: ["viewport-unreachable-control", "viewport-unreachable-control", "viewport-unreachable-control"],
    1440: ["viewport-unreachable-control", "viewport-unreachable-control", "viewport-unreachable-control"],
    768: ["viewport-unreachable-control", "viewport-unreachable-control", "viewport-unreachable-control"],
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
