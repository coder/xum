import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import type { ExecStream } from "@/node/runtime/Runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { AvailableArtifactsLocation } from "@/node/services/artifactsOperations";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import { checkArtifactLayout, type ArtifactLayoutInput } from "./checkArtifactLayout";
import {
  installFakeAgentBrowser,
  type FakeAgentBrowser,
  type FakeAgentBrowserScript,
} from "./fakeAgentBrowser.testHarness";

// Every audit spawns shells (a fake CLI run is about a dozen processes); a loaded CI host is slow.
setDefaultTimeout(60_000);

const card: LayoutAuditPageFinding = {
  rule: "clipped-text",
  selector: "div.card > h2",
  axis: "horizontal",
  overflowPx: 12,
};

const execStream = (stdout: string, exitCode: number): ExecStream => ({
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stdout));
      controller.close();
    },
  }),
  stderr: new ReadableStream({ start: (controller) => controller.close() }),
  stdin: new WritableStream(),
  exitCode: Promise.resolve(exitCode),
  duration: Promise.resolve(0),
});

describe("checkArtifactLayout", () => {
  let tempDir: string;
  let artifactsDir: string;
  let sessionDir: string;
  let runtime: LocalRuntime;
  let sessionCounter = 0;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-check-"));
    artifactsDir = path.join(tempDir, "scratch", "artifacts");
    // A fresh session dir per test: the fix-loop memory is keyed by it and outlives a test.
    sessionDir = path.join(tempDir, `session-${sessionCounter++}`);
    await fs.mkdir(artifactsDir, { recursive: true });
    runtime = new LocalRuntime(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const check = (overrides: Partial<ArtifactLayoutInput> = {}) =>
    checkArtifactLayout({
      kind: "html",
      runtime,
      cwd: tempDir,
      trusted: true,
      location: { kind: "host", dir: artifactsDir },
      relPath: "chart.html",
      sessionDir,
      budgetMs: 20_000,
      ...overrides,
    });

  const install = (script: FakeAgentBrowserScript = {}) =>
    installFakeAgentBrowser(tempDir, script);

  const evalCount = async (fake: FakeAgentBrowser) =>
    (await fake.calls()).filter((argv) => argv.includes("eval")).length;

  test("leaves every kind but html alone and never starts a browser", async () => {
    const fake = await install();
    for (const kind of ["markdown", "svg", "json", "image", "canvas"]) {
      expect(await check({ kind })).toBeUndefined();
    }
    expect(await fake.calls()).toEqual([]);
  });

  test("a clean page is checked at all three widths", async () => {
    const fake = await install();
    expect(await check()).toEqual({
      checked: true,
      issues: [],
      note: "No layout issues at 390, 768 and 1440 px.",
    });
    expect(await evalCount(fake)).toBe(3);
    expect(await fake.openedUrls()).toEqual(
      Array(3).fill(pathToFileURL(path.join(artifactsDir, "chart.html")).href)
    );
  });

  test("lists what the page reports and marks it persistent on the next publish", async () => {
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    const first = await check();
    expect(first).toMatchObject({
      checked: true,
      issues: [{ rule: "clipped-text", selector: "div.card > h2", viewport: 390, overflowPx: 12 }],
    });
    expect(first?.issues[0]).not.toHaveProperty("persistent");

    const second = await check();
    expect(second?.issues).toEqual([expect.objectContaining({ viewport: 390, persistent: true })]);
    expect(second?.note).toContain("move on and tell the user");

    // The agent fixed it: a complete clean pass forgets it, so a regression reads as new.
    await install();
    expect((await check())?.issues).toEqual([]);
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    expect((await check())?.issues[0]).not.toHaveProperty("persistent");
  });

  test("memory is kept per path and per session", async () => {
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    await check();
    expect((await check({ relPath: "other.html" }))?.issues[0]).not.toHaveProperty("persistent");
    expect((await check({ sessionDir: `${sessionDir}-other` }))?.issues[0]).not.toHaveProperty(
      "persistent"
    );
  });

  test("a width that timed out is not checked, the earlier widths still report", async () => {
    await install({
      eval: { 390: { kind: "pass", findings: [card] }, 1440: { kind: "hang" } },
    });
    const report = await check({ budgetMs: 6_000 });
    expect(report).toMatchObject({
      checked: false,
      notChecked: [
        { viewport: 768, reason: "timeout" },
        { viewport: 1440, reason: "timeout" },
      ],
      issues: [expect.objectContaining({ viewport: 390 })],
    });
    expect(report?.note).toStartWith("Not checked at 768, 1440 px (timed out).");
    expect(report?.note).toContain("Fix each listed element");
  });

  test("a timed out or unsettled width neither clears nor confirms what was remembered", async () => {
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    await check();
    await install({ eval: { 390: { kind: "pass", complete: false, findings: [] } } });
    const unsettled = await check();
    expect(unsettled).toMatchObject({
      checked: false,
      notChecked: [{ viewport: 390, reason: "unsettled" }],
    });
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    expect((await check())?.issues).toEqual([expect.objectContaining({ persistent: true })]);
  });

  test("a missing agent-browser is not checked, and says why", async () => {
    const fake = await install({ missing: true });
    const report = await check();
    expect(report).toMatchObject({
      checked: false,
      issues: [],
      notChecked: [
        { viewport: 390, reason: "no-agent-browser" },
        { viewport: 768, reason: "no-agent-browser" },
        { viewport: 1440, reason: "no-agent-browser" },
      ],
    });
    expect(report?.note).toBe(
      "Not checked at 390, 768, 1440 px (agent-browser not found). Do not call the layout verified."
    );
    expect(await fake.calls()).toEqual([]);
  });

  test("a crashed script is not checked", async () => {
    await install({ eval: { 390: { kind: "throw", message: "boom" } } });
    expect(await check()).toMatchObject({
      checked: false,
      notChecked: expect.arrayContaining([{ viewport: 390, reason: "script-failed" }]),
    });
  });

  test("a cancelled call reports what it had and leaves the memory alone", async () => {
    await install({
      eval: { 390: { kind: "pass", findings: [card] }, 1440: { kind: "hang" } },
    });
    const controller = new AbortController();
    const pending = check({ abortSignal: controller.signal });
    await waitForCondition(
      () => fs.access(path.join(tempDir, "fake-state", "hang-started")).then(() => true, () => false),
      { timeoutMs: 10_000 }
    );
    controller.abort();
    expect(await pending).toMatchObject({
      checked: false,
      notChecked: [
        { viewport: 768, reason: "aborted" },
        { viewport: 1440, reason: "aborted" },
      ],
    });
    // The agent never saw that report, so the same finding is still new on the next publish.
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    expect((await check())?.issues[0]).not.toHaveProperty("persistent");
  });

  test("overlapping publishes of one path are checked one after the other", async () => {
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    const [first, second] = await Promise.all([check(), check()]);
    expect(first?.issues[0]).not.toHaveProperty("persistent");
    expect(second?.issues).toEqual([expect.objectContaining({ persistent: true })]);
  });

  test("a name with a space and a # reaches the browser as the one file", async () => {
    const fake = await install();
    await check({ relPath: "q3 report/draft #2.html" });
    const [url] = await fake.openedUrls();
    expect(url).toContain("q3%20report/draft%20%232.html");
    expect(fileURLToPath(url ?? "")).toBe(path.join(artifactsDir, "q3 report", "draft #2.html"));
  });

  test("a runtime directory is a POSIX path and may be home-relative", async () => {
    const fake = await install();
    const posix: AvailableArtifactsLocation = {
      kind: "runtime",
      runtime,
      dir: "/var/mux/scratch/artifacts/",
    };
    await check({ location: posix, relPath: "my report/a#b?.html" });
    expect(await fake.openedUrls()).toEqual(
      Array(3).fill("file:///var/mux/scratch/artifacts/my%20report/a%23b%3F.html")
    );

    const resolve = spyOn(runtime, "resolvePath").mockResolvedValue("/home/dev/.xum/scratch");
    await check({
      location: { kind: "runtime", runtime, dir: "~/.xum/scratch/artifacts" },
      relPath: "a.html",
    });
    expect(resolve).toHaveBeenCalledWith("~/.xum/scratch/artifacts");
    expect((await fake.openedUrls()).at(-1)).toBe("file:///home/dev/.xum/scratch/a.html");
  });

  test("an untrusted project's tool_env is neither looked up nor sourced", async () => {
    const exec = spyOn(runtime, "exec").mockImplementation(async () => execStream("", 127));
    const report = await check({ trusted: false });
    expect(report).toMatchObject({ checked: false });
    expect(exec).toHaveBeenCalledTimes(1);
    const [command, options] = exec.mock.calls[0] ?? [];
    expect(command).not.toContain("XUM_INTERNAL_TOOL_ENV_PATH");
    expect(options?.pathEnv).toBeUndefined();
  });

  test("the project-automation kill switch also keeps tool_env from running", async () => {
    await fs.mkdir(path.join(tempDir, ".xum"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".xum", "tool_env"), "exit 9\n");
    const exec = spyOn(runtime, "exec").mockImplementation(async () => execStream("", 127));
    const previous = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      await check({ trusted: true });
    } finally {
      if (previous === undefined) delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      else process.env[DISABLE_PROJECT_AUTOMATION_ENV] = previous;
    }
    const [command, options] = exec.mock.calls[0] ?? [];
    expect(command).not.toContain("XUM_INTERNAL_TOOL_ENV_PATH");
    expect(options?.pathEnv).toBeUndefined();
  });

  test("an unexpected failure is not checked and never throws", async () => {
    spyOn(runtime, "resolvePath").mockRejectedValue(new Error("ssh down"));
    const report = await check({
      location: { kind: "runtime", runtime, dir: "~/.xum/scratch/artifacts" },
    });
    expect(report).toMatchObject({
      checked: false,
      issues: [],
      notChecked: [
        { viewport: 390, reason: "browser-failed" },
        { viewport: 768, reason: "browser-failed" },
        { viewport: 1440, reason: "browser-failed" },
      ],
    });
  });
});
