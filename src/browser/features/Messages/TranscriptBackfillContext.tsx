import { createContext } from "react";

/**
 * True while ChatPane's tail-first reveal is still mounting older rows during an active stream.
 *
 * Each reveal step is a heavy default-priority commit scheduled every couple of frames. They keep
 * preempting React transitions, and Streamdown's "streaming" mode publishes its parsed blocks only
 * from a transition (its first render has no blocks at all). A streaming row mounted during the
 * backfill, e.g. the in-flight reply after a mid-stream chat return, therefore painted as an empty
 * bubble until the last chunk landed, seconds on a large history (#4505 UAT). TypewriterMarkdown
 * renders streaming text synchronously while this is true.
 */
export const TranscriptBackfillContext = createContext(false);
