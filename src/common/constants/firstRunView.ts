/**
 * The static first-run view (T3 #5971, Option C step 2): `xum server` paints a static copy of the
 * onboarding wizard's gateway step in this element before the app JS runs, and the app removes it
 * once the live wizard shows the same step. scripts/perf/pageTimingProbe.ts uses the same id.
 */
export const FIRST_RUN_VIEW_ID = "xum-pre";
