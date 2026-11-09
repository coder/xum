// Runs the commands that the Makefile and setup-xum's action.yml put around the CI download
// scripts, with stubs for the programs they call, so a dropped flag or a changed order shows up
// as different behavior: an exit 64 (an answer no retry changes) must end the retries at once,
// the other failures must be retried, and the Electron zip's directory must reach electron-builder.
// A stub `sleep` first on PATH makes every wait instant, and each stub that can fail succeeds on
// its last scripted run, so a command that retries too often ends instead of waiting for its budget.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally: bun test ./scripts/ci/wiring.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appBuilderPath } from "app-builder-bin";
import { parse } from "yaml";
import { runScript, writeExecutable, type RunResult } from "./runScript";

const REPO = path.resolve(import.meta.dir, "../..");
const ACTION = path.join(REPO, ".github/actions/setup-xum/action.yml");
const PR_WORKFLOW = path.join(REPO, ".github/workflows/pr.yml");

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

async function setupActionSteps(): Promise<{ name?: string; if?: string; run?: string }[]> {
  const action = parse(await readFile(ACTION, "utf8")) as {
    runs: { steps: { name?: string; if?: string; run?: string }[] };
  };
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

describe("setup-xum: Locate Electron zip", () => {
  async function locate(
    zipExists: boolean,
    exits: number[] = []
  ): Promise<{ result: RunResult; githubEnv: string }> {
    const zip = path.join(work, "zips", "abc", "electron-v1.2.3-linux-x64.zip");
    if (zipExists) {
      await mkdir(path.dirname(zip), { recursive: true });
      await writeFile(zip, "zip");
    }
    // Only the run that succeeds finds the zip.
    await stub(
      "node",
      exits,
      `[ "$n" = ${exits.length + 1} ] && echo "Electron zip ready: ${zip}"`
    );
    const githubEnv = path.join(work, "github-env");
    await writeFile(githubEnv, "");
    const result = await runStep(await setupStep("Locate Electron zip"), { GITHUB_ENV: githubEnv });
    return { result, githubEnv: await readFile(githubEnv, "utf8") };
  }

  test("exports the directory of the zip for make dist-linux", async () => {
    const { result, githubEnv } = await locate(true);
    expect(result.exitCode).toBe(0);
    expect(githubEnv).toBe(`ELECTRON_ZIP_DIR=${path.join(work, "zips", "abc")}\n`);
  });

  test("fails when the zip is not where the prefetch said", async () => {
    const { result, githubEnv } = await locate(false);
    expect(result.exitCode).not.toBe(0);
    expect(githubEnv).toBe("");
  });

  test("retries a failed prefetch, as the download step does", async () => {
    const { result, githubEnv } = await locate(true, [1]);
    expect(result.exitCode).toBe(0);
    expect(await runs("node")).toHaveLength(2);
    expect(githubEnv).toBe(`ELECTRON_ZIP_DIR=${path.join(work, "zips", "abc")}\n`);
  });
});

// The scripts above only run when the workflow calls them. These two checks pin the calls:
// a dropped input or an inverted condition turns the Electron zip steps off or on silently, and
// Build / Linux then falls back to app-builder's own download, which retries nothing.
describe("the Electron zip wiring", () => {
  test("setup-xum runs every Electron zip step only when the caller asks for the zip", async () => {
    const steps = (await setupActionSteps()).filter((step) =>
      /Electron zip|Point Electron downloads/.test(step.name ?? "")
    );
    expect(steps.map((step) => step.name)).toEqual([
      "Point Electron downloads at their own cache",
      "Restore Electron zip",
      "Download Electron zip",
      "Save Electron zip",
      "Locate Electron zip",
    ]);
    for (const step of steps) {
      expect(step.if).toContain("inputs.electron-zip == 'true'");
    }
  });

  test("Build / Linux asks setup-xum for the Electron zip", async () => {
    const workflow = parse(await readFile(PR_WORKFLOW, "utf8")) as {
      jobs: Record<
        string,
        { name?: string; steps: { uses?: string; with?: Record<string, unknown> }[] }
      >;
    };
    const job = workflow.jobs["build-linux"];
    expect(job?.name).toBe("Build / Linux");
    const setup = job.steps.filter((step) => step.uses === "./.github/actions/setup-xum");
    expect(setup).toHaveLength(1);
    expect(setup[0].with?.["electron-zip"]).toBe("true");
  });
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

  test("the electron-builder cache key moves with the script, as an exact hit saves nothing", async () => {
    const action = parse(await readFile(ACTION, "utf8")) as {
      runs: { steps: { name?: string; with?: { key?: string } }[] };
    };
    const cache = action.runs.steps.find((step) => step.name === "Cache electron-builder");

    expect(cache?.with?.key).toContain("scripts/ci/prefetch-appimage-tool.sh");
  });

  test("Build / Linux asks setup-xum for the tool", async () => {
    const workflow = parse(await readFile(PR_WORKFLOW, "utf8")) as {
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
