/**
 * Session tape command schemas (experiment `sessionTapes`). Only counts and the folder path
 * cross the API: tapes hold the full chat, so no tape content is ever returned.
 */

import { z } from "zod";

export const sessionTapes = {
  saveOpen: {
    input: z.void(),
    /** `written`: tapes this call finalized and wrote. `dir` is absolute. */
    output: z.object({ written: z.number().int().nonnegative(), dir: z.string() }),
  },
  revealFolder: {
    input: z.void(),
    /** `revealed` is false when this backend cannot open folders (e.g. `xum server`). */
    output: z.object({ dir: z.string(), revealed: z.boolean() }),
  },
};
