#!/usr/bin/env bun
/**
 * Writes npm-shrinkwrap.json for the published @coder/xum package from bun.lock.
 *
 * npm installs a published package's shrinkwrap verbatim, so this file decides what every
 * `npm install -g @coder/xum` and `npx @coder/xum` gets. It used to come from a fresh
 * `npm install --package-lock-only` at publish time, which pins whatever the registry serves
 * that minute, so a release compromised an hour earlier would have shipped to every user (a
 * compromised litellm reached CI that way, #7227). Projecting bun.lock publishes the versions and
 * digests that a PR reviewed and CI tested.
 *
 * Contents: the production subtree (the root's dependencies and optionalDependencies, their
 * dependencies and required peers) at the paths where bun.lock placed it. The registry supplies
 * only the per-version manifest fields that bun.lock does not keep (install scripts and platform
 * fields), and its digest for each version must equal bun.lock's. Generation fails when bun.lock
 * leaves an edge of that subtree missing or out of range, because npm would then resolve that
 * edge from the registry at install time.
 *
 * Usage:
 *   bun scripts/generate-npm-shrinkwrap.ts
 *       writes ./npm-shrinkwrap.json
 *   bun scripts/generate-npm-shrinkwrap.ts --tarball-install <dir> <tarball> [<wrapper tarball>]
 *       writes <dir>/package.json and <dir>/package-lock.json, with which `npm ci` installs the
 *       packed tarball (or a wrapper package that depends on it) the way npm installs the
 *       published package (see tarballInstallFiles)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as jsonc from "jsonc-parser";
import semver from "semver";
import { NPM_PUBLIC_REGISTRY } from "../src/constants/serverUpdate";
import { nestShrinkwrap } from "../src/node/services/serverUpdate/shrinkwrap";

const REGISTRY = NPM_PUBLIC_REGISTRY;
const FETCH_CONCURRENCY = 16;
const FETCH_ATTEMPTS = 4;

type DepMap = Record<string, string>;

/** The fields npm reads from a registry version manifest (its abbreviated "corgi" form). */
export interface RegistryVersion {
  dependencies?: DepMap;
  optionalDependencies?: DepMap;
  peerDependencies?: DepMap;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  hasInstallScript?: boolean;
  dist?: { integrity?: string };
}

/** Returns the registry's manifest of one exact version. */
export type FetchVersion = (name: string, version: string) => Promise<RegistryVersion>;

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: DepMap;
  optionalDependencies?: DepMap;
}

/** One bun.lock entry; `version` is empty for anything but a default-registry release. */
interface LockedPackage {
  /** The registry name, which differs from the folder name only for an `npm:` alias. */
  name: string;
  version: string;
  integrity: string;
}

type EdgeKind = "dependency" | "optional" | "peer" | "optionalPeer";

interface Edge {
  name: string;
  range: string;
  kind: EdgeKind;
}

export interface Shrinkwrap {
  name: string;
  version: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, Record<string, unknown>>;
}

/** bun.lock keys name a folder path: `a/@s/b` is node_modules/a/node_modules/@s/b. */
function keySegments(key: string): string[] {
  if (key === "") return [];
  const parts = key.split("/");
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    segments.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]);
  }
  return segments;
}

const npmPath = (key: string) =>
  keySegments(key)
    .map((segment) => `node_modules/${segment}`)
    .join("/");

