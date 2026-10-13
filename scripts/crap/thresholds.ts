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

/**
 * Relief applies only to a strict decrease. A pure move raises the total by 1
 * per new function (each function has a base CC of 1), so moves need
 * moveRelief instead.
 */
export function netExtractionRelief(baseTotalCc: number, headTotalCc: number): boolean {
  return headTotalCc < baseTotalCc;
}

/**
 * Move relief caps a moved step at this CC. It stops a PR from moving a whole
 * hotspot body into a new function, which would reset its history. Natural
 * lifecycle steps in the hotspots measure CC 10-20.
 */
export const MOVE_RELIEF_MAX_CC = 20;

/**
 * Move relief: moving a coherent step out of a hotspot is a refactor, not new
 * code, even though it raises the total CC by 1. It applies when the CC that
 * kept functions lost pays for every decision point of every new function
 * (keptDrop >= sum of (CC - 1) over new functions) and this new function is at
 * most MOVE_RELIEF_MAX_CC. A rename alone gets nothing, because no kept
 * function shrinks. Like net-extraction relief, this is aggregate: it cannot
 * tell a move from an unrelated cut plus new code. It accepts a cut smaller
 * than net-extraction relief needs, by the number of new functions plus 1.
 * The finding stays a warning in the report, not a silent pass.
 */
export function moveRelief(keptDrop: number, newDecisions: number, newCc: number): boolean {
  return keptDrop >= newDecisions && newCc <= MOVE_RELIEF_MAX_CC;
}
