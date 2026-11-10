// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import {
  LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS,
  LAYOUT_AUDIT_SETTLE as SETTLE,
} from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPagePass } from "@/common/types/artifactLayoutAudit";
import { auditLayout } from "./audit";
import { findStableLayoutFindings } from "./geometry";
import type { LayoutPage, SettleSignals } from "./layoutPage";

/**
 * Upstream's `runLayoutAudit`: let the page settle, measure twice 120 ms apart, and keep only
 * what both samples saw, so a page that is still moving cannot raise a finding.
 *
 *   fonts, then no element resized for 180 ms (at most 2 s), then finite animations finished
 *   (at most 4 s), then 2 frames, then sample A; 120 ms and 2 frames later sample B; then the
 *   DOM left unchanged for 180 ms (at most 2 s). When it was, a third sample C is taken and the
 *   findings are those in both B and C. When it was not, they are those in both A and B.
 *
 * `complete` says the pass may be trusted: the finite animations finished, the document was
 * fully loaded and the DOM went quiet. An incomplete pass is uncertainty, never a clean result.
 * Upstream reschedules an incomplete pass; this runs once, because each publish loads a fresh page.
 */
export async function runLayoutAudit(
  page: LayoutPage,
  signals: SettleSignals,
): Promise<LayoutAuditPagePass> {
  await signals.fontsReady();
  await signals.layoutQuiet(SETTLE.quietMs, SETTLE.quietMaxMs);
  const animationsSettled = await signals.finiteAnimationsSettled(SETTLE.animationMaxMs);
  await signals.frames(SETTLE.frames);
  const first = auditLayout(page);
  await signals.sleep(SETTLE.sampleGapMs);
  await signals.frames(SETTLE.frames);
  const second = auditLayout(page);
  const domQuiet = await signals.domQuiet(SETTLE.quietMs, SETTLE.quietMaxMs);
  const final = domQuiet ? auditLayout(page) : second;
  const complete = animationsSettled && signals.documentComplete() && domQuiet;
  const stable = findStableLayoutFindings(domQuiet ? second : first, final);
  return {
    complete,
    viewportWidth: page.metrics().viewportWidth,
    // The result schema caps a pass at this many; the cap drops the tail of the list.
    findings: stable.slice(0, LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS),
  };
}
