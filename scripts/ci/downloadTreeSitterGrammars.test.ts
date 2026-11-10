// Tests for scripts/ci/download_tree_sitter_grammars.py. A stub tree_sitter_language_pack on
// PYTHONPATH stands in for the pack: it writes a manifest, a bundle and "libraries" into the
// pack's directory (offline when a manifest and bundle are already there) and fails the way
// the real pack does when its GitHub release answers an HTTP error ("Download error: Failed to
// fetch manifest from <url>: http status: 504"). The pins are real in the script, so a harness
// calls the script's run() with pins for the stub's bytes.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/downloadTreeSitterGrammars.test.ts
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SPAWNING_TEST_TIMEOUT_MS, runScript, type RunResult } from "./runScript";

const SCRIPT_DIR = import.meta.dir;
const PLATFORM = "linux-x86_64";
const MANIFEST_BYTES = "manifest bytes";
const BUNDLE_BYTES = "bundle bytes";
const LANGUAGES = "typescript,tsx,javascript";

// `cache_dir()` of the real pack is <cache>/tree-sitter-language-pack/<version>/libs.
const STUB = `import os
import pathlib
import shutil


class DownloadError(Exception):
    pass


def cache_dir():
    layout = os.environ.get("STUB_LAYOUT", "tree-sitter-language-pack")
    return os.path.join(os.environ["STUB_PACK_HOME"], layout, "v1", "libs")


def download(names):
    root = pathlib.Path(cache_dir()).parent
    bundles = list((root / "bundles").glob("*.tar.zst"))
    offline = (root / "manifest.json").is_file() and bundles
    with open(os.environ["STUB_CALLS"], "a") as calls:
        calls.write(("offline:" if offline else "network:") + ",".join(names) + "\\n")
    if not offline:
        if os.environ.get("STUB_ERROR"):
            raise DownloadError(os.environ["STUB_ERROR"])
        release = pathlib.Path(os.environ["STUB_RELEASE"])
        (root / "bundles").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(release / "manifest.json", root / "manifest.json")
        shutil.copyfile(release / "bundle", root / "bundles" / os.environ["STUB_BUNDLE_NAME"])
    (root / "libs").mkdir(exist_ok=True)
    for name in names:
        (root / "libs" / f"libtree_sitter_{name}.so").write_text("from the bundle")
`;

const HARNESS = `import json
import os
import platform
import sys
from pathlib import Path

sys.path.insert(0, os.environ["SCRIPT_DIR"])
import download_tree_sitter_grammars as m

mode = os.environ["HARNESS_MODE"]
if mode == "run":
    pins = m.Pins(**json.loads(os.environ["PINS_JSON"]))
    stage = os.environ.get("STAGE")
    sys.exit(m.run(pins, os.environ["PLATFORM"], Path(stage) if stage else None))
platform.system = lambda: os.environ["FAKE_SYSTEM"]
platform.machine = lambda: os.environ["FAKE_MACHINE"]
if mode == "platform":
    print(m.platform_key())
elif mode == "main":
    sys.exit(m.main())
elif mode == "pins":
    print(json.dumps({"release": m.RELEASE, "pins": m.PINS.__dict__}))
`;

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const BUNDLE_NAME = `${PLATFORM}-${sha256(BUNDLE_BYTES)}.tar.zst`;

let work: string;

const dirs = {
  get stage() {
    return path.join(work, "stage");
  },
  get packRoot() {
    return path.join(work, "home", "tree-sitter-language-pack", "v1");
  },
  get calls() {
    return path.join(work, "calls");
  },
};

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "grammars-"));
  await writeFile(path.join(work, "tree_sitter_language_pack.py"), STUB);
  await writeFile(path.join(work, "harness.py"), HARNESS);
  await mkdir(path.join(work, "release"));
  await writeFile(path.join(work, "release", "manifest.json"), MANIFEST_BYTES);
  await writeFile(path.join(work, "release", "bundle"), BUNDLE_BYTES);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