export function parseBunLock(text: string): Map<string, LockedPackage> {
  const errors: jsonc.ParseError[] = [];
  const lock = jsonc.parse(text, errors, { allowTrailingComma: true }) as {
    packages?: Record<string, unknown[]>;
  } | null;
  if (errors.length > 0 || lock?.packages == null) throw new Error("bun.lock is not readable");
  const packages = new Map<string, LockedPackage>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const [spec, registry, meta, integrity] = entry;
    // A default-registry release is [spec, "", meta, digest]. Other kinds (git, tarball URL,
    // workspace, another registry, a dependency bundled in its parent's tarball) stay unreadable
    // here, and only fail generation if the published tree needs them.
    let locked: LockedPackage = { name: "", version: "", integrity: "" };
    if (
      entry.length === 4 &&
      registry === "" &&
      typeof spec === "string" &&
      typeof integrity === "string" &&
      (meta as { bundled?: boolean } | null)?.bundled !== true
    ) {
      const at = spec.lastIndexOf("@");
      if (at > 0) locked = { name: spec.slice(0, at), version: spec.slice(at + 1), integrity };
    }
    packages.set(key, locked);
  }
  return packages;
}

/** Node's lookup: the nearest node_modules folder, from the dependent's own outward. */
function resolveKey(
  tree: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  from: string,
  name: string
) {
  const segments = keySegments(from);
  for (let depth = segments.length; depth >= 0; depth--) {
    const key = [...segments.slice(0, depth), name].join("/");
    if (tree.has(key)) return key;
  }
  return undefined;
}

/** npm's validity check of one edge (arborist's dep-valid): a semver range or an `npm:` alias. */
function satisfies(locked: LockedPackage, range: string): boolean {
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/.exec(range);
  if (alias != null) return locked.name === alias[1] && satisfies(locked, alias[2] ?? "*");
  return semver.validRange(range, true) != null && semver.satisfies(locked.version, range, true);
}

function edgesOf(manifest: RegistryVersion): Edge[] {
  const optional = manifest.optionalDependencies ?? {};
  const edges: Edge[] = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    // npm drops the regular edge when a name is also an optional dependency.
    if (!(name in optional)) edges.push({ name, range, kind: "dependency" });
  }
  for (const [name, range] of Object.entries(optional))
    edges.push({ name, range, kind: "optional" });
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const optionalPeer = manifest.peerDependenciesMeta?.[name]?.optional === true;
    edges.push({ name, range, kind: optionalPeer ? "optionalPeer" : "peer" });
  }
  return edges;
}

/**
 * Builds the shrinkwrap of `pkg` from bun.lock. `fetchVersion` supplies each version's registry
 * manifest, whose digest must equal bun.lock's.
 */
