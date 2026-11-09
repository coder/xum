// Runs the commands that the Makefile and setup-xum's action.yml put around the CI download
// scripts, with stubs for the programs they call, so a dropped flag or a changed order shows up
// as different behavior: an exit 64 (an answer no retry changes) must end the retries at once,
// the other failures must be retried, and the Electron zip's directory must reach electron-builder.
// A stub `sleep` first on PATH makes every wait instant, and each stub that can fail succeeds on
// its last scripted run, so a command that retries too often ends instead of waiting for its budget.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/ci/wiring.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appBuilderPath } from "app-builder-bin";
import { parse } from "yaml";
import { runScript, writeExecutable, type RunResult } from "./runScript";

const REPO = path.resolve(import.meta.dir, "../..");
const ACTION = path.join(REPO, ".github/actions/setup-xum/action.yml");
const WORKFLOWS = path.join(REPO, ".github/workflows");

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "wiring-"));
  await writeExecutable(path.join(work, "sleep"), "true");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// A program that records each run in `<name>.runs` and exits with the next status of `exits`
// (0 after the list ends).
async function stub(name: string, exits: number[], extra = ""): Promise<string> {
  const file = path.join(work, name);
  await writeExecutable(
    file,
    `echo "$*" >> "${file}.runs"
n=$(wc -l < "${file}.runs")
${extra}
exits=(${exits.join(" ")})
exit "\${exits[$((n - 1))]:-0}"`
  );
  return file;
}

