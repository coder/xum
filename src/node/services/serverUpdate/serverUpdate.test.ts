import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { RestartBlocker, UpdateStatus } from "@/common/orpc/types";
import { resolveInstallLayout, inferChannel, type InstallLayout } from "./installLayout";
import { activateUpdate } from "./activation";
import { installCommands, stageUpdate, verifyStagedPackage } from "./staging";
import { verifyStagedDependencies } from "./lockfile";
import {
  downloadArtifact,
  fetchArtifact,
  fetchDistTags,
  fetchNewestVersion,
  fetchPublishedDigests,
  type RegistryRequest,
  type ReleaseArtifact,
} from "./registry";
import { ServerUpdater, type ServerUpdaterDeps } from "./serverUpdater";
import { NPM_PUBLIC_REGISTRY, SERVER_UPDATE_STAGE_MARKER } from "@/constants/serverUpdate";
import { createHash } from "node:crypto";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function writePackage(
  workdir: string,
  version: string,
  script = "console.log('test version')"
) {
  const packageDir = path.join(workdir, "node_modules/@coder/xum");
  const entry = path.join(packageDir, "dist/cli/index.js");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@coder/xum", version })
  );
  await fs.writeFile(entry, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  const bin = path.join(workdir, "node_modules/.bin/mux");
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.symlink(entry, bin);
  return { entry, bin };
}

async function writeMuxShim(workdir: string): Promise<string> {
  const shimDir = path.join(workdir, "node_modules/mux");
  await fs.mkdir(path.join(shimDir, "bin"), { recursive: true });
  await fs.writeFile(path.join(shimDir, "package.json"), JSON.stringify({ name: "mux" }));
  const shim = path.join(shimDir, "bin/mux.js");
  await fs.writeFile(shim, 'require("@coder/xum/dist/cli/index.js");');
  return shim;
}

async function fixture(
  manager: InstallLayout["packageManager"] = "bun",
  version = "1.0.0-next.1",
  launcherTarget: "xum" | "shim" = "xum"
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "server-update-"));
  dirs.push(root);
  const workdir = path.join(root, "npm");
  const { bin: xumBin } = await writePackage(workdir, version);
  const bin = launcherTarget === "shim" ? await writeMuxShim(workdir) : xumBin;
  if (manager === "pnpm") {
    const packageDir = path.join(workdir, "node_modules/@coder/xum");
    const storeDir = path.join(workdir, "node_modules/.pnpm/xum/node_modules/@coder/xum");
    await fs.mkdir(path.dirname(storeDir), { recursive: true });
    await fs.rename(packageDir, storeDir);
    await fs.symlink(storeDir, packageDir);
  }
  const lockfiles = { bun: "bun.lock", npm: "package-lock.json", pnpm: "pnpm-lock.yaml" };
  await fs.writeFile(path.join(workdir, lockfiles[manager]), "");
  const launcher = path.join(root, "mux");
  await fs.symlink(bin, launcher);
  const env = { MUX_BINARY: launcher, RESTART_ON_KILL_VALUE: "true" };
  const argv = ["node", launcher];
  const result = resolveInstallLayout(env, argv);
  if (!result.supported) throw new Error(result.reason);
  return { root, env, argv, layout: result.layout };
}

const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sriOf = (text: string) => sri(new TextEncoder().encode(text));
/** A release's pins (`name@version` to its recorded digests) from `name@version` to sri. */
const pinsOf = (specs: Record<string, string>) =>
  new Map(Object.entries(specs).map(([spec, integrity]) => [spec, integrity.split(" ")]));
const splitSpec = (spec: string) => {
  const at = spec.lastIndexOf("@");
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
};

/** The npm-shrinkwrap.json a release publishes, pinning `deps` (`name@version` to sri). */
function shrinkwrapFor(version: string, deps: Record<string, string> = {}) {
  const pinned = Object.entries(deps).map(([spec, integrity]) => ({
    ...splitSpec(spec),
    integrity,
  }));
  return {
    name: "@coder/xum",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "@coder/xum",
        version,
        dependencies: Object.fromEntries(pinned.map((dep) => [dep.name, dep.version])),
      },
      ...Object.fromEntries(
        pinned.map((dep) => [
          `node_modules/${dep.name}`,
          {
            version: dep.version,
            resolved: `${NPM_PUBLIC_REGISTRY}/${dep.name}/-/${path.posix.basename(dep.name)}-${dep.version}.tgz`,
            integrity: dep.integrity,
          },
        ])
      ),
    },
  };
}

/** A release tarball as npm packs it; `shrinkwrap: null` leaves the shrinkwrap out. */
function releaseTarball(version: string, shrinkwrap: object | null = shrinkwrapFor(version)) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "server-update-release-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "package"));
  writeFileSync(
    path.join(dir, "package/package.json"),
    JSON.stringify({ name: "@coder/xum", version })
  );
  if (shrinkwrap)
    writeFileSync(path.join(dir, "package/npm-shrinkwrap.json"), JSON.stringify(shrinkwrap));
  execFileSync("tar", ["-czf", path.join(dir, "release.tgz"), "-C", dir, "package"]);
  return new Uint8Array(readFileSync(path.join(dir, "release.tgz")));
}

/**
 * Serves one release (version manifest and tarball) plus the manifests of the dependencies in
 * `deps` (`name@version` to sri), recording every request's options. The default tarball's
 * shrinkwrap pins `deps`.
 */
function fakeRegistry(
  version: string,
  tarballBytes?: Uint8Array<ArrayBuffer>,
  overrides: Partial<{ tarball: string; integrity: string; version: string }> = {},
  deps: Record<string, string> = {}
) {
  const bytes = tarballBytes ?? releaseTarball(version, shrinkwrapFor(version, deps));
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const tarball =
    overrides.tarball ?? `https://registry.example.com/@coder/xum/-/xum-${version}.tgz`;
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
  const request: RegistryRequest = (url, options) => {
    calls.push({ url, options });
    if (url === tarball) return Promise.resolve(new Response(bytes));
    for (const [spec, integrity] of Object.entries(deps)) {
      const { name, version } = splitSpec(spec);
      if (url.endsWith(`/${name.replace("/", "%2F")}/${version}`))
        return json({
          name,
          version,
          dist: { tarball: `https://registry.example.com/${name}/-/${version}.tgz`, integrity },
        });
    }
    return json({
      name: "@coder/xum",
      version: overrides.version ?? version,
      dist: { tarball, integrity: overrides.integrity ?? sri(bytes) },
    });
  };
  return { request, calls, bytes, tarball };
}

/** A bun.lock as bun 1.2 writes it: the local release tarball plus registry releases. */
function bunLock(tarball: string, packages: Record<string, string | null> = {}, extra = "") {
  const entries = Object.entries(packages).map(([spec, integrity]) =>
    integrity === null
      ? `    "${splitSpec(spec).name}": ["${spec}", {}],`
      : `    "${splitSpec(spec).name}": ["${spec}", "", {}, "${integrity}"],`
  );
  return [
    "{",
    '  "lockfileVersion": 1,',
    `  "workspaces": { "": { "dependencies": { "@coder/xum": "${tarball}" } } },`,
    '  "packages": {',
    `    "@coder/xum": ["@coder/xum@${tarball}", { "dependencies": {} }],`,
    ...entries,
    extra,
    "  },",
    "}",
    "",
  ].join("\n");
}

