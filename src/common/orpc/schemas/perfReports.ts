/**
 * "Report slowness" oRPC schemas (experiment `perfFlightRecorder`, F4). One call writes
 * a local, private bundle directory and returns where it is. Nothing is uploaded.
 */

import { z } from "zod";

export const perfReports = {
  create: {
    input: z.void(),
    output: z.object({
      /** Absolute path of the bundle directory. */
      dir: z.string(),
      /** True when the desktop app revealed the bundle in the file manager. */
      revealed: z.boolean(),
      includedCaptures: z.number().int().nonnegative(),
      skippedCaptures: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    }),
  },
};