async function runs(name: string): Promise<string[]> {
  const text = await readFile(path.join(work, `${name}.runs`), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${work}:${process.env.PATH ?? ""}`, ...extra };
}

interface ActionStep {
  name?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
}

async function setupActionSteps(): Promise<ActionStep[]> {
  const action = parse(await readFile(ACTION, "utf8")) as { runs: { steps: ActionStep[] } };
  return action.runs.steps;
}

async function setupStep(name: string): Promise<string> {
  const step = (await setupActionSteps()).find((candidate) => candidate.name === name);
  if (step?.run === undefined) throw new Error(`setup-xum has no run step named "${name}"`);
  return step.run;
}

function runStep(script: string, extra: Record<string, string> = {}): Promise<RunResult> {
  return runScript(["bash", "-eo", "pipefail", "-c", script], { cwd: REPO, env: env(extra) });
}

describe("make tree-sitter-grammars", () => {
  function grammars(python: string): Promise<RunResult> {
    return runScript(["make", "tree-sitter-grammars", `CRAP_PYTHON=${python}`], {
      cwd: REPO,
      env: env(),
    });
  }

  test("stops at once on exit 64, the answer no retry changes", async () => {
    const result = await grammars(await stub("python", [64]));
    expect(result.exitCode).not.toBe(0);
    expect(await runs("python")).toHaveLength(1);
  });

  test("retries any other failure", async () => {
    const result = await grammars(await stub("python", [1, 1]));
    expect(result.exitCode).toBe(0);
    expect(await runs("python")).toHaveLength(3);
  });
});

describe("make dist-linux", () => {
  // `-o build` leaves the build alone: the recipe under test is the electron-builder call.
  function distLinux(extra: Record<string, string>): Promise<RunResult> {
    return runScript(["make", "dist-linux", "-o", "build"], { cwd: REPO, env: env(extra) });
  }

  test("hands electron-builder the directory of the verified Electron zip", async () => {
    await stub("bun", []);
    const result = await distLinux({ ELECTRON_ZIP_DIR: "/zips/abc" });
    expect(result.exitCode).toBe(0);
    expect(await runs("bun")).toEqual([
      "x electron-builder --linux --publish never -c.electronDist=/zips/abc",
    ]);
  });

  test("lets electron-builder download Electron where no zip directory is set", async () => {
    await stub("bun", []);
    const result = await distLinux({ ELECTRON_ZIP_DIR: "" });
    expect(result.exitCode).toBe(0);
    expect((await runs("bun"))[0]).not.toContain("electronDist");
  });
});

describe("setup-xum: Download Electron zip", () => {
  test("stops at once on exit 64, a version that has no release", async () => {
    await stub("node", [64]);
    const result = await runStep(await setupStep("Download Electron zip"));
    expect(result.exitCode).not.toBe(0);
    expect(await runs("node")).toHaveLength(1);
  });

  test("retries any other failure", async () => {
    await stub("node", [1, 1]);
    const result = await runStep(await setupStep("Download Electron zip"));
    expect(result.exitCode).toBe(0);
    expect(await runs("node")).toHaveLength(3);
  });
});

describe("setup-xum: Point Electron downloads at their own cache", () => {
  async function point(
    env: Record<string, string>,
    cygpath?: string
  ): Promise<{ result: RunResult; lines: string[] }> {
    // The host's own platform and arch, as `node -p` prints them.
    await stub("node", [], "echo darwin-arm64");
    if (cygpath !== undefined) {
      await writeExecutable(path.join(work, "cygpath"), `echo ${cygpath}`);
    }
    const githubEnv = path.join(work, "github-env");
    await writeFile(githubEnv, "");
    const result = await runStep(await setupStep("Point Electron downloads at their own cache"), {
      HOME: "/home/ci",
      GITHUB_ENV: githubEnv,
      ...env,
    });
    const lines = (await readFile(githubEnv, "utf8")).split("\n").filter((line) => line !== "");
    return { result, lines };
  }

  test("names the host's zip when the caller names none", async () => {
    const { result, lines } = await point({ TARGETS_INPUT: "" });
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual([
      "electron_config_cache=/home/ci/.cache/xum-electron-zip",
      "ELECTRON_ZIP_TARGETS=darwin-arm64",
      "ELECTRON_ZIP_SLUG=darwin-arm64",
    ]);
  });

  test("passes the caller's targets on, and keys the cache by them", async () => {
    const { lines } = await point({ TARGETS_INPUT: "darwin-x64 darwin-arm64" });
    expect(lines).toContain("ELECTRON_ZIP_TARGETS=darwin-x64 darwin-arm64");
    expect(lines).toContain("ELECTRON_ZIP_SLUG=darwin-x64_darwin-arm64");
  });

  test("gives node a Windows path where cygpath exists (MSYS paths read as C:\\c\\Users\\...)", async () => {
    const { lines } = await point({ TARGETS_INPUT: "" }, "C:/Users/runneradmin");
    expect(lines[0]).toBe("electron_config_cache=C:/Users/runneradmin/.cache/xum-electron-zip");
  });
});

describe("setup-xum: Download Electron zip targets", () => {
  test("fetches the targets the job asked for, and the host's zip when it asked for none", async () => {
    await stub("node", []);
    const step = await setupStep("Download Electron zip");
    await runStep(step, { ELECTRON_ZIP_TARGETS: "darwin-x64 darwin-arm64" });
    await runStep(step, { ELECTRON_ZIP_TARGETS: "" });
    expect(await runs("node")).toEqual([
      "scripts/ci/prefetch-electron-zip.cjs darwin-x64 darwin-arm64",
      "scripts/ci/prefetch-electron-zip.cjs",
    ]);
  });
});

describe("setup-xum: Locate Electron zip", () => {
  const dir = () => path.join(work, "zips", "abc");

  // Each target has a zip in `dir()` (a file unless `missing` names it). The stub prints what the
  // real prefetch prints, on the run that succeeds only.
  async function locate(
    options: {
      targets?: string[];
      missing?: string[];
      exits?: number[];
      silent?: boolean;
      noDir?: boolean;
    } = {}
  ): Promise<{ result: RunResult; githubEnv: string }> {
    const {
      targets = ["linux-x64"],
      missing = [],
      exits = [],
      silent = false,
      noDir = false,
    } = options;
    const zips = targets.map((target) => path.join(dir(), `electron-v1.2.3-${target}.zip`));
    await mkdir(dir(), { recursive: true });
    for (const [index, zip] of zips.entries()) {
      if (!missing.includes(targets[index])) await writeFile(zip, "zip");
    }
    const lines = zips.map((zip) => `echo "Electron zip ready: ${zip}"`);
    const dirLine = noDir ? [] : [`echo "Electron zip dir: ${dir()}"`];
    const printed = silent ? [] : [...lines, ...dirLine];
    const onSuccess = printed.length === 0 ? "true" : printed.join("; ");
    await stub("node", exits, `[ "$n" = ${exits.length + 1} ] && { ${onSuccess}; true; }`);
    const githubEnv = path.join(work, "github-env");
    await writeFile(githubEnv, "");
    const result = await runStep(await setupStep("Locate Electron zip"), {
      GITHUB_ENV: githubEnv,
      ELECTRON_ZIP_TARGETS: targets.join(" "),
      TMPDIR: work,
    });
    return { result, githubEnv: await readFile(githubEnv, "utf8") };
  }

  test("exports the directory of the zip for electron-builder", async () => {
    const { result, githubEnv } = await locate();
    expect(result.exitCode).toBe(0);
    expect(githubEnv).toBe(`ELECTRON_ZIP_DIR=${dir()}\n`);
  });

  test("asks for every target the job named, and exports their one directory", async () => {
    const targets = ["darwin-x64", "darwin-arm64"];
    const { result, githubEnv } = await locate({ targets });
    expect(result.exitCode).toBe(0);
    expect(await runs("node")).toEqual([
      `scripts/ci/prefetch-electron-zip.cjs ${targets.join(" ")}`,
    ]);
    expect(githubEnv).toBe(`ELECTRON_ZIP_DIR=${dir()}\n`);
  });

  test("fails when a zip is not where the prefetch said", async () => {
    const { result, githubEnv } = await locate({
      targets: ["darwin-x64", "darwin-arm64"],
      missing: ["darwin-arm64"],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("electron-v1.2.3-darwin-arm64.zip");
    expect(githubEnv).toBe("");
  });

  test("fails when the prefetch names no zip", async () => {
    const { result, githubEnv } = await locate({ silent: true });
    expect(result.exitCode).not.toBe(0);
    expect(githubEnv).toBe("");
  });

  test("fails when the prefetch names zips but no directory", async () => {
    const { result, githubEnv } = await locate({ noDir: true });
    expect(result.exitCode).not.toBe(0);
    expect(githubEnv).toBe("");
  });

  test("retries a failed prefetch, as the download step does", async () => {
    const { result, githubEnv } = await locate({ exits: [1] });
    expect(result.exitCode).toBe(0);
    expect(await runs("node")).toHaveLength(2);
    expect(githubEnv).toBe(`ELECTRON_ZIP_DIR=${dir()}\n`);
  });

  test("leaves the retries' output in the log when the prefetch fails", async () => {
    const { result, githubEnv } = await locate({ exits: [64] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::group::Attempt 1");
    expect(result.stdout).toContain("::error::Attempt 1 failed with exit 64");
    expect(githubEnv).toBe("");
  });
});

// The scripts above only run when the workflow calls them. These checks pin the calls: a
// dropped input or an inverted condition turns the Electron zip steps off or on silently, and the
// build then falls back to app-builder's own download, which retries nothing.
describe("the Electron zip wiring", () => {
  // The exact `if` of each step, which a test of "contains the gate" would let drift: a step that
  // loses its cache-hit clause downloads on every hit, and an `|| true` runs it for every job.
  const GATE = "${{ inputs.electron-zip == 'true' }}";
  const GATE_ON_MISS =
    "${{ inputs.electron-zip == 'true' && steps.cache-electron-zip.outputs.cache-hit != 'true' }}";

  test("setup-xum runs every Electron zip step only when the caller asks, and the download only on a miss", async () => {
    const steps = (await setupActionSteps()).filter((step) =>
      /Electron zip|Point Electron downloads/.test(step.name ?? "")
    );
    expect(steps.map((step) => [step.name, step.if])).toEqual([
      ["Point Electron downloads at their own cache", GATE],
      ["Restore Electron zip", GATE],
      ["Download Electron zip", GATE_ON_MISS],
      ["Save Electron zip", GATE_ON_MISS],
      ["Locate Electron zip", GATE],
    ]);
  });

  test("the cache key names the zips, so jobs that need other zips do not share an entry", async () => {
    const restore = (await setupActionSteps()).find((step) => step.name === "Restore Electron zip");
    expect(restore?.with?.key).toContain("${{ env.ELECTRON_ZIP_SLUG }}");
  });

  interface Job {
    name?: string;
    steps: { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }[];
  }

  async function jobsWithElectronBuilder(): Promise<Map<string, Job>> {
    const found = new Map<string, Job>();
    for (const file of (await readdir(WORKFLOWS)).filter((name) => name.endsWith(".yml"))) {
      const workflow = parse(await readFile(path.join(WORKFLOWS, file), "utf8")) as {
        jobs?: Record<string, Job>;
      };
      for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
        if (
          job.steps?.some((step) => /bun x electron-builder|make\s+"?dist/.test(step.run ?? ""))
        ) {
          found.set(`${file}#${id}`, job);
        }
      }
    }
    return found;
  }

  // Every job that builds with electron-builder, and the zips it needs: the zip of each arch it
  // builds. electron-builder looks for an unpacked Electron in the directory when a zip is not
  // there, so a missing arch fails the build instead of downloading. No entry: this runner's own.
  const ELECTRON_BUILDS: Record<string, string | undefined> = {
    "pr.yml#build-linux": undefined,
    "pr.yml#build-macos": "darwin-${{ matrix.arch }}",
    "pr.yml#build-windows": "win32-x64",
    "_desktop-release.yml#build-macos": "darwin-x64 darwin-arm64",
    "_desktop-release.yml#build-linux": "linux-x64",
    "_desktop-release.yml#build-linux-arm64": "linux-arm64",
    "_desktop-release.yml#build-windows": "win32-x64",
  };

  test("every job that builds with electron-builder is in the table below", async () => {
    const jobs = await jobsWithElectronBuilder();
    expect([...jobs.keys()].sort()).toEqual(Object.keys(ELECTRON_BUILDS).sort());
  });

  test.each(Object.entries(ELECTRON_BUILDS))(
    "%s unpacks the checked zips of its arches (%s)",
    async (key, targets) => {
      const job = (await jobsWithElectronBuilder()).get(key);
      expect(job).toBeDefined();
      const setup = job?.steps.filter((step) => step.uses === "./.github/actions/setup-xum") ?? [];
      expect(setup).toHaveLength(1);
      expect(setup[0].with?.["electron-zip"]).toBe("true");
      expect(setup[0].with?.["electron-zip-targets"]).toBe(targets);
    }
  );

  // `make dist-*` passes the directory itself (tested below). A step that runs electron-builder
  // directly must pass it, or electron-builder downloads its own zip. Bash expands the flag only
  // when the variable is set. The Windows step runs in PowerShell, which builds the argument first.
  const BASH_FLAG = '${ELECTRON_ZIP_DIR:+-c.electronDist="$ELECTRON_ZIP_DIR"}';
  const DIRECT_CALLS: Record<string, string[]> = {
    "_desktop-release.yml#build-linux": [
      `bun x electron-builder --linux --publish always ${BASH_FLAG}`,
    ],
    "_desktop-release.yml#build-linux-arm64": [
      `bun x electron-builder --linux --arm64 --publish never ${BASH_FLAG}`,
    ],
    "_desktop-release.yml#build-windows": [
      '$extra = @("-c.electronDist=$env:ELECTRON_ZIP_DIR")',
      "bun x electron-builder --win --publish always @extra",
    ],
  };

  test("a step that runs electron-builder directly hands it the zip directory", async () => {
    const direct = new Map<string, string>();
    for (const [key, job] of await jobsWithElectronBuilder()) {
      for (const step of job.steps) {
        if (step.run?.includes("bun x electron-builder")) direct.set(key, step.run);
      }
    }
    expect([...direct.keys()].sort()).toEqual(Object.keys(DIRECT_CALLS).sort());
    for (const [key, run] of direct) {
      const lines = run.split("\n").map((line) => line.trim());
      for (const expected of DIRECT_CALLS[key]) {
        expect(lines.some((line) => line.includes(expected))).toBe(true);
      }
    }
  });
});

