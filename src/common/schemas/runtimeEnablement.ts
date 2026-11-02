import { z } from "zod";

// Canonical schema for runtime enablement overrides. Sparse by design:
// only disabled runtimes are stored as `false` to keep config.json minimal.
// Uses z.string() keys (not enum) so configs from newer builds with additional
// runtime IDs survive upgrade→downgrade cycles without blocking unrelated edits.
// The runtime normalizer in config.ts filters to known IDs at load time.
export const RuntimeEnablementOverridesSchema = z.record(z.string(), z.literal(false));
