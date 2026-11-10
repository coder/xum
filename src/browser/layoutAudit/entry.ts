// Adapted from lavish-axi (MIT). See lavish-axi-LICENSE.txt in this folder.
import type { LayoutAuditPagePass } from "@/common/types/artifactLayoutAudit";
import {
  createBrowserLayoutPage,
  createBrowserSettleSignals,
  type BrowserWindow,
} from "./browserPage";
import { runLayoutAudit } from "./settle";

/**
 * Audits `win`'s page. A crash resolves to an incomplete pass with no findings, never a
 * rejection and never an empty complete pass: an empty complete pass reads as "clean", and a
 * crashed audit has not seen the page.
 */
export async function auditWindow(win: BrowserWindow): Promise<LayoutAuditPagePass> {
  try {
    return await runLayoutAudit(createBrowserLayoutPage(win), createBrowserSettleSignals(win));
  } catch {
    return { complete: false, viewportWidth: win.innerWidth || 0, findings: [] };
  }
}

/**
 * The bundle's only export (scripts/gen_layout_audit_script.ts evaluates `run()` as the page
 * script's value, a promise of the pass).
 */
export function run(): Promise<LayoutAuditPagePass> {
  return auditWindow(window);
}