/**
 * Stands in for bun: the lockfile migration writes the bun.lock for the staged release, and the
 * install writes the package but no lockfile, as a frozen install of bun 1.4.4 does.
 */
const fakeInstall =
  (version: string, packages: Record<string, string | null> = {}) =>
  async (_file: string, args: string[], cwd: string) => {
    if (args[0] === "pm")
      await fs.writeFile(
        path.join(cwd, "bun.lock"),
        bunLock(path.join(cwd, `xum-${version}.tgz`), packages)
      );
    else await writePackage(cwd, version);
  };

/** The stage directory a staged CLI entry lives in. */
const stageOf = (entry: string) => entry.slice(0, entry.indexOf("/node_modules/"));

/** Names of every directory staged for `version` under `parent`, including foreign ones. */
const stagesIn = async (parent: string, version: string) =>
  (await fs.readdir(parent)).filter((name) => name.startsWith(`xum-staging-${version}`)).sort();

async function expectFailure(run: () => Promise<unknown>) {
  let failed = false;
  try {
    await run();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

describe("server install layout", () => {
  for (const manager of ["bun", "npm", "pnpm"] as const) {
    test("recognizes " + manager + " and infers the release channel", async () => {
      const { layout } = await fixture(manager);
      expect(layout.packageManager).toBe(manager);
      expect(layout.version).toBe("1.0.0-next.1");
      expect(inferChannel(layout.version)).toBe("nightly");
      expect(inferChannel("1.0.0")).toBe("stable");
    });
  }
  test("follows the published mux shim to the xum entry it forwards to", async () => {
    const { layout, root } = await fixture("bun", "1.0.0-next.1", "shim");
    expect(layout.entry).toBe(path.join(root, "npm/node_modules/@coder/xum/dist/cli/index.js"));
    expect(layout.version).toBe("1.0.0-next.1");
    const bin = await stageUpdate(layout, "2.0.0", {
      ...fakeRegistry("2.0.0"),
      install: fakeInstall("2.0.0"),
    });
    activateUpdate(layout, bin);
    expect(await fs.readlink(layout.launcher)).toBe(bin);
  });
  test("requires supervisor, a symlink, and a matching running entry", async () => {
    const { env, argv, layout, root } = await fixture();
    expect(resolveInstallLayout({ MUX_BINARY: env.MUX_BINARY }, argv).supported).toBe(false);
    expect(resolveInstallLayout(env, argv, "win32").supported).toBe(false);
    expect(resolveInstallLayout(env, argv, "linux").supported).toBe(true);
    expect(
      resolveInstallLayout({ RESTART_ON_KILL_VALUE: "true" }, ["node", layout.entry]).supported
    ).toBe(false);
    expect(
      resolveInstallLayout({ XUM_SERVER_SUPERVISED: "1" }, ["node", layout.launcher]).supported
    ).toBe(true);
    // A declared launcher does not excuse starting the entry file directly, and it must be the
    // symlink the process was started through (the one the supervisor relaunches).
    expect(resolveInstallLayout(env, ["node", layout.entry]).supported).toBe(false);
    const twin = path.join(root, "twin-mux");
    await fs.symlink(await fs.readlink(layout.launcher), twin);
    expect(resolveInstallLayout(env, ["node", twin]).supported).toBe(false);
    expect(resolveInstallLayout({ RESTART_ON_KILL_VALUE: "true" }, ["node", twin]).supported).toBe(
      true
    );
  });
  test("honors canonical environment values and registry precedence", async () => {
    const { env, argv, layout } = await fixture();
    const result = resolveInstallLayout(
      {
        ...env,
        XUM_BINARY: layout.launcher,
        MUX_BINARY: "/missing",
        XUM_UPDATE_REGISTRY_URL: "https://registry.example.com/",
        npm_config_registry: "https://ignored.invalid",
      },
      argv
    );
    expect(result.supported && result.layout.registry).toBe("https://registry.example.com");
    for (const [registry, supported] of [
      ["http://registry.example.com", false],
      ["http://127.0.0.1:4873", false],
      ["https://registry.example.com:8443/npm", true],
      ["https://user:secret@registry.example.com", false],
    ] as const) {
      expect(
        resolveInstallLayout({ ...env, XUM_UPDATE_REGISTRY_URL: registry }, argv).supported
      ).toBe(supported);
    }
  });
  test("fails closed for missing or conflicting lockfiles and malformed package metadata", async () => {
    const { env, argv, layout } = await fixture();
    await fs.writeFile(path.join(layout.workdir, "package-lock.json"), "{}");
    expect(resolveInstallLayout(env, argv).supported).toBe(false);
    await fs.unlink(path.join(layout.workdir, "package-lock.json"));
    await fs.unlink(path.join(layout.workdir, "bun.lock"));
    expect(resolveInstallLayout(env, argv).supported).toBe(false);
    // The legacy binary lockfile cannot be verified after staging.
    await fs.writeFile(path.join(layout.workdir, "bun.lockb"), "");
    expect(resolveInstallLayout(env, argv).supported).toBe(false);
    await fs.writeFile(path.join(layout.workdir, "bun.lock"), "");
    expect(resolveInstallLayout(env, argv).supported).toBe(true);
    await fs.writeFile(path.join(layout.workdir, "node_modules/@coder/xum/package.json"), "{}");
    expect(resolveInstallLayout(env, argv).supported).toBe(false);
  });
});

describe("staging and activation", () => {
  test("installs the staged lockfile with lifecycle scripts disabled for every manager", async () => {
    const { layout } = await fixture();
    const commands = (packageManager: InstallLayout["packageManager"]) =>
      installCommands({ ...layout, packageManager });
    for (const packageManager of ["bun", "npm", "pnpm"] as const) {
      const install = commands(packageManager).at(-1);
      expect(install?.file).toBe(packageManager);
      expect(install?.args).toContain("--ignore-scripts");
      expect(install?.args.slice(-2)).toEqual(["--registry", layout.registry]);
    }
    // npm and bun install the staged lockfile itself, which records the release tarball, and
    // must not resolve anything it lacks. bun writes its text lockfile from it first.
    const [npm] = commands("npm");
    expect(npm.args[0]).toBe("ci");
    expect(npm.args).toContain("--strict-ssl");
    expect(npm.args).toContain("--include=optional");
    const [bunMigrate, bunInstall] = commands("bun");
    expect(bunMigrate.args.slice(0, 2)).toEqual(["pm", "migrate"]);
    expect(bunMigrate.args).toContain("--save-text-lockfile");
    expect(bunInstall.args.slice(0, 2)).toEqual(["install", "--frozen-lockfile"]);
    // pnpm converts it first; both steps must keep TLS and the lockfile on, and the conversion
    // must ask the configured registry.
    const [pnpmImport, pnpmInstall] = commands("pnpm");
    expect(pnpmImport.args[0]).toBe("import");
    expect(pnpmImport.args).toContain(`--config.registry=${layout.registry}`);
    expect(pnpmInstall.args[0]).toBe("install");
    expect(pnpmInstall.args).toContain("--frozen-lockfile");
    expect(pnpmInstall.args).toContain("--config.optional=true");
    for (const { args } of [pnpmImport, pnpmInstall]) {
      expect(args).toContain("--config.strict-ssl=true");
      expect(args).toContain("--config.lockfile=true");
    }
    await expectFailure(() => stageUpdate(layout, "../../escape", fakeRegistry("2.0.0")));
  });
  test("stages the digest-checked tarball, refusing a corrupted download before any install", async () => {
    const { layout: installed, root } = await fixture();
    const layout = { ...installed, registry: "https://mirror.example.com/npm" };
    const registry = fakeRegistry("2.0.0", undefined, {}, { "zod@4.5.4": sriOf("zod") });
    const readJson = async (file: string): Promise<Record<string, Record<string, unknown>>> =>
      JSON.parse(await fs.readFile(file, "utf8")) as Record<string, Record<string, unknown>>;
    let seed: { dependencies: unknown; packages: Record<string, unknown> } | undefined;
    const bin = await stageUpdate(layout, "2.0.0", {
      ...registry,
      install: async (file, args, cwd) => {
        seed = {
          dependencies: (await readJson(path.join(cwd, "package.json"))).dependencies,
          packages: (await readJson(path.join(cwd, "package-lock.json"))).packages,
        };
        await fakeInstall("2.0.0", { "zod@4.5.4": sriOf("zod") })(file, args, cwd);
      },
    });
    const stageDir = stageOf(bin);
    expect(path.dirname(stageDir)).toBe(root);
    expect(path.basename(stageDir)).toMatch(/^xum-staging-2\.0\.0\./);
    const tarball = path.join(stageDir, "xum-2.0.0.tgz");
    // The manager gets the downloaded tarball and the tree its shrinkwrap pins, nested where npm
    // installs a published package's shrinkwrap and fetched from the configured registry.
    expect(seed?.dependencies).toEqual({ "@coder/xum": `file:${tarball}` });
    expect(seed?.packages["node_modules/@coder/xum"]).toMatchObject({
      version: "2.0.0",
      resolved: `file:${tarball}`,
    });
    expect(seed?.packages["node_modules/@coder/xum/node_modules/zod"]).toMatchObject({
      version: "4.5.4",
      resolved: `${layout.registry}/zod/-/zod-4.5.4.tgz`,
      integrity: sriOf("zod"),
    });
    // bun converted that npm lockfile into its own, which must be the stage's only lockfile.
    expect(await fs.readdir(stageDir)).not.toContain("package-lock.json");
    expect(new Uint8Array(await fs.readFile(tarball))).toEqual(registry.bytes);
    expect(bin).toBe(path.join(stageDir, "node_modules/@coder/xum/dist/cli/index.js"));
    expect(registry.calls.map((call) => call.url)).toEqual([
      `${layout.registry}/@coder%2Fxum/2.0.0`,
      registry.tarball,
      `${layout.registry}/zod/4.5.4`,
    ]);
    expect(registry.calls.every((call) => call.options.redirect === "error")).toBe(true);
    const corrupted = fakeRegistry("3.0.0", undefined, { integrity: sri(new Uint8Array([1])) });
    let installs = 0;
    await expectFailure(() =>
      stageUpdate(layout, "3.0.0", {
        ...corrupted,
        install: () => {
          installs++;
          return Promise.resolve();
        },
      })
    );
    expect(installs).toBe(0);
    const [aborted] = await stagesIn(root, "3.0.0");
    expect((await fs.readdir(path.join(root, aborted))).sort()).toEqual([
      SERVER_UPDATE_STAGE_MARKER,
      "package.json",
    ]);
  });
  test("installs only the versions the release pins, and refuses a release that pins none", async () => {
    const { layout } = await fixture();
    const release = releaseTarball("2.0.0", shrinkwrapFor("2.0.0", { "zod@4.5.4": sriOf("zod") }));
    // A newer release of a dependency, or the pinned version under another digest from a mirror
    // that serves matching metadata, is refused before any registry lookup.
    const unpinnedTrees: Array<Record<string, string>> = [
      { "zod@4.5.5": sriOf("zod") },
      { "zod@4.5.4": sriOf("evil") },
    ];
    for (const staged of unpinnedTrees) {
      const registry = fakeRegistry("2.0.0", release, {}, staged);
      await expectFailure(() =>
        stageUpdate(layout, "2.0.0", { ...registry, install: fakeInstall("2.0.0", staged) })
      );
      expect(registry.calls.map((call) => call.url)).toEqual([
        `${layout.registry}/@coder%2Fxum/2.0.0`,
        registry.tarball,
      ]);
    }
    // Without a shrinkwrap, or with one npm generated at publish time that records a dependency by
    // version alone, the manager would have to resolve the tree itself.
    const versionOnly = shrinkwrapFor("2.0.0");
    const unpinned = {
      ...versionOnly,
      packages: { ...versionOnly.packages, "node_modules/zod": { version: "4.5.4" } },
    };
    for (const shrinkwrap of [null, unpinned]) {
      let installs = 0;
      await expectFailure(() =>
        stageUpdate(layout, "2.0.0", {
          ...fakeRegistry("2.0.0", releaseTarball("2.0.0", shrinkwrap)),
          install: () => {
            installs++;
            return Promise.resolve();
          },
        })
      );
      expect(installs).toBe(0);
    }
  });
  test("npm installs the staged lockfile as written; bun and pnpm convert it to their own first", async () => {
    const deps = { "zod@4.5.4": sriOf("zod") };
    const pnpmLock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@coder/xum@file:xum-2.0.0.tgz':",
      "    resolution: {integrity: sha512-unchecked, tarball: file:xum-2.0.0.tgz}",
      "    version: 2.0.0",
      "  zod@4.5.4:",
      `    resolution: {integrity: ${deps["zod@4.5.4"]}}`,
      "",
    ].join("\n");
    const expected = {
      npm: { steps: ["npm ci"], lockfiles: ["package-lock.json"] },
      bun: { steps: ["bun pm", "bun install"], lockfiles: ["bun.lock"] },
      pnpm: { steps: ["pnpm import", "pnpm install"], lockfiles: ["pnpm-lock.yaml"] },
    };
    for (const packageManager of ["npm", "bun", "pnpm"] as const) {
      const { layout } = await fixture(packageManager);
      const registry = fakeRegistry("2.0.0", undefined, {}, deps);
      const steps: string[] = [];
      const bin = await stageUpdate(layout, "2.0.0", {
        ...registry,
        install: async (file, args, cwd) => {
          steps.push(`${file} ${args[0]}`);
          // pnpm writes its lockfile while importing npm's; `npm ci` leaves the staged one as is.
          if (file === "bun") await fakeInstall("2.0.0", deps)(file, args, cwd);
          else if (args[0] === "import")
            await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), pnpmLock);
          else await writePackage(cwd, "2.0.0");
        },
      });
      expect(steps).toEqual(expected[packageManager].steps);
      const files = await fs.readdir(stageOf(bin));
      expect(files.filter((name) => name.includes("lock")).sort()).toEqual(
        expected[packageManager].lockfiles
      );
      expect(registry.calls.map((call) => call.url)).toContain(`${layout.registry}/zod/4.5.4`);
    }
  });
  test.skipIf(!execFileSync("tar", ["--version"]).toString().includes("GNU tar"))(
    "an inherited TAR_OPTIONS cannot hide the release's shrinkwrap",
    async () => {
      const { layout } = await fixture();
      // Built first: the variable would strip the shrinkwrap from the fixture tarball as well.
      const registry = fakeRegistry("2.0.0");
      const inherited = process.env.TAR_OPTIONS;
      process.env.TAR_OPTIONS = "--exclude=package/npm-shrinkwrap.json";
      try {
        await stageUpdate(layout, "2.0.0", { ...registry, install: fakeInstall("2.0.0") });
      } finally {
        if (inherited === undefined) delete process.env.TAR_OPTIONS;
        else process.env.TAR_OPTIONS = inherited;
      }
    }
  );
  test("prunes only its own old stages, preserves active and original installs, and swaps atomically", async () => {
    const { layout, root } = await fixture();
    const oldEntry = await fs.readFile(layout.entry, "utf8");
    const stale = path.join(root, "xum-staging-0.9.0");
    await fs.mkdir(stale);
    await fs.writeFile(
      path.join(stale, SERVER_UPDATE_STAGE_MARKER),
      JSON.stringify({ launcher: layout.launcher })
    );
    // Same naming scheme, but not this updater's: an unmarked directory and another
    // installation's stage sharing the parent.
    await fs.mkdir(path.join(root, "xum-staging-0.8.0"));
    await fs.writeFile(path.join(root, "xum-staging-0.8.0/keep"), "");
    await fs.mkdir(path.join(root, "xum-staging-0.7.0"));
    await fs.writeFile(
      path.join(root, "xum-staging-0.7.0", SERVER_UPDATE_STAGE_MARKER),
      JSON.stringify({ launcher: path.join(root, "other-mux") })
    );
    // A stage that crashed before taking its final name is marked and pruned as well.
    const crashed = path.join(root, "xum-staging-1.4.0.a1b2c3");
    await fs.mkdir(crashed);
    await fs.writeFile(
      path.join(crashed, SERVER_UPDATE_STAGE_MARKER),
      JSON.stringify({ launcher: layout.launcher })
    );
    // The updater's own earlier stage carries the marker it wrote and is pruned like the stale one.
    await stageUpdate(layout, "1.5.0", { ...fakeRegistry("1.5.0"), install: fakeInstall("1.5.0") });
    const bin = await stageUpdate(layout, "2.0.0", {
      ...fakeRegistry("2.0.0"),
      install: fakeInstall("2.0.0"),
    });
    const remaining = (await fs.readdir(root)).filter((name) => name.startsWith("xum-staging-"));
    expect(remaining.sort()).toEqual([
      "xum-staging-0.7.0",
      "xum-staging-0.8.0",
      path.basename(stageOf(bin)),
    ]);
    expect(await fs.readdir(path.join(root, "xum-staging-0.8.0"))).toEqual(["keep"]);
    activateUpdate(layout, bin);
    expect(await fs.readlink(layout.launcher)).toBe(bin);
    expect(await fs.readFile(layout.entry, "utf8")).toBe(oldEntry);
    const result = resolveInstallLayout(
      { MUX_BINARY: layout.launcher, RESTART_ON_KILL_VALUE: "true" },
      ["node", layout.launcher]
    );
    if (!result.supported) throw new Error(result.reason);
    expect(result.layout.version).toBe("2.0.0");
    await stageUpdate(result.layout, "3.0.0", {
      ...fakeRegistry("3.0.0"),
      install: fakeInstall("3.0.0"),
    });
    expect((await fs.readdir(root)).filter((name) => name.startsWith("xum-staging-"))).toHaveLength(
      4
    );
    expect(await fs.realpath(layout.launcher)).toBe(await fs.realpath(bin));
    expect(await fs.readFile(layout.entry, "utf8")).toBe(oldEntry);
    // A foreign directory carrying the version's name, even an empty one that rename() would
    // silently replace, is neither touched nor an obstacle.
    await fs.mkdir(path.join(root, "xum-staging-4.0.0"));
    await stageUpdate(result.layout, "4.0.0", {
      ...fakeRegistry("4.0.0"),
      install: fakeInstall("4.0.0"),
    });
    expect(await fs.readdir(path.join(root, "xum-staging-4.0.0"))).toEqual([]);
    expect(await stagesIn(root, "4.0.0")).toHaveLength(2);
  });
  test("verification rejects mismatched versions, missing entrypoints, and failing smoke runs", async () => {
    const { layout } = await fixture();
    expect(await verifyStagedPackage(layout.workdir, layout.version)).toBe(layout.entry);
    await expectFailure(() => verifyStagedPackage(layout.workdir, "9.0.0"));
    if (process.platform !== "win32") {
      await fs.chmod(layout.entry, 0o644);
      await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
      await fs.chmod(layout.entry, 0o755);
    }
    await fs.writeFile(layout.entry, "console.log('no interpreter line')", { mode: 0o755 });
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
    // Any other interpreter line parses but exits 127 under the supervisor.
    await fs.writeFile(layout.entry, "#!/definitely/missing\nconsole.log('x')", { mode: 0o755 });
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
    await fs.writeFile(layout.entry, "#!/usr/bin/env node\r\nconsole.log('x')", { mode: 0o755 });
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
    await fs.writeFile(layout.entry, "#!/usr/bin/env node\nthis is not javascript (", {
      mode: 0o755,
    });
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
    await fs.unlink(layout.entry);
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
  });
  test("anchors every locked dependency digest to the registry for each manager's lockfile", async () => {
    const { layout, root } = await fixture();
    const deps = { "zod@4.5.4": sriOf("zod"), "inner@1.0.0": sriOf("inner") };
    const stage = async (label: string, lockfile: string, raw: string) => {
      const dir = path.join(root, `stage-${label}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, lockfile), raw);
      return dir;
    };
    const npmLock = (packages: Record<string, unknown> = {}) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@coder/xum": "file:xum-2.0.0.tgz" } },
          "node_modules/@coder/xum": { version: "2.0.0", resolved: "file:xum-2.0.0.tgz" },
          "node_modules/zod": {
            version: "4.5.4",
            resolved: "https://registry.example.com/zod/-/zod-4.5.4.tgz",
            integrity: deps["zod@4.5.4"],
          },
          "node_modules/zod/node_modules/inner": {
            version: "1.0.0",
            resolved: "https://registry.example.com/inner/-/inner-1.0.0.tgz",
            integrity: deps["inner@1.0.0"],
          },
          ...packages,
        },
      });
    const pnpmLock = (packages: string[] = [], snapshots: string[] = []) =>
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  '@coder/xum@file:xum-2.0.0.tgz':",
        "    resolution: {integrity: sha512-unchecked, tarball: file:xum-2.0.0.tgz}",
        "    version: 2.0.0",
        "  zod@4.5.4:",
        `    resolution: {integrity: ${deps["zod@4.5.4"]}}`,
        "  '/inner@1.0.0(zod@4.5.4)':",
        `    resolution: {integrity: ${deps["inner@1.0.0"]}}`,
        ...packages,
        "snapshots:",
        "  '@coder/xum@file:xum-2.0.0.tgz':",
        "    dependencies:",
        "      zod: 4.5.4",
        "  zod@4.5.4:",
        "    dependencies:",
        "      inner: 1.0.0(zod@4.5.4)",
        ...snapshots,
        "",
      ].join("\n");
    const stages = {
      bun: await stage("bun", "bun.lock", bunLock("/stage/xum-2.0.0.tgz", deps)),
      npm: await stage("npm", "package-lock.json", npmLock()),
      pnpm: await stage("pnpm", "pnpm-lock.yaml", pnpmLock()),
    };
    for (const packageManager of ["bun", "npm", "pnpm"] as const) {
      const registry = fakeRegistry("2.0.0", undefined, {}, deps);
      const managerLayout = { ...layout, packageManager };
      const expected = [`${layout.registry}/inner/1.0.0`, `${layout.registry}/zod/4.5.4`];
      expect(
        await verifyStagedDependencies(
          managerLayout,
          stages[packageManager],
          pinsOf(deps),
          registry.request
        )
      ).toBe(expected.length);
      expect(registry.calls.map((call) => call.url).sort()).toEqual(expected.sort());
      expect(registry.calls.every((call) => call.options.redirect === "error")).toBe(true);
      // A digest the registry does not publish is the redirect-tampering signature.
      const tampered = fakeRegistry(
        "2.0.0",
        undefined,
        {},
        { ...deps, "inner@1.0.0": sriOf("evil") }
      );
      await expectFailure(() =>
        verifyStagedDependencies(
          managerLayout,
          stages[packageManager],
          pinsOf(deps),
          tampered.request
        )
      );
      // A version the release does not pin was resolved at update time; it is refused before
      // any registry lookup, under any digest.
      for (const pins of [
        { "zod@4.5.4": deps["zod@4.5.4"] },
        { ...deps, "inner@1.0.0": sriOf("x") },
      ]) {
        const unpinned = fakeRegistry("2.0.0", undefined, {}, deps);
        await expectFailure(() =>
          verifyStagedDependencies(
            managerLayout,
            stages[packageManager],
            pinsOf(pins),
            unpinned.request
          )
        );
        expect(unpinned.calls).toHaveLength(0);
      }
    }
    // A published digest listed beside a foreign one must not vouch for it: managers accept a
    // tarball matching either.
    const mixed = await stage(
      "bun",
      "bun.lock",
      bunLock("/stage/xum-2.0.0.tgz", {
        ...deps,
        "inner@1.0.0": `${sriOf("evil")} ${deps["inner@1.0.0"]}`,
      })
    );
    const mixedPins = { ...deps, "inner@1.0.0": `${sriOf("evil")} ${deps["inner@1.0.0"]}` };
    for (const pins of [deps, mixedPins]) {
      await expectFailure(() =>
        verifyStagedDependencies(
          layout,
          mixed,
          pinsOf(pins),
          fakeRegistry("2.0.0", undefined, {}, deps).request
        )
      );
    }
    const refused = {
      plaintext: `    "evil": ["evil@1.0.0", "http://mirror.example.com/evil-1.0.0.tgz", {}, "${sriOf("evil")}"],`,
      unpinned: '    "evil": ["evil@1.0.0", "", {}],',
      remote: '    "evil": ["evil@https://mirror.example.com/evil-1.0.0.tgz", {}],',
      local: '    "evil": ["evil@/tmp/evil.tgz", {}],',
      git: '    "evil": ["evil@github:evil/evil#abc", {}],',
      digestedRemote: `    "evil": ["evil@https://mirror.example.com/evil-1.0.0.tgz", {}, "${sriOf("evil")}"],`,
      digestedLocal: `    "evil": ["evil@/tmp/evil.tgz", {}, "${sriOf("evil")}"],`,
    };
    for (const extra of Object.values(refused)) {
      const dir = await stage("bun", "bun.lock", bunLock("/stage/xum-2.0.0.tgz", deps, extra));
      const registry = fakeRegistry(
        "2.0.0",
        undefined,
        {},
        { ...deps, "evil@1.0.0": sriOf("evil") }
      );
      // The refusal names the dependency; a crash on the malformed entry would not.
      expect(
        verifyStagedDependencies(
          layout,
          dir,
          pinsOf({ ...deps, "evil@1.0.0": sriOf("evil") }),
          registry.request
        )
      ).rejects.toThrow("Dependency evil");
      expect(registry.calls).toHaveLength(0);
    }
    // Redirected metadata can present any published package, or the release tarball itself, as
    // the dependency a package requested; only the requested name may be verified, so a lockfile
    // recording a different installed name is refused before any registry lookup.
    const substituted: Array<[InstallLayout["packageManager"], string]> = [
      [
        "npm",
        await stage(
          "npm-renamed",
          "package-lock.json",
          npmLock({
            "node_modules/is-odd": {
              name: "is-number",
              version: "6.0.0",
              resolved: "https://registry.example.com/is-number/-/is-number-6.0.0.tgz",
              integrity: sriOf("is-number"),
            },
          })
        ),
      ],
      [
        "npm",
        await stage(
          "npm-release",
          "package-lock.json",
          npmLock({
            "node_modules/commander": {
              name: "@coder/xum",
              version: "2.0.0",
              resolved: "file:xum-2.0.0.tgz",
            },
          })
        ),
      ],
      [
        "npm",
        await stage(
          "npm-nested-release",
          "package-lock.json",
          npmLock({
            "node_modules/zod/node_modules/@coder/xum": {
              version: "2.0.0",
              resolved: "file:xum-2.0.0.tgz",
            },
          })
        ),
      ],
      [
        "npm",
        await stage(
          "npm-bundled",
          "package-lock.json",
          npmLock({ "node_modules/bundled": { version: "1.0.0", inBundle: true } })
        ),
      ],
      [
        "pnpm",
        await stage(
          "pnpm-renamed",
          "pnpm-lock.yaml",
          pnpmLock(
            ["  is-number@6.0.0:", `    resolution: {integrity: ${sriOf("is-number")}}`],
            [
              "  is-number@6.0.0: {}",
              "  inner@1.0.0(zod@4.5.4):",
              "    dependencies:",
              "      is-odd: is-number@6.0.0",
            ]
          )
        ),
      ],
      [
        "bun",
        await stage(
          "bun-release",
          "bun.lock",
          bunLock(
            "/stage/xum-2.0.0.tgz",
            deps,
            '    "commander": ["@coder/xum@/stage/xum-2.0.0.tgz", {}],'
          )
        ),
      ],
    ];
    for (const [packageManager, dir] of substituted) {
      const registry = fakeRegistry(
        "2.0.0",
        undefined,
        {},
        { ...deps, "is-number@6.0.0": sriOf("is-number") }
      );
      await expectFailure(() =>
        verifyStagedDependencies(
          { ...layout, packageManager },
          dir,
          pinsOf({ ...deps, "is-number@6.0.0": sriOf("is-number") }),
          registry.request
        )
      );
      expect(registry.calls).toHaveLength(0);
    }
    // A bundled flag is metadata too and exempts nothing: the entry is verified like any other.
    const bundled = `    "bundled": ["bundled@1.0.0", "", { "bundled": true }, "${sriOf("bundled")}"],`;
    const dir = await stage("bun", "bun.lock", bunLock("/stage/xum-2.0.0.tgz", deps, bundled));
    expect(
      await verifyStagedDependencies(
        layout,
        dir,
        pinsOf({ ...deps, "bundled@1.0.0": sriOf("bundled") }),
        fakeRegistry("2.0.0", undefined, {}, { ...deps, "bundled@1.0.0": sriOf("bundled") }).request
      )
    ).toBe(3);
    // bun 1.4 ends the release's tarball entry with its digest.
    const digested = await stage(
      "bun-digested",
      "bun.lock",
      bunLock("/stage/xum-2.0.0.tgz", deps).replace(
        '{ "dependencies": {} }],',
        `{ "dependencies": {} }, "${sriOf("release")}"],`
      )
    );
    expect(
      await verifyStagedDependencies(
        layout,
        digested,
        pinsOf(deps),
        fakeRegistry("2.0.0", undefined, {}, deps).request
      )
    ).toBe(2);
    const unreadable = await stage("bun", "bun.lock", "not a lockfile");
    await expectFailure(() =>
      verifyStagedDependencies(layout, unreadable, pinsOf(deps), fakeRegistry("2.0.0").request)
    );
  });
  test("activation failure leaves the old link intact", async () => {
    const { layout } = await fixture();
    const original = await fs.readlink(layout.launcher);
    expect(() => activateUpdate(layout, "/missing-update-bin")).toThrow();
    expect(await fs.readlink(layout.launcher)).toBe(original);
    await fs.unlink(layout.launcher);
    await fs.writeFile(layout.launcher, "replaced externally");
    expect(() => activateUpdate(layout, layout.entry)).toThrow();
    expect(await fs.readFile(layout.launcher, "utf8")).toBe("replaced externally");
  });
});

describe("server updater", () => {
  test("unsupported actions have no effects beyond recording the channel preference", async () => {
    const effect = () => {
      throw new Error("must not run");
    };
    const updater = new ServerUpdater({ supported: false, reason: "test" }, undefined, {
      collectBlockers: effect,
      restart: effect,
      fetchDistTags: effect,
      runInstall: effect,
      activate: effect,
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.installUpdate();
    updater.setChannel("nightly");
    expect(updater.getStatus().type).toBe("unsupported");
    expect(updater.getChannel()).toBe("nightly");
  });
  test("selects dist-tags by effective channel, including downgrades, and resets staged updates", async () => {
    const { layout } = await fixture("bun", "2.0.0-next.1");
    const deps: ServerUpdaterDeps = {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () => Promise.resolve({ latest: "1.0.0", next: layout.version }),
      runInstall: () => Promise.resolve("/staged"),
    };
    const updater = new ServerUpdater({ supported: true, layout }, undefined, deps);
    await updater.checkForUpdates();
    expect(updater.getStatus().type).toBe("up-to-date");
    updater.setChannel("stable");
    await updater.checkForUpdates();
    expect(updater.getStatus()).toEqual({ type: "available", info: { version: "1.0.0" } });
    await updater.downloadUpdate();
    expect(updater.getStatus().type).toBe("downloaded");
    updater.setChannel("nightly");
    expect(updater.getStatus().type).toBe("idle");
    await updater.installUpdate();
    expect(updater.getStatus().type).toBe("idle");
    expect(new ServerUpdater({ supported: true, layout }, "stable", deps).getChannel()).toBe(
      "stable"
    );
  });
  test("stages the newest publication independently of tags and clears it on channel change", async () => {
    const { layout } = await fixture("bun", "2.0.0-next.1");
    let newest = "2.0.0-next.3";
    const installed: string[] = [];
    const updater = new ServerUpdater({ supported: true, layout }, "npm", {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () => Promise.resolve({ latest: "1.0.0", next: layout.version }),
      fetchNewestVersion: () => Promise.resolve(newest),
      runInstall: (_layout, version) => {
        installed.push(version);
        return Promise.resolve("/staged");
      },
    });
    await updater.checkForUpdates();
    expect(updater.getStatus()).toEqual({ type: "available", info: { version: newest } });
    await updater.downloadUpdate();
    expect(installed).toEqual([newest]);
    newest = "2.0.0-next.4";
    await updater.checkForUpdates();
    expect(updater.getStatus()).toEqual({ type: "available", info: { version: newest } });
    updater.setChannel("nightly");
    await updater.checkForUpdates();
    expect(updater.getStatus().type).toBe("up-to-date");
    updater.setChannel("npm");
    newest = layout.version;
    await updater.checkForUpdates();
    expect(updater.getStatus().type).toBe("up-to-date");
  });
  test("reports check and download failures, suppresses automatic check errors, and retries", async () => {
    const { layout } = await fixture();
    let checkFails = true;
    let downloadFails = true;
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () =>
        checkFails ? Promise.reject(new Error("offline")) : Promise.resolve({ next: "2.0.0" }),
      runInstall: () =>
        downloadFails ? Promise.reject(new Error("install failed")) : Promise.resolve("/staged"),
    });
    const statuses: UpdateStatus[] = [];
    updater.subscribe((s) => statuses.push(s));
    await updater.checkForUpdates({ source: "auto" });
    expect(updater.getStatus().type).toBe("idle");
    await updater.checkForUpdates();
    expect(updater.getStatus()).toMatchObject({ type: "error", phase: "check" });
    checkFails = false;
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "error", phase: "download" });
    downloadFails = false;
    await updater.downloadUpdate();
    expect(updater.getStatus().type).toBe("downloaded");
    expect(statuses).toContainEqual({ type: "downloading", percent: null });
  });
  test("blocks volatile work and restarts exactly once only after successful activation", async () => {
    const { layout } = await fixture();
    const events: string[] = [];
    let blockers: RestartBlocker[] = [{ kind: "terminals", count: 1 }];
    let activationFails = true;
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      refreshBlockers: () => {
        events.push("refresh");
        return Promise.resolve();
      },
      collectBlockers: () => {
        events.push("snapshot");
        return blockers;
      },
      restart: () => {
        events.push("restart");
        return Promise.resolve();
      },
      fetchDistTags: () => Promise.resolve({ next: "2.0.0" }),
      runInstall: () => Promise.resolve("/staged"),
      activate: () => {
        if (activationFails) throw new Error("failed");
        events.push("activate");
      },
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const restarting: UpdateStatus[] = [];
    updater.subscribe((status) => {
      events.push(`status:${status.type}`);
      if (status.type === "restarting") restarting.push(status);
    });
    events.length = 0;
    await updater.installUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "install-blocked", blockers });
    expect(events).toEqual(["refresh", "snapshot", "status:install-blocked"]);
    blockers = [];
    events.length = 0;
    await updater.installUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "error", phase: "install" });
    // The client drops its restart screen on the install error that follows.
    expect(events).toEqual(["refresh", "snapshot", "status:restarting", "status:error"]);
    activationFails = false;
    events.length = 0;
    await Promise.all([updater.installUpdate(), updater.installUpdate()]);
    expect(events).toEqual(["refresh", "snapshot", "status:restarting", "activate", "restart"]);
    expect(restarting.at(-1)).toEqual({ type: "restarting", info: { version: "2.0.0" } });
  });
  test("a forced install restarts despite blockers without consulting them", async () => {
    const { layout } = await fixture();
    const events: string[] = [];
    const stagedUpdater = async () => {
      const updater = new ServerUpdater({ supported: true, layout }, undefined, {
        refreshBlockers: () => {
          events.push("refresh");
          return Promise.resolve();
        },
        collectBlockers: () => {
          events.push("snapshot");
          return [{ kind: "active-streams", count: 3 }];
        },
        restart: () => {
          events.push("restart");
          return Promise.resolve();
        },
        fetchDistTags: () => Promise.resolve({ next: "2.0.0" }),
        runInstall: () => Promise.resolve("/staged"),
        activate: () => {
          events.push("activate");
        },
      });
      await updater.checkForUpdates();
      await updater.downloadUpdate();
      return updater;
    };
    const updater = await stagedUpdater();
    await updater.installUpdate();
    expect(updater.getStatus().type).toBe("install-blocked");
    updater.subscribe((status) => events.push(`status:${status.type}`));
    events.length = 0;
    await updater.installUpdate({ force: true });
    expect(events).toEqual(["status:restarting", "activate", "restart"]);

    // An unrelated teardown already under way still wins over a forced install.
    const shuttingDown = await stagedUpdater();
    await shuttingDown.beginShutdown();
    events.length = 0;
    await shuttingDown.installUpdate({ force: true });
    expect(events).toEqual([]);
  });
  test("a re-check keeps a staged download the channel still points at and drops a stale one", async () => {
    const { layout } = await fixture();
    let next = "2.0.0";
    const events: string[] = [];
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () => Promise.resolve({ next }),
      runInstall: (_layout, version) => Promise.resolve(`/staged/${version}`),
      activate: (_layout, entry) => {
        events.push(entry);
        throw new Error("failed");
      },
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.installUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "error", phase: "install" });
    await updater.checkForUpdates();
    expect(updater.getStatus()).toEqual({ type: "downloaded", info: { version: "2.0.0" } });
    next = "2.1.0";
    await updater.checkForUpdates();
    expect(updater.getStatus()).toEqual({ type: "available", info: { version: "2.1.0" } });
    await updater.installUpdate();
    await updater.downloadUpdate();
    await updater.installUpdate();
    expect(events).toEqual(["/staged/2.0.0", "/staged/2.1.0"]);
  });
  test("a failed check keeps a staged download installable", async () => {
    const { layout } = await fixture();
    let offline = false;
    const events: string[] = [];
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      collectBlockers: () => [],
      restart: () => {
        events.push("restart");
        return Promise.resolve();
      },
      fetchDistTags: () =>
        offline ? Promise.reject(new Error("offline")) : Promise.resolve({ next: "2.0.0" }),
      runInstall: () => Promise.resolve("/staged"),
      activate: () => {
        events.push("activate");
      },
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    offline = true;
    await updater.checkForUpdates();
    expect(updater.getStatus()).toEqual({ type: "downloaded", info: { version: "2.0.0" } });
    await updater.installUpdate();
    expect(events).toEqual(["activate", "restart"]);
  });
  test("a shutdown that begins while blockers refresh never activates the update", async () => {
    const { layout } = await fixture();
    const events: string[] = [];
    let releaseRefresh!: () => void;
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      refreshBlockers: () => new Promise<void>((resolve) => (releaseRefresh = resolve)),
      collectBlockers: () => [],
      restart: () => {
        events.push("restart");
        return Promise.resolve();
      },
      fetchDistTags: () => Promise.resolve({ next: "2.0.0" }),
      runInstall: () => Promise.resolve("/staged"),
      activate: () => {
        events.push("activate");
      },
    });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const install = updater.installUpdate();
    await updater.beginShutdown();
    releaseRefresh();
    await install;
    expect(events).toEqual([]);
  });
  test("shutdown aborts a pending stage and waits for it to settle", async () => {
    const { layout } = await fixture();
    let observed: AbortSignal | undefined;
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () => Promise.resolve({ next: "2.0.0" }),
      runInstall: (_layout, _version, options) =>
        new Promise((_resolve, reject) => {
          observed = options?.signal;
          observed?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await updater.checkForUpdates();
    const download = updater.downloadUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "downloading" });
    await updater.beginShutdown();
    await download;
    expect(observed?.aborted).toBe(true);
    expect(updater.getStatus()).toMatchObject({ type: "error", phase: "download" });
    observed = undefined;
    await updater.downloadUpdate();
    expect(observed).toBeUndefined();
  });
  test("serializes checks and downloads and refuses channel changes while busy", async () => {
    const { layout } = await fixture();
    let resolveTags!: (tags: { next: string }) => void;
    let checks = 0;
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () => {
        checks++;
        return new Promise((resolve) => {
          resolveTags = resolve;
        });
      },
    });
    const check = updater.checkForUpdates();
    await updater.checkForUpdates();
    expect(checks).toBe(1);
    expect(() => updater.setChannel("stable")).toThrow();
    resolveTags({ next: layout.version });
    await check;
    expect(updater.getStatus().type).toBe("up-to-date");
  });
});

describe("registry discovery", () => {
  test("newest npm follows publication time, including untagged prereleases, not semver", async () => {
    const newest = "1.0.1-next.2";
    const result = await fetchNewestVersion(
      "https://registry.example.com/prefix",
      (url, options) => {
        expect(url).toBe("https://registry.example.com/prefix/@coder%2Fxum");
        expect(options.redirect).toBe("error");
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "dist-tags": { latest: "1.0.0", next: "9.0.0-next.1" },
              versions: {
                "1.0.0": {},
                "9.0.0-next.1": {},
                [newest]: {},
                "2.0.0": {},
                "../../invalid": {},
              },
              time: {
                modified: "2030-01-01T00:00:00Z",
                "1.0.0": "2026-01-01T00:00:00Z",
                [newest]: "2026-03-01T00:00:00Z",
                "9.0.0-next.1": "2026-02-01T00:00:00Z",
                "2.0.0": "invalid-date",
                "3.0.0": "2026-04-01T00:00:00Z",
                "../../invalid": "2026-05-01T00:00:00Z",
              },
            })
          )
        );
      }
    );
    expect(result).toBe(newest);
  });
  test("newest npm rejects missing publications and malformed registry responses", async () => {
    for (const body of [
      null,
      {},
      { versions: {}, time: { modified: "2026-01-01T00:00:00Z" } },
      { versions: { "1.0.0": {} }, time: { "1.0.0": null } },
    ]) {
      await expectFailure(() =>
        fetchNewestVersion("https://registry.example.com", () =>
          Promise.resolve(new Response(JSON.stringify(body)))
        )
      );
    }
  });
  test("requests scoped package dist-tags and accepts only exact versions", async () => {
    let observedUrl = "";
    let hasSignal = false;
    const tags = await fetchDistTags("https://registry.example.com/prefix", (url, options) => {
      observedUrl = url;
      hasSignal = options.signal instanceof AbortSignal;
      return Promise.resolve(
        new Response(JSON.stringify({ latest: "1.0.0", next: "../../invalid" }))
      );
    });
    expect(observedUrl).toBe(
      "https://registry.example.com/prefix/-/package/@coder%2Fxum/dist-tags"
    );
    expect(hasSignal).toBe(true);
    expect(tags).toEqual({ latest: "1.0.0", next: undefined });
  });
  test("resolves a release to its HTTPS tarball and sha512 digest without following redirects", async () => {
    const registry = fakeRegistry("2.0.0");
    const artifact = await fetchArtifact("https://registry.example.com", "2.0.0", registry.request);
    expect(artifact).toEqual({
      version: "2.0.0",
      tarball: registry.tarball,
      integrity: sri(registry.bytes),
    });
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0].url).toBe("https://registry.example.com/@coder%2Fxum/2.0.0");
    expect(registry.calls[0].options.redirect).toBe("error");
    const rejected = [
      fakeRegistry("2.0.0", undefined, { tarball: "http://registry.example.com/xum-2.0.0.tgz" }),
      fakeRegistry("2.0.0", undefined, { tarball: "https://user:pw@registry.example.com/x.tgz" }),
      fakeRegistry("2.0.0", undefined, { integrity: "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=" }),
      fakeRegistry("2.0.0", undefined, { version: "2.0.1" }),
    ];
    for (const registry of rejected)
      await expectFailure(() =>
        fetchArtifact("https://registry.example.com", "2.0.0", registry.request)
      );
    await expectFailure(() =>
      fetchArtifact("https://registry.example.com", "latest", fakeRegistry("2.0.0").request)
    );
  });
  test("keeps a downloaded tarball only when it matches the digest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "server-update-"));
    dirs.push(root);
    const registry = fakeRegistry("2.0.0");
    const artifact: ReleaseArtifact = {
      version: "2.0.0",
      tarball: registry.tarball,
      integrity: sri(registry.bytes),
    };
    const dest = path.join(root, "xum-2.0.0.tgz");
    await downloadArtifact(artifact, dest, registry.request);
    expect(new Uint8Array(await fs.readFile(dest))).toEqual(registry.bytes);
    expect(registry.calls[0].options.redirect).toBe("error");
    await expectFailure(() => downloadArtifact(artifact, dest, registry.request));
    const tampered = path.join(root, "tampered.tgz");
    await expectFailure(() =>
      downloadArtifact(
        { ...artifact, integrity: sri(new Uint8Array([1])) },
        tampered,
        registry.request
      )
    );
    expect(await fs.readdir(root)).toEqual(["xum-2.0.0.tgz"]);
    await expectFailure(() =>
      downloadArtifact(artifact, tampered, () => Promise.resolve(new Response("", { status: 404 })))
    );
  });
  test("finishes writing a chunk the file handle only partially accepted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "server-update-"));
    dirs.push(dir);
    interface Writer {
      write: (
        buffer: Uint8Array,
        offset?: number,
        length?: number
      ) => Promise<{ bytesWritten: number }>;
    }
    const probe = await fs.open(path.join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as Writer;
    await probe.close();
    const write = proto.write;
    let shortened = 0;
    const spy = spyOn(proto, "write").mockImplementation(function (
      this: Writer,
      buffer,
      offset = 0,
      length
    ) {
      // Persist a single byte the first time a multi-byte chunk arrives.
      if (shortened === 0 && buffer.length - offset > 1) {
        shortened++;
        return write.call(this, buffer, offset, 1);
      }
      return write.call(this, buffer, offset, length);
    });
    try {
      const registry = fakeRegistry(
        "2.0.0",
        new TextEncoder().encode("a tarball with several bytes")
      );
      const artifact = await fetchArtifact(
        "https://registry.example.com",
        "2.0.0",
        registry.request
      );
      const dest = path.join(dir, "xum.tgz");
      await downloadArtifact(artifact, dest, registry.request);
      expect(shortened).toBe(1);
      expect(new Uint8Array(await fs.readFile(dest))).toEqual(registry.bytes);
    } finally {
      spy.mockRestore();
    }
  });
  test("the stage's abort signal reaches the manifest request", async () => {
    const registry = fakeRegistry("2.0.0");
    const abort = new AbortController();
    abort.abort();
    await fetchArtifact("https://registry.example.com", "2.0.0", registry.request, abort.signal);
    expect(registry.calls[0].options.signal?.aborted).toBe(true);
    await fetchArtifact("https://registry.example.com", "2.0.0", registry.request);
    expect(registry.calls[1].options.signal?.aborted).toBe(false);
  });
  test("publishes a release's sha512 digest and legacy sha1 shasum, for the named package only", async () => {
    const shasum = "0123456789abcdef0123456789abcdef01234567";
    const manifest = (name: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            name,
            version: "1.0.0",
            dist: { tarball: "https://r.example.com/x.tgz", integrity: sriOf("x"), shasum },
          })
        )
      );
    expect(
      await fetchPublishedDigests("https://r.example.com", "x", "1.0.0", () => manifest("x"))
    ).toEqual([sriOf("x"), `sha1-${Buffer.from(shasum, "hex").toString("base64")}`]);
    await expectFailure(() =>
      fetchPublishedDigests("https://r.example.com", "x", "1.0.0", () => manifest("y"))
    );
  });
  test("rejects HTTP errors and malformed responses", async () => {
    await expectFailure(() =>
      fetchDistTags("https://registry.example.com", () =>
        Promise.resolve(new Response("", { status: 503 }))
      )
    );
    await expectFailure(() =>
      fetchDistTags("https://registry.example.com", () => Promise.resolve(new Response("not-json")))
    );
  });
});
