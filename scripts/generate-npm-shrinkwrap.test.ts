/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { describe, expect, test } from "bun:test";
import {
  buildShrinkwrap,
  type FetchVersion,
  type RegistryVersion,
} from "./generate-npm-shrinkwrap";

const digest = (spec: string) => `sha512-${spec}`;

/** A bun.lock whose entries are default-registry releases, keyed by folder path. */
function bunLock(entries: Record<string, string>, extra: Record<string, unknown[]> = {}) {
  const packages: Record<string, unknown[]> = { ...extra };
  for (const [key, spec] of Object.entries(entries)) packages[key] = [spec, "", {}, digest(spec)];
  return JSON.stringify({ lockfileVersion: 1, workspaces: {}, packages });
}

/** A registry that serves the given manifests with bun.lock's digests. */
function registry(manifests: Record<string, RegistryVersion>): FetchVersion {
  return (name, version) => {
    const manifest = manifests[`${name}@${version}`] ?? {};
    return Promise.resolve({ dist: { integrity: digest(`${name}@${version}`) }, ...manifest });
  };
}

const pkg = (
  dependencies: Record<string, string>,
  optionalDependencies?: Record<string, string>
) => ({
  name: "@coder/xum",
  version: "1.0.0",
  dependencies,
  optionalDependencies,
});

interface FailureCase {
  problem: string;
  lock: string;
  manifests: Record<string, RegistryVersion>;
  error: string;
}

describe("buildShrinkwrap", () => {
  test("publishes the production tree at bun.lock's paths", async () => {
    const lock = bunLock({
      a: "a@1.2.0",
      b: "b@1.0.0",
      "a/b": "b@2.0.0",
      peer: "peer@1.0.0",
      "optional-peer": "optional-peer@1.0.0",
      native: "native@1.0.0",
      "native-dep": "native-dep@1.0.0",
      alias: "real@1.1.0",
      "@scope/pkg": "@scope/pkg@3.0.0",
      "dev-only": "dev-only@1.0.0",
    });
    const { shrinkwrap, peerMismatches } = await buildShrinkwrap(
      lock,
      pkg(
        { a: "^1.0.0", b: "^1.0.0", alias: "npm:real@^1.0.0", "@scope/pkg": "3.0.0" },
        { native: "^1.0.0" }
      ),
      registry({
        "a@1.2.0": {
          dependencies: { b: "^2.0.0" },
          peerDependencies: { peer: "^1.0.0", "optional-peer": "^1.0.0" },
          peerDependenciesMeta: { "optional-peer": { optional: true } },
        },
        "native@1.0.0": {
          dependencies: { "native-dep": "^1.0.0" },
          hasInstallScript: true,
          os: ["linux"],
          cpu: ["x64"],
        },
      })
    );

    expect(peerMismatches).toEqual([]);
    expect(Object.keys(shrinkwrap.packages)).toEqual([
      "",
      "node_modules/@scope/pkg",
      "node_modules/a",
      "node_modules/a/node_modules/b",
      "node_modules/alias",
      "node_modules/b",
      "node_modules/native",
      "node_modules/native-dep",
      "node_modules/peer",
    ]);
    expect(shrinkwrap.packages["node_modules/a/node_modules/b"]).toMatchObject({
      version: "2.0.0",
    });
    expect(shrinkwrap.packages["node_modules/@scope/pkg"]).toMatchObject({
      resolved: "https://registry.npmjs.org/@scope/pkg/-/pkg-3.0.0.tgz",
      integrity: digest("@scope/pkg@3.0.0"),
    });
    expect(shrinkwrap.packages["node_modules/alias"]).toMatchObject({
      name: "real",
      resolved: "https://registry.npmjs.org/real/-/real-1.1.0.tgz",
    });
    // An optional dependency's subtree is optional, so npm skips it on other platforms, and npm
    // runs install scripts only for entries that declare them.
    expect(shrinkwrap.packages["node_modules/native"]).toMatchObject({
      optional: true,
      hasInstallScript: true,
      os: ["linux"],
      cpu: ["x64"],
    });
    expect(shrinkwrap.packages["node_modules/native-dep"]).toMatchObject({ optional: true });
    expect(shrinkwrap.packages["node_modules/peer"].optional).toBeUndefined();
  });

  test.each<FailureCase>([
    {
      problem: "a dependency bun.lock does not have",
      lock: bunLock({ a: "a@1.0.0" }),
      manifests: { "a@1.0.0": { dependencies: { missing: "^1.0.0" } } },
      error: "bun.lock has no missing for a",
    },
    {
      problem: "a dependency out of the manifest's range",
      lock: bunLock({ a: "a@1.0.0", b: "b@9.5.0" }),
      manifests: { "a@1.0.0": { dependencies: { b: "^14.0.0" } } },
      error: "a needs b@^14.0.0, but bun.lock has 9.5.0 at b",
    },
    {
      problem: "a version whose registry digest is not bun.lock's",
      lock: bunLock({ a: "a@1.0.0" }),
      manifests: { "a@1.0.0": { dist: { integrity: "sha512-other" } } },
      error: "the registry's digest of a@1.0.0 is not bun.lock's",
    },
    {
      problem: "a package bun.lock did not take from the registry",
      lock: bunLock({}, { a: ["a@github:owner/a#abc123", {}, "owner-a-abc123"] }),
      manifests: {},
      error: "a is not a registry release in bun.lock",
    },
  ])("fails on $problem", async ({ lock, manifests, error }) => {
    await expect(buildShrinkwrap(lock, pkg({ a: "*" }), registry(manifests))).rejects.toThrow(
      error
    );
  });

  test("only warns about a peer out of range, which bun installs the same way", async () => {
    const { shrinkwrap, peerMismatches } = await buildShrinkwrap(
      bunLock({ a: "a@1.0.0", ai: "ai@7.0.0" }),
      pkg({ a: "^1.0.0", ai: "^7.0.0" }),
      registry({ "a@1.0.0": { peerDependencies: { ai: "^5.0.0" } } })
    );
    expect(peerMismatches).toEqual(["a needs ai@^5.0.0, but bun.lock has 7.0.0 at ai"]);
    expect(shrinkwrap.packages["node_modules/ai"]).toMatchObject({ version: "7.0.0" });
  });
});