function harness(mode: string, env: Record<string, string>): Promise<RunResult> {
  return runScript(["python3", path.join(work, "harness.py")], {
    cwd: work,
    env: {
      PYTHONPATH: work,
      PYTHONDONTWRITEBYTECODE: "1",
      SCRIPT_DIR,
      HARNESS_MODE: mode,
      STUB_CALLS: dirs.calls,
      STUB_PACK_HOME: path.join(work, "home"),
      STUB_RELEASE: path.join(work, "release"),
      STUB_BUNDLE_NAME: BUNDLE_NAME,
      STUB_ERROR: "",
      // A stage directory only where a test asks for one: CI sets this variable.
      GRAMMAR_STAGE_DIR: "",
      ...env,
    },
  });
}

// run() with pins for the stub's release bytes, unless a test passes other pins.
function download(
  options: { error?: string; pins?: { manifest: string; bundle: string }; stage?: boolean } = {}
): Promise<RunResult> {
  const pins = options.pins ?? { manifest: MANIFEST_BYTES, bundle: BUNDLE_BYTES };
  return harness("run", {
    STUB_ERROR: options.error ?? "",
    PLATFORM,
    STAGE: options.stage === false ? "" : dirs.stage,
    PINS_JSON: JSON.stringify({
      release: "v1",
      manifest_sha256: sha256(pins.manifest),
      bundle_sha256: { [PLATFORM]: sha256(pins.bundle) },
    }),
  });
}

async function stageListing(): Promise<string[]> {
  const entries = await readdir(dirs.stage, { recursive: true }).catch(() => []);
  return entries.map(String).sort();
}

async function packCalls(): Promise<string[]> {
  const calls = await readFile(dirs.calls, "utf8").catch(() => "");
  return calls.split("\n").filter((line) => line !== "");
}

const STAGE_FILES = ["bundles", `bundles/${BUNDLE_NAME}`, "manifest.json"];

function releaseError(status: number): string {
  return `Download error: Failed to fetch manifest from https://github.com/x/y/releases/download/v1/parsers.json: http status: ${status}`;
}

