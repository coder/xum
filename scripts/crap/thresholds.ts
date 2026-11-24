// Every CRAP gate threshold lives here so a policy change is one reviewed diff.
// CRAP = CC^2 * (1 - coverage)^3 + CC (scripts/crap/crapper_report.py).

export type Severity = "violation" | "warning";

/**
 * A new function must stay at or below this CRAP when coverage scores it.
 * CRAP 15 lets a CC 15 function in with full tests, or a small one with few.
 */
export const NEW_FUNCTION_MAX_CRAP = 15;

/**
 * A new function must stay at or below this CC when no coverage scores it
 * (the commit hook, `make crap-check` without --coverage).
 */
export const NEW_FUNCTION_MAX_CC = 8;

/** The new-function limit for a row: CRAP with coverage data, CC without. */
export function newFunctionMax(crap: number | null): number {
  return crap === null ? NEW_FUNCTION_MAX_CC : NEW_FUNCTION_MAX_CRAP;
}

/**
 * CRAP tax stage: a touched function whose base score is above this gets a
 * warning unless it ends lower than its base score. It is also the floor's
 * growth line (floorAllowsGrowth). Later waves lower the stage as hotspots
 * shrink.
 */
export const CRAP_TAX_STAGE = 30;

/**
 * The floor's growth line when no coverage scores the head (CRAP unknown): an
 * existing function may grow while its head CC stays at or below this.
 */
export const GROWTH_MAX_CC_WITHOUT_COVERAGE = 10;

/**
 * Floor: an existing function may grow (CC or CRAP) while its head stays at or
 * below the line: CRAP_TAX_STAGE with coverage, GROWTH_MAX_CC_WITHOUT_COVERAGE
 * without. Above the line it must not grow. A reduction is always allowed.
 * This lets small functions change freely and still stops hotspots growing.
 */
export function floorAllowsGrowth(headCc: number, headCrap: number | null): boolean {
  return headCrap === null ? headCc <= GROWTH_MAX_CC_WITHOUT_COVERAGE : headCrap <= CRAP_TAX_STAGE;
}

/**
 * Severity of every CRAP tax finding, with or without coverage. A touched
 * hotspot that did not shrink only gets a nudge, so a comment or one-line fix
 * in a legacy hotspot goes through. Defusing hotspots is gradual: the floor
 * stops them growing, and any reduction passes.
 */
export const CRAP_TAX_SEVERITY: Severity = "warning";

/**
 * Net-extraction relief: refactors split a CC 140 function into new pieces,
 * and one piece can still be above the new-function limit. When the changed
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
 * Both reliefs also cap a new function's CRAP at this when coverage scores it:
 * above it the finding stays a violation. Without the cap an untested CC 20
 * piece (CRAP 420) only warned. It is the CRAP tax stage, so a relieved piece
 * never starts life as a hotspot, and it follows the stage down. With coverage
 * CRAP >= CC, so this also caps a net-extraction piece's CC. A CC-only score
 * (the hook, no --coverage) is not capped.
 */
export const RELIEF_MAX_CRAP = CRAP_TAX_STAGE;

/** True when relief may apply to a new function with this CRAP (null: no coverage data). */
export function reliefAllowsCrap(crap: number | null): boolean {
  return crap === null || crap <= RELIEF_MAX_CRAP;
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
