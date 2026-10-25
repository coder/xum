/**
 * Text colors for added/removed markers: the review diff's +/- gutter signs (#5985) and the
 * file-edit tool header's "+N"/"-N" counts (#6010). Mixing 40% of the text color into
 * success/danger makes them darker in light themes and lighter in dark ones, which reaches WCAG AA
 * (4.5:1) on the diff line tints, under the review-range highlight and on the chat background in
 * all four themes; 35% left light "+" at 4.26:1 under the highlight. One home, so a retune keeps
 * both surfaces in step.
 */
export const DIFF_ADDED_TEXT_COLOR =
  "color-mix(in srgb, var(--color-success), var(--color-text) 40%)";
export const DIFF_REMOVED_TEXT_COLOR =
  "color-mix(in srgb, var(--color-danger), var(--color-text) 40%)";
