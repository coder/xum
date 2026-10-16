/**
 * The phone skeleton of the workspace page for the static first view (T3 #5971, C step 4): the
 * live page around the transcript rows, with slots for workspace data. A trusted build-time
 * capture (scripts/perf/generatePhoneChrome.ts): user data never lands in it, only slots. Nothing
 * loads it yet; a later PR's early script builds it with createElement and text nodes only.
 */

/** Page slots: the workspace title, the project name and the transcript rows. */
export const CHROME_SLOTS = ["title", "project", "rows"] as const;
/** Row template slots: the row tree (renderRowTree), its timestamp and its model label. */
export const ROW_SLOTS = ["md", "ts", "model"] as const;
export type SkeletonSlot = (typeof CHROME_SLOTS)[number] | (typeof ROW_SLOTS)[number];

/** A text node, a slot, or `[tag, attributes, ...children]`. */
export type SkeletonNode =
  | string
  | { slot: SkeletonSlot }
  | [tag: string, attributes: Record<string, string>, ...SkeletonNode[]];

export interface PhoneChrome {
  chrome: SkeletonNode;
  user: SkeletonNode;
  assistant: SkeletonNode;
}

/**
 * The live app picks its phone layout in JavaScript: a coarse pointer and at most 480 px
 * (PHONE_HEADER_QUERY, WorkspaceMenuBar.tsx). Captured at 412 px; the generator fails unless every
 * `checked` width gives the same tree. So the view must stay in `min`..`max`, coarse pointer only.
 */
export const PHONE_CHROME_WIDTHS = { min: 360, max: 480, checked: [360, 390, 412, 480] } as const;
