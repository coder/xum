import { z } from "zod";
import { isExactVersion } from "./installLayout";

/**
 * A package's npm-shrinkwrap.json: lockfile `packages` keyed by folder path, with the package
 * itself at "". The published @coder/xum ships one projected from bun.lock, so it pins every
 * production dependency to the version and digest that the release's CI tested.
 */
export const shrinkwrapSchema = z.object({
  packages: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export type Shrinkwrap = z.infer<typeof shrinkwrapSchema>;

/** The package a lockfile key's folder holds, for a package installed under its own name. */
export function installedName(key: string): string {
  return key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
}

/**
 * Lockfile `packages` that install `name` from `resolved` at node_modules/<name>, with its
 * shrinkwrap's tree nested under it: the layout npm gives a published package that ships a
 * shrinkwrap. npm ignores the shrinkwrap of a tarball file, so a lockfile has to carry it.
 */
export function nestShrinkwrap(
  shrinkwrap: Shrinkwrap,
  name: string,
  resolved: string
): Record<string, Record<string, unknown>> {
  const at = `node_modules/${name}`;
  const packages: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(shrinkwrap.packages)) {
    // A lockfile entry names its package only when it is an alias.
    packages[key === "" ? at : `${at}/${key}`] =
      key === "" ? { ...entry, name: undefined, resolved } : entry;
  }
  return packages;
}

/**
 * The digests the shrinkwrap pins, keyed by `name@version`. A shrinkwrap that npm generated at
 * publish time, as releases did before the projection from bun.lock, records most packages by
 * version alone; a staged digest could not be traced to the tested release, so it is refused.
 */
export function pinnedDigests(shrinkwrap: Shrinkwrap): Map<string, string[]> {
  const pins = new Map<string, string[]>();
  for (const [key, { version, integrity }] of Object.entries(shrinkwrap.packages)) {
    if (key === "") continue;
    const name = installedName(key);
    if (!isExactVersion(version) || typeof integrity !== "string")
      throw new Error(
        `The release's npm-shrinkwrap.json does not pin ${name} by version and digest`
      );
    pins.set(`${name}@${version}`, integrity.trim().split(/\s+/));
  }
  return pins;
}
