/**
 * Shared XUM_* / MUX_* environment readers.
 *
 * Kept free of path aliases so Vite, Playwright, and sandbox scripts can import
 * it before packaged process-wide alias installation runs.
 */

const XUM_ENV_PREFIX = "XUM_";
const LEGACY_MUX_ENV_PREFIX = "MUX_";

export type XumEnvironment = Record<string, string | undefined>;

/** Like resolveXumEnvironmentValue, but also returns the name of the variable that supplied the value. */
export function resolveXumEnvironmentEntry(
  suffix: string,
  env: XumEnvironment
): { name: string; value: string } | undefined {
  const canonicalName = XUM_ENV_PREFIX + suffix;
  const canonical = env[canonicalName];
  if (canonical !== undefined) return { name: canonicalName, value: canonical };

  const legacyName = LEGACY_MUX_ENV_PREFIX + suffix;
  const legacy = env[legacyName];
  return legacy === undefined ? undefined : { name: legacyName, value: legacy };
}

/** Resolve a canonical XUM_* variable, falling back to its legacy MUX_* alias. */
export function resolveXumEnvironmentValue(
  suffix: string,
  env: XumEnvironment
): string | undefined {
  return resolveXumEnvironmentEntry(suffix, env)?.value;
}

/** Write both the canonical XUM_* name and the legacy MUX_* alias. */
export function assignXumEnvironmentValue(
  env: XumEnvironment,
  suffix: string,
  value: string
): void {
  env[XUM_ENV_PREFIX + suffix] = value;
  env[LEGACY_MUX_ENV_PREFIX + suffix] = value;
}