export async function buildShrinkwrap(
  lockText: string,
  pkg: PackageJson,
  fetchVersion: FetchVersion
): Promise<{ shrinkwrap: Shrinkwrap; peerMismatches: string[] }> {
  const locked = parseBunLock(lockText);
  const problems = new Set<string>();
  const manifests = new Map<string, Promise<RegistryVersion | undefined>>();
  const manifestOf = (key: string) => {
    let manifest = manifests.get(key);
    if (manifest == null) {
      const entry = locked.get(key)!;
      manifest =
        entry.version === ""
          ? Promise.resolve(void problems.add(`${key} is not a registry release in bun.lock`))
          : fetchVersion(entry.name, entry.version).then((found) => {
              if (found.dist?.integrity !== entry.integrity)
                problems.add(
                  `the registry's digest of ${entry.name}@${entry.version} is not bun.lock's`
                );
              return found;
            });
      manifests.set(key, manifest);
    }
    return manifest;
  };
  const rootEdges = edgesOf({
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
  });
  const edgesFrom = async (key: string) =>
    key === "" ? rootEdges : edgesOf((await manifestOf(key)) ?? {});

  // Everything reachable from the root along the given edge kinds. Optional peers are never
  // followed: npm installs one only when something else needs it.
  const reach = async (follow: ReadonlySet<EdgeKind>) => {
    const seen = new Set<string>();
    let frontier = [""];
    while (frontier.length > 0) {
      const next: string[] = [];
      const edgeLists = await Promise.all(frontier.map(edgesFrom));
      frontier.forEach((from, i) => {
        for (const edge of edgeLists[i]) {
          const target = follow.has(edge.kind) ? resolveKey(locked, from, edge.name) : undefined;
          if (target != null && !seen.has(target)) {
            seen.add(target);
            next.push(target);
          }
        }
      });
      frontier = next;
    }
    return seen;
  };
  const required = await reach(new Set(["dependency", "peer"]));
  const tree = await reach(new Set(["dependency", "peer", "optional"]));

  // Resolve every edge again within the published tree, as npm will. A missing edge is one npm
  // fills from the registry. An out-of-range package is kept (npm takes a shrinkwrapped package
  // as its lockfile entry says), but for a regular dependency it means bun.lock is not what the
  // manifest asks for (bun once kept commander@9.5.0 for the root's ^14.0.2), so it fails too.
  // Upstream peer ranges often lag behind (ai-tokenizer still names ai@^5), and bun installs the
  // same tree, so a peer out of range only warns.
  const peerMismatches: string[] = [];
  for (const key of ["", ...tree]) {
    for (const edge of await edgesFrom(key)) {
      const owner = key === "" ? pkg.name : key;
      const target = resolveKey(tree, key, edge.name);
      if (target == null) {
        if (edge.kind !== "optionalPeer") problems.add(`bun.lock has no ${edge.name} for ${owner}`);
        continue;
      }
      const { version } = locked.get(target)!;
      if (satisfies(locked.get(target)!, edge.range)) continue;
      const mismatch = `${owner} needs ${edge.name}@${edge.range}, but bun.lock has ${version} at ${target}`;
      if (edge.kind === "peer" || edge.kind === "optionalPeer") peerMismatches.push(mismatch);
      else problems.add(mismatch);
    }
  }
  if (problems.size > 0) {
    throw new Error(
      `bun.lock cannot be published as npm-shrinkwrap.json:\n  ${[...problems].join("\n  ")}`
    );
  }

  const packages: Record<string, Record<string, unknown>> = {
    "": {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      dependencies: pkg.dependencies,
      optionalDependencies: pkg.optionalDependencies,
      bin: pkg.bin,
      engines: pkg.engines,
    },
  };
  for (const key of [...tree].sort((a, b) => npmPath(a).localeCompare(npmPath(b)))) {
    const { name, version, integrity } = locked.get(key)!;
    const manifest = (await manifestOf(key))!;
    const folder = keySegments(key).at(-1);
    packages[npmPath(key)] = {
      name: name === folder ? undefined : name,
      version,
      resolved: `${REGISTRY}/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`,
      integrity,
      optional: required.has(key) ? undefined : true,
      // npm runs a dependency's install scripts only when its lockfile entry says it has some.
      hasInstallScript: manifest.hasInstallScript === true ? true : undefined,
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
      peerDependencies: manifest.peerDependencies,
      peerDependenciesMeta: manifest.peerDependenciesMeta,
      bin: manifest.bin,
      engines: manifest.engines,
      os: manifest.os,
      cpu: manifest.cpu,
    };
  }
  return {
    shrinkwrap: {
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
    peerMismatches,
  };
}

type Packument = { versions?: Record<string, RegistryVersion> };

/** Reads abbreviated packuments over HTTPS: one request per name, a bounded number at a time. */
export function registryFetcher(registry = REGISTRY): FetchVersion {
  const documents = new Map<string, Promise<Packument>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  const fetchDocument = async (name: string): Promise<Packument> => {
    if (active >= FETCH_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      const url = `${registry}/${name.replace("/", "%2f")}`;
      for (let attempt = 1; ; attempt++) {
        let failure: string;
        try {
          const response = await fetch(url, {
            headers: { accept: "application/vnd.npm.install-v1+json" },
            redirect: "error",
          });
          if (response.ok) return (await response.json()) as Packument;
          failure = `HTTP ${response.status}`;
          // Only rate limits and server errors are worth another attempt.
          if (response.status !== 429 && response.status < 500) attempt = FETCH_ATTEMPTS;
        } catch (error) {
          failure = String(error);
        }
        if (attempt >= FETCH_ATTEMPTS) throw new Error(`fetching ${url} failed: ${failure}`);
        console.warn(`fetching ${url} failed (${failure}); retrying`);
        await Bun.sleep(attempt * 2000);
      }
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  return async (name, version) => {
    let document = documents.get(name);
    if (document == null) {
      document = fetchDocument(name);
      documents.set(name, document);
    }
    const manifest = (await document).versions?.[version];
    if (manifest == null) throw new Error(`the registry has no ${name}@${version}`);
    return manifest;
  };
}

/** A packed package: its tarball path and the package.json inside. */
export interface Tarball {
  path: string;
  manifest: PackageJson;
}

/**
 * The package.json and package-lock.json with which `npm ci` installs a packed package the way
 * npm installs the published one from the registry: the package at node_modules/<name>, and its
 * shrinkwrap's tree nested under it. npm ignores the shrinkwrap of a tarball file, so a plain
 * `npm install <tarball>` resolves every dependency afresh. `wrapper` is a package that depends
 * on this one through a `file:` spec (the legacy mux forwarder), installed in its place.
 */
export function tarballInstallFiles(
  pkg: Tarball,
  shrinkwrap: Shrinkwrap,
  wrapper?: Tarball
): { packageJson: object; lockfile: object } {
  const top = wrapper ?? pkg;
  const dependencies = { [top.manifest.name]: `file:${top.path}` };
  const packages: Record<string, unknown> = {
    "": { name: "npm-tarball-install", dependencies },
  };
  if (wrapper != null) {
    packages[`node_modules/${wrapper.manifest.name}`] = {
      version: wrapper.manifest.version,
      resolved: `file:${wrapper.path}`,
      license: wrapper.manifest.license,
      dependencies: wrapper.manifest.dependencies,
      bin: wrapper.manifest.bin,
    };
  }
  Object.assign(
    packages,
    nestShrinkwrap(shrinkwrap, pkg.manifest.name, `file:${pkg.path}`, REGISTRY)
  );
  return {
    packageJson: { name: "npm-tarball-install", private: true, dependencies },
    lockfile: { name: "npm-tarball-install", lockfileVersion: 3, requires: true, packages },
  };
}

function readFromTarball(tarball: string, file: string): string {
  const tar = Bun.spawnSync(["tar", "-xzOf", tarball, `package/${file}`]);
  if (tar.exitCode !== 0) throw new Error(`reading ${file} from ${tarball} failed: ${tar.stderr}`);
  return tar.stdout.toString();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = path.join(import.meta.dir, "..");
  if (args[0] === "--tarball-install" && (args.length === 3 || args.length === 4)) {
    const [dir, ...paths] = args.slice(1).map((arg) => path.resolve(arg));
    const [packed, wrapper] = paths.map((tarball) => ({
      path: tarball,
      manifest: JSON.parse(readFromTarball(tarball, "package.json")) as PackageJson,
    }));
    const shrinkwrap = JSON.parse(
      readFromTarball(packed.path, "npm-shrinkwrap.json")
    ) as Shrinkwrap;
    const { packageJson, lockfile } = tarballInstallFiles(packed, shrinkwrap, wrapper);
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);
  } else if (args.length === 0) {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
    const lock = readFileSync(path.join(root, "bun.lock"), "utf8");
    const { shrinkwrap, peerMismatches } = await buildShrinkwrap(lock, pkg, registryFetcher());
    for (const mismatch of peerMismatches) console.warn(`warning: peer out of range: ${mismatch}`);
    writeFileSync(
      path.join(root, "npm-shrinkwrap.json"),
      `${JSON.stringify(shrinkwrap, null, 2)}\n`
    );
    const count = Object.keys(shrinkwrap.packages).length - 1;
    console.log(`Wrote npm-shrinkwrap.json: ${count} production packages from bun.lock`);
  } else {
    console.error(
      "usage: bun scripts/generate-npm-shrinkwrap.ts [--tarball-install <dir> <tarball> [<wrapper tarball>]]"
    );
    process.exit(2);
  }
}
