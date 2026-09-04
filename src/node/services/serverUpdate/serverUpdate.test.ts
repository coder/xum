import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { RestartBlocker, UpdateStatus } from "@/common/orpc/types";
import { resolveInstallLayout, inferChannel, type InstallLayout } from "./installLayout";
import { activateUpdate } from "./activation";
import { installCommand, stageUpdate, verifyStagedPackage } from "./staging";
import { fetchDistTags } from "./registry";
import { ServerUpdater, type ServerUpdaterDeps } from "./serverUpdater";

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
  await fs.writeFile(entry, script);
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
    const bin = await stageUpdate(layout, "2.0.0", async (_file, _args, cwd) => {
      await writePackage(cwd, "2.0.0");
    });
    activateUpdate(layout, bin);
    expect(await fs.readlink(layout.launcher)).toBe(bin);
  });
  test("requires supervisor, a symlink, and a matching running entry", async () => {
    const { env, argv, layout, root } = await fixture();
    expect(resolveInstallLayout({ MUX_BINARY: env.MUX_BINARY }, argv).supported).toBe(false);
    expect(
      resolveInstallLayout({ RESTART_ON_KILL_VALUE: "true" }, ["node", layout.entry]).supported
    ).toBe(false);
    expect(
      resolveInstallLayout({ XUM_SERVER_SUPERVISED: "1" }, ["node", layout.launcher]).supported
    ).toBe(true);
    const other = await writePackage(path.join(root, "other"), "2.0.0");
    await fs.writeFile(path.join(root, "other/bun.lock"), "");
    expect(resolveInstallLayout(env, ["node", other.bin]).supported).toBe(false);
    // A declared launcher does not excuse starting the entry file directly.
    expect(resolveInstallLayout(env, ["node", layout.entry]).supported).toBe(false);
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
    await fs.writeFile(path.join(layout.workdir, "bun.lockb"), "");
    expect(resolveInstallLayout(env, argv).supported).toBe(true);
    await fs.writeFile(path.join(layout.workdir, "node_modules/@coder/xum/package.json"), "{}");
    expect(resolveInstallLayout(env, argv).supported).toBe(false);
  });
});

describe("staging and activation", () => {
  test("installs an exact version with lifecycle scripts disabled for every manager", async () => {
    const { layout } = await fixture();
    for (const packageManager of ["bun", "npm", "pnpm"] as const) {
      const command = installCommand({ ...layout, packageManager }, "2.0.0");
      expect(command.file).toBe(packageManager);
      expect(command.args).toContain("@coder/xum@2.0.0");
      expect(command.args).toContain("--ignore-scripts");
      expect(command.args.slice(-2)).toEqual(["--registry", layout.registry]);
    }
    expect(() => installCommand(layout, "../../escape")).toThrow();
  });
  test("prunes only old stages, preserves active and original installs, and swaps atomically", async () => {
    const { layout, root } = await fixture();
    const oldEntry = await fs.readFile(layout.entry, "utf8");
    const stale = path.join(root, "xum-staging-0.9.0");
    await fs.mkdir(stale);
    const bin = await stageUpdate(layout, "2.0.0", async (_file, _args, cwd) => {
      await writePackage(cwd, "2.0.0");
      await fs.writeFile(path.join(cwd, "bun.lock"), "");
    });
    expect(await fs.readdir(root)).not.toContain("xum-staging-0.9.0");
    activateUpdate(layout, bin);
    expect(await fs.readlink(layout.launcher)).toBe(bin);
    expect(await fs.readFile(layout.entry, "utf8")).toBe(oldEntry);
    const result = resolveInstallLayout(
      { MUX_BINARY: layout.launcher, RESTART_ON_KILL_VALUE: "true" },
      ["node", layout.launcher]
    );
    if (!result.supported) throw new Error(result.reason);
    expect(result.layout.version).toBe("2.0.0");
    await stageUpdate(result.layout, "3.0.0", async (_file, _args, cwd) => {
      await writePackage(cwd, "3.0.0");
    });
    expect((await fs.readdir(root)).filter((name) => name.startsWith("xum-staging-"))).toHaveLength(
      2
    );
    expect(await fs.realpath(layout.launcher)).toBe(await fs.realpath(bin));
    expect(await fs.readFile(layout.entry, "utf8")).toBe(oldEntry);
  });
  test("verification rejects mismatched versions, missing entrypoints, and failing smoke runs", async () => {
    const { layout } = await fixture();
    await expectFailure(() => verifyStagedPackage(layout.workdir, "9.0.0"));
    await fs.writeFile(layout.entry, "process.exit(1)");
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
    await fs.unlink(layout.entry);
    await expectFailure(() => verifyStagedPackage(layout.workdir, layout.version));
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
  test("unsupported actions have no effects", async () => {
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
    expect(updater.getChannel()).toBe("stable");
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
    await updater.installUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "install-blocked", blockers });
    expect(events).toEqual(["refresh", "snapshot"]);
    blockers = [];
    events.length = 0;
    await updater.installUpdate();
    expect(updater.getStatus()).toMatchObject({ type: "error", phase: "install" });
    expect(events).toEqual(["refresh", "snapshot"]);
    activationFails = false;
    events.length = 0;
    await Promise.all([updater.installUpdate(), updater.installUpdate()]);
    expect(events).toEqual(["refresh", "snapshot", "activate", "restart"]);
  });
  test("shutdown aborts a pending stage and waits for it to settle", async () => {
    const { layout } = await fixture();
    let observed: AbortSignal | undefined;
    const updater = new ServerUpdater({ supported: true, layout }, undefined, {
      collectBlockers: () => [],
      restart: () => Promise.resolve(),
      fetchDistTags: () => Promise.resolve({ next: "2.0.0" }),
      runInstall: (_layout, _version, _install, signal) =>
        new Promise((_resolve, reject) => {
          observed = signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
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