describe.skipIf(Bun.which("python3") === null)("download_tree_sitter_grammars.py", () => {
  test("a cold cache downloads, checks the pins and stages exactly the two pinned files", async () => {
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await packCalls()).toEqual([`network:${LANGUAGES}`]);
    expect(await stageListing()).toEqual(STAGE_FILES);
    expect(await readFile(path.join(dirs.stage, "manifest.json"), "utf8")).toBe(MANIFEST_BYTES);
    expect(result.stderr).not.toContain("::warning::");
  });

  test("a verified stage is a hit: the pack extracts from it and the network is never used", async () => {
    await download();
    // A network attempt would now fail: the stub raises only when it has to download.
    const result = await download({ error: releaseError(504) });
    expect(result.exitCode).toBe(0);
    expect(await packCalls()).toEqual([`network:${LANGUAGES}`, `offline:${LANGUAGES}`]);
    expect(result.stderr).not.toContain("::warning::");
  });

  test.each([
    ["bundle", `bundles/${BUNDLE_NAME}`],
    ["manifest", "manifest.json"],
  ])(
    "a stage with a tampered %s is discarded: the files are downloaded and the stage is rebuilt",
    async (_name, file) => {
      await download();
      await writeFile(path.join(dirs.stage, file), "planted bytes");
      const result = await download();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("::warning::");
      expect(await packCalls()).toEqual([`network:${LANGUAGES}`, `network:${LANGUAGES}`]);
      expect(await readFile(path.join(dirs.stage, file), "utf8")).toBe(
        file === "manifest.json" ? MANIFEST_BYTES : BUNDLE_BYTES
      );
      expect(await stageListing()).toEqual(STAGE_FILES);
    }
  );

  test("a stage that lacks the bundle is a miss, and extra files in it are not carried on", async () => {
    await mkdir(path.join(dirs.stage, "bundles"), { recursive: true });
    await writeFile(path.join(dirs.stage, "manifest.json"), MANIFEST_BYTES);
    await writeFile(path.join(dirs.stage, "planted.so"), "planted bytes");
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await packCalls()).toEqual([`network:${LANGUAGES}`]);
    expect(await stageListing()).toEqual(STAGE_FILES);
  });

  test("a verified stage that also holds extra files: only the two pinned files reach the pack's directory", async () => {
    await download();
    await mkdir(path.join(dirs.stage, "libs"), { recursive: true });
    await writeFile(path.join(dirs.stage, "libs", "libtree_sitter_evil.so"), "planted bytes");
    await writeFile(path.join(dirs.stage, "evil.so"), "planted bytes");
    // A network attempt would fail: the extras must not make the stage a miss, and must not
    // be copied either.
    const result = await download({ error: releaseError(504) });
    expect(result.exitCode).toBe(0);
    expect(await packCalls()).toEqual([`network:${LANGUAGES}`, `offline:${LANGUAGES}`]);
    expect(existsSync(path.join(dirs.packRoot, "libs", "libtree_sitter_evil.so"))).toBe(false);
    expect(existsSync(path.join(dirs.packRoot, "evil.so"))).toBe(false);
  });

  test("files that another cache planted in the pack's directory are deleted, never loaded", async () => {
    await download();
    const libs = path.join(dirs.packRoot, "libs");
    await writeFile(path.join(libs, "libtree_sitter_tsx.so"), "planted bytes");
    await writeFile(path.join(libs, "libtree_sitter_evil.so"), "planted bytes");
    await writeFile(path.join(dirs.packRoot, "planted.json"), "planted bytes");
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(libs, "libtree_sitter_tsx.so"), "utf8")).toBe(
      "from the bundle"
    );
    expect(existsSync(path.join(libs, "libtree_sitter_evil.so"))).toBe(false);
    expect(existsSync(path.join(dirs.packRoot, "planted.json"))).toBe(false);
  });

  test.each([
    ["a symlink to a directory", "dir"],
    ["a plain file", "file"],
  ])("%s planted in the stage's place is replaced by the stage", async (_name, kind) => {
    const victim = path.join(work, "victim");
    await mkdir(victim);
    if (kind === "dir") {
      await symlink(victim, dirs.stage);
    } else {
      await writeFile(dirs.stage, "planted bytes");
    }
    const result = await download();
    expect(result.exitCode).toBe(0);
    expect(await stageListing()).toEqual(STAGE_FILES);
    expect(await readdir(victim)).toEqual([]);
  });

  describe("a local run, with no stage directory", () => {
    test("downloads and checks the pins, but wipes nothing and writes no stage", async () => {
      await mkdir(dirs.packRoot, { recursive: true });
      const planted = path.join(dirs.packRoot, "planted.json");
      await writeFile(planted, "kept");
      const result = await download({ stage: false });
      expect(result.exitCode).toBe(0);
      expect(await packCalls()).toEqual([`network:${LANGUAGES}`]);
      expect(await readFile(planted, "utf8")).toBe("kept");
      expect(existsSync(dirs.stage)).toBe(false);
    });

    test("still fails closed with 64 on a download that does not match the pins", async () => {
      const result = await download({
        stage: false,
        pins: { manifest: MANIFEST_BYTES, bundle: "other bundle" },
      });
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("does not match the pinned sha256");
    });
  });

  test("a download that does not match the pins fails closed with 64 and stages nothing", async () => {
    const result = await download({ pins: { manifest: MANIFEST_BYTES, bundle: "other bundle" } });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain("does not match the pinned sha256");
    expect(existsSync(dirs.stage)).toBe(false);

    const manifest = await download({ pins: { manifest: "other manifest", bundle: BUNDLE_BYTES } });
    expect(manifest.exitCode).toBe(64);
    expect(existsSync(dirs.stage)).toBe(false);
  });

  test("refuses a pack directory of another layout, and deletes nothing", async () => {
    const sentinel = path.join(work, "home", "odd", "v1", "keep.txt");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "keep");
    const result = await harness("run", {
      STUB_LAYOUT: "odd",
      PLATFORM,
      STAGE: dirs.stage,
      PINS_JSON: JSON.stringify({ release: "v1", manifest_sha256: "x", bundle_sha256: {} }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unexpected tree-sitter-language-pack cache directory");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("exits 64 on an HTTP 4xx that no retry changes, so retry.sh stops at once", async () => {
    for (const status of [400, 403, 404, 410]) {
      const result = await download({ error: releaseError(status) });
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain(`http status: ${status}`);
    }
  });

  test("exits 1 on a failure a retry can fix", async () => {
    for (const status of [408, 429, 500, 503, 504]) {
      expect((await download({ error: releaseError(status) })).exitCode).toBe(1);
    }
    expect((await download({ error: "Download error: connection reset by peer" })).exitCode).toBe(
      1
    );
  });

  describe("platforms", () => {
    const KEYS: [string, string, string | null][] = [
      ["Linux", "x86_64", "linux-x86_64"],
      ["Linux", "aarch64", "linux-aarch64"],
      ["Linux", "arm64", "linux-aarch64"],
      ["Darwin", "arm64", "macos-arm64"],
      ["Darwin", "x86_64", "macos-x86_64"],
      ["Windows", "AMD64", "windows-x86_64"],
      ["Windows", "ARM64", "windows-aarch64"],
      ["Linux", "riscv64", null],
      ["FreeBSD", "x86_64", null],
    ];

    test.each(KEYS)("%s %s is %s", async (system, machine, key) => {
      const result = await harness("platform", { FAKE_SYSTEM: system, FAKE_MACHINE: machine });
      expect(result.stdout.trim()).toBe(key ?? "None");
    });

    test("the keys that platform_key returns are exactly the pinned platforms", async () => {
      const named = new Set(KEYS.map(([, , key]) => key).filter((key) => key !== null));
      const result = await harness("pins", { FAKE_SYSTEM: "Linux", FAKE_MACHINE: "x86_64" });
      const { pins } = JSON.parse(result.stdout) as {
        pins: { bundle_sha256: Record<string, string> };
      };
      expect(new Set(Object.keys(pins.bundle_sha256))).toEqual(named);
    });

    test("main() takes the stage directory from GRAMMAR_STAGE_DIR, and uses none without it", async () => {
      // The stub fails its download, so the run ends with exit 1 right after the part that
      // differs: a stage directory makes the script wipe the pack's directory first.
      const env = {
        FAKE_SYSTEM: "Linux",
        FAKE_MACHINE: "x86_64",
        STUB_ERROR: "Download error: connection reset by peer",
      };
      await mkdir(dirs.packRoot, { recursive: true });
      const planted = path.join(dirs.packRoot, "planted.json");
      await writeFile(planted, "planted bytes");

      const local = await harness("main", env);
      expect(local.exitCode).toBe(1);
      expect(existsSync(planted)).toBe(true);

      const ci = await harness("main", { ...env, GRAMMAR_STAGE_DIR: dirs.stage });
      expect(ci.exitCode).toBe(1);
      expect(existsSync(planted)).toBe(false);
    });

    test("a platform without a pin exits 2 before the pack is touched", async () => {
      const result = await harness("main", { FAKE_SYSTEM: "FreeBSD", FAKE_MACHINE: "x86_64" });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("no pinned tree-sitter grammars");
      expect(await packCalls()).toEqual([]);
    });
  });

  describe("the pins", () => {
    test("name the release that pyproject.toml pins, and hold lowercase sha256 digests", async () => {
      const pyproject = await readFile(path.resolve(SCRIPT_DIR, "../../pyproject.toml"), "utf8");
      const version = /"tree-sitter-language-pack==([0-9][0-9.]*)"/.exec(pyproject)?.[1];
      expect(version).toBeDefined();
      const result = await harness("pins", { FAKE_SYSTEM: "Linux", FAKE_MACHINE: "x86_64" });
      const { release, pins } = JSON.parse(result.stdout) as {
        release: string;
        pins: { release: string; manifest_sha256: string; bundle_sha256: Record<string, string> };
      };
      expect(release).toBe(`v${version}`);
      expect(pins.release).toBe(release);
      for (const digest of [pins.manifest_sha256, ...Object.values(pins.bundle_sha256)]) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