describe("make dist-*: the zip directory reaches every electron-builder call", () => {
  // `make -n` prints the recipe without running it. -o build leaves the build alone.
  async function electronBuilderLines(target: string, zipDir: string): Promise<string[]> {
    const result = await runScript(["make", "-n", target, "-o", "build"], {
      cwd: REPO,
      env: env({ ELECTRON_ZIP_DIR: zipDir }),
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.split("\n").filter((line) => line.includes("bun x electron-builder"));
  }

  const TARGETS: [string, number][] = [
    ["dist-mac", 3],
    ["dist-mac-x64", 1],
    ["dist-mac-arm64", 1],
    ["dist-win", 1],
    ["dist-linux", 1],
    ["dist-linux-arm64", 1],
  ];

  test.each(TARGETS)("%s hands every call (%d) the zip directory", async (target, calls) => {
    const lines = await electronBuilderLines(target, "/zips/abc");
    expect(lines).toHaveLength(calls);
    for (const line of lines) {
      expect(line).toMatch(/-c\.electronDist="?\/zips\/abc"?(\s|;|&|$)/);
    }
  });

  test.each(TARGETS)(
    "%s leaves electron-builder to download where no directory is set",
    async (target) => {
      for (const line of await electronBuilderLines(target, "")) {
        expect(line).not.toContain("electronDist");
      }
    }
  );
});

// scripts/ci/prefetch-appimage-tool.sh only runs when the workflow calls it, and it only helps
// while it fetches what app-builder asks for. These checks pin the call, and the pin: an
// electron-builder bump that moves app-builder to another AppImage tool would leave the cache
// holding a tool that app-builder never reads, and Build / Linux would download the new one with no retry.
describe("the AppImage tool wiring", () => {
  test("setup-xum fetches the tool only when the caller asks, after it restores the electron-builder cache", async () => {
    const steps = await setupActionSteps();
    const names = steps.map((step) => step.name);
    const fetchTool = steps.find((step) => step.name === "Fetch the AppImage tool");

    expect(fetchTool?.if).toContain("inputs.appimage-tool == 'true'");
    expect(fetchTool?.run).toBe("./scripts/ci/prefetch-appimage-tool.sh");
    expect(names.indexOf("Fetch the AppImage tool")).toBeGreaterThan(
      names.indexOf("Cache electron-builder")
    );
  });

  test("AppImage callers key the electron-builder cache apart from the other jobs, on the script too", async () => {
    // A cache saves only on an exact miss, and a job that needs no tool finishes first: with one
    // shared key it would save the entry without the tool, and every AppImage job would hit it.
    const action = parse(await readFile(ACTION, "utf8")) as {
      runs: { steps: { name?: string; with?: { key?: string } }[] };
    };
    const key = action.runs.steps.find((step) => step.name === "Cache electron-builder")?.with?.key;

    expect(key).toContain("inputs.appimage-tool == 'true'");
    // Two hashes: the AppImage callers' (lockfiles and the script) and everyone else's (lockfiles).
    expect(key?.match(/hashFiles\(([^)]*)\)/g)).toEqual([
      expect.stringContaining("scripts/ci/prefetch-appimage-tool.sh"),
      expect.not.stringContaining("scripts/ci/prefetch-appimage-tool.sh"),
    ]);
  });

  test("Build / Linux asks setup-xum for the tool", async () => {
    const workflow = parse(await readFile(path.join(WORKFLOWS, "pr.yml"), "utf8")) as {
      jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown> }[] }>;
    };
    const setup = workflow.jobs["build-linux"]?.steps.filter(
      (step) => step.uses === "./.github/actions/setup-xum"
    );

    expect(setup).toHaveLength(1);
    expect(setup?.[0]?.with?.["appimage-tool"]).toBe("true");
  });

  test("app-builder asks for the version and the archive that the script pins", async () => {
    const script = await readFile(path.join(REPO, "scripts/ci/prefetch-appimage-tool.sh"), "utf8");
    const version = /^version=(appimage-[\d.]+)$/m.exec(script)?.[1];
    // The archive's sha512 (base64) as the script's comment records it. app-builder holds the
    // same string for the archive it downloads.
    const sha512 = /^#\s+([A-Za-z0-9+/]{86}==)$/m.exec(script)?.[1];
    expect(version).toBeDefined();
    expect(sha512).toBeDefined();

    const binary = await readFile(appBuilderPath, "latin1");

    expect(binary).toContain(version ?? "");
    expect(binary).toContain(sha512 ?? "");
  });
});
