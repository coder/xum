// Every CRAP gate threshold lives here so a policy change is one reviewed diff.
// CRAP = CC^2 * (1 - coverage)^3 + CC (scripts/crap/crapper_report.py).

export type Severity = "violation" | "warning";

/** A new function must stay at or below this: CC without coverage data, CRAP with it. */
export const NEW_FUNCTION_MAX_SCORE = 8;

/**
 * CRAP tax stage: a touched function whose base score is above this must end
 * lower than its base score. Later waves lower the stage as hotspots shrink.
 */
export const CRAP_TAX_STAGE = 30;

/**
 * Severity of a CRAP tax finding when the base or head snapshot has no
 * coverage for the function, so the tax compares CC instead of CRAP. A warning
 * lets a comment or one-line fix in a legacy hotspot through, with a nudge.
 */
export const TAX_WITHOUT_COVERAGE: Severity = "warning";

/**
 * Net-extraction relief: refactors split a CC 140 function into new pieces,
 * and one piece can still be above NEW_FUNCTION_MAX_SCORE. When the changed
 * files' total CC drops, new-function findings get this severity instead of a
 * violation. The floor and the CRAP tax are unchanged.
 */
export const NEW_FUNCTION_ON_NET_DECREASE: Severity = "warning";

/** Relief applies only to a strict decrease: an equal total is a pure move or a split. */
export function netExtractionRelief(baseTotalCc: number, headTotalCc: number): boolean {
  return headTotalCc < baseTotalCc;
}
