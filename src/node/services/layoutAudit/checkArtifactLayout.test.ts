import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { LayoutAuditNotCheckedReason } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding, LayoutAuditReport } from "@/common/types/artifactLayoutAudit";
import type { ExecStream } from "@/node/runtime/Runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  agentSandboxPolicyAllows,
  buildAgentSandboxPolicy,
} from "@/node/runtime/sandbox/agentSandboxTargets";
import type { AvailableArtifactsLocation } from "@/node/services/artifactsOperations";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import { checkArtifactLayout, type ArtifactLayoutInput } from "./checkArtifactLayout";
import {
  installFakeAgentBrowser,
  type FakeAgentBrowser,
  type FakeAgentBrowserScript,
} from "./fakeAgentBrowser.testHarness";
import {
  LAYOUT_MEMORY_MAX_PATHS,
  layoutAuditLastStartedAtMs,
  layoutAuditPathsInFlight,
  startLayoutAudit,
} from "./layoutFingerprints";
import * as layoutReport from "./layoutReport";

// Every audit spawns shells (a fake CLI run is about a dozen processes); a loaded CI host is slow.
setDefaultTimeout(60_000);

const card: LayoutAuditPageFinding = {
  rule: "clipped-text",
  selector: "div.card > h2",
  axis: "horizontal",
  overflowPx: 12,
};

const thrice = (value: string) => [value, value, value];

/** The widths a report lists as not checked; none when it checked everything. */
const notCheckedOf = (report: LayoutAuditReport | undefined) =>
  report?.checked === false ? report.notChecked : [];

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

  const install = (script: FakeAgentBrowserScript = {}) => installFakeAgentBrowser(tempDir, script);

  const evalCount = async (fake: FakeAgentBrowser) =>
    (await fake.calls()).filter((argv) => argv.includes("eval")).length;

  test("leaves every kind but html alone and never starts a browser", async () => {
    const fake = await install();
    for (const kind of ["markdown", "svg", "json", "image", "canvas"]) {
      expect(await check({ kind })).toBeUndefined();
    }
    expect(await fake.calls()).toEqual([]);
  });

  test("an html publish of a file the browser would not parse as html is not audited", async () => {
    // Opened by its file:// URL, `page.txt` loads as plain text: a check of it could read clean.
    const fake = await install();
    expect(await check({ relPath: "page.txt" })).toBeUndefined();
    expect(await check({ relPath: "notes.md" })).toBeUndefined();
    expect(await fake.calls()).toEqual([]);
    expect(await check({ relPath: "page.htm" })).toMatchObject({ checked: true });
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
      thrice(pathToFileURL(path.join(artifactsDir, "chart.html")).href)
    );
  });

  test("the macOS agent sandbox lets the browser read the artifacts folder and nothing else of the session", async () => {
    await install();
    // Where the folders really are: under Xum's home, which the sandbox does not open by itself.
    // The paths need not exist: the policy is a pure function of them.
    const session = path.join(os.homedir(), ".xum", "sessions", "layout-sandbox-test");
    const artifacts = path.join(session, "scratch", "artifacts");
    const exec = spyOn(runtime, "exec");
    await check({ location: { kind: "host", dir: artifacts } });
    // The run reads the page. The close and the folder removal read nothing.
    const readPaths = exec.mock.calls.map(([, options]) => options.sandboxReadPaths);
    expect(readPaths.slice(1).every((paths) => paths === undefined)).toBe(true);
    const policy = buildAgentSandboxPolicy(
      {
        enabled: true,
        network: "loopback",
        allowedHosts: [],
        extraReadPaths: [],
        extraWritePaths: [],
      },
      { cwd: tempDir, readPaths: readPaths[0], pathEnv: "/usr/bin" }
    );
    expect(agentSandboxPolicyAllows(policy, path.join(artifacts, "chart.html"), "read")).toBe(true);
    expect(agentSandboxPolicyAllows(policy, path.join(artifacts, "chart.html"), "write")).toBe(
      false
    );
    expect(agentSandboxPolicyAllows(policy, path.join(session, "chat.jsonl"), "read")).toBe(false);
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

  test("a width with more findings than the list holds lists ten and counts the rest", async () => {
    const findings = Array.from({ length: 51 }, (_, index) => ({
      ...card,
      selector: `p.row-${index}`,
    }));
    await install({ eval: { 390: { kind: "pass", findings } } });
    const report = await check();
    expect(report).toMatchObject({ checked: true, more: 41 });
    expect(report?.issues).toHaveLength(10);
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
    const report = await check();
    expect(report).toMatchObject({ checked: false });
    expect(notCheckedOf(report)).toContainEqual({ viewport: 390, reason: "script-failed" });
  });

  test("a cancelled call reports what it had and leaves the memory alone", async () => {
    await install({
      eval: { 390: { kind: "pass", findings: [card] }, 1440: { kind: "hang" } },
    });
    const controller = new AbortController();
    const pending = check({ abortSignal: controller.signal });
    await waitForCondition(
      () =>
        fs.access(path.join(tempDir, "fake-state", "hang-started")).then(
          () => true,
          () => false
        ),
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

  test("an audit that does not remember reads what the agent was shown and adds nothing to it", async () => {
    // The turn-end audit has shown the agent nothing yet: only a publish result does.
    await install({ eval: { 390: { kind: "pass", findings: [card] } } });
    const atTurnEnd = () => check({ remember: false });
    expect((await atTurnEnd())?.issues[0]).not.toHaveProperty("persistent");
    // The publish still reads the finding as new, and its result is what commits it.
    expect((await check())?.issues[0]).not.toHaveProperty("persistent");
    expect((await atTurnEnd())?.issues[0]).toHaveProperty("persistent", true);
  }, 180_000);

  describe("the start time of the last audit that ran to its end", () => {
    const startedAt = () => layoutAuditLastStartedAtMs(sessionDir, "chart.html");

    test("is set by a complete check, whether or not it remembers", async () => {
      await install();
      const before = Date.now();
      await check({ remember: false });
      const recorded = startedAt();
      expect(recorded).toBeGreaterThanOrEqual(before);
      expect(recorded).toBeLessThanOrEqual(Date.now());
    });

    test("is set by a check in which no width completed", async () => {
      await install({ missing: true });
      await check();
      expect(startedAt()).toBeDefined();
    });

    test("is not set by a cancelled check", async () => {
      await install();
      await check({ abortSignal: AbortSignal.abort() });
      expect(startedAt()).toBeUndefined();
    });

    test("is not set by a check that found an issue it does not show, until a publish shows it", async () => {
      // The continuation that tells the agent can lose to newer input or a Stop: the page must
      // stay due for the next turn end, changed or not.
      await install({ eval: { 390: { kind: "pass", findings: [card] } } });
      await check({ remember: false });
      expect(startedAt()).toBeUndefined();
      await check();
      const shownAt = startedAt();
      expect(shownAt).toBeDefined();
      // The agent was shown the issue: a turn-end audit that finds only that one settles the page.
      await check({ remember: false });
      expect(startedAt()).toBeGreaterThan(shownAt ?? Infinity);
    }, 180_000);
  });

  test("overlapping publishes of one path run at once, and the one that started first does not overwrite the newer memory", async () => {
    // The first publish's browser run is held until the second publish has finished, so the one
    // that started first finishes last. If publishes of one path waited for each other, the
    // second one would wait on the held first and this test would time out.
    const firstSignal = new AbortController().signal;
    let releaseFirst: () => void = () => undefined;
    const firstMayRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runTimeouts: Array<number | undefined> = [];
    // Bound before spyOn: spyOn replaces the method before its argument is evaluated.
    const realExec = runtime.exec.bind(runtime);
    const exec = spyOn(runtime, "exec").mockImplementation(async (command, options) => {
      if (command.includes("page_script=")) {
        runTimeouts.push(options.timeout);
        if (options.abortSignal === firstSignal) await firstMayRun;
      }
      return realExec(command, options);
    });
    try {
      await install();
      const first = check({ abortSignal: firstSignal });
      const second = await check();
      expect(second?.issues).toEqual([]);

      // What the held publish will see. It reads the fake only when it runs, after the second.
      await install({ eval: { 390: { kind: "pass", findings: [card] } } });
      releaseFirst();
      expect((await first)?.issues).toEqual([expect.objectContaining({ viewport: 390 })]);
      // Each publish had its own full budget (20 s less the close reserve), whoever ran first.
      expect(runTimeouts).toHaveLength(2);
      for (const timeout of runTimeouts) expect(timeout).toBeGreaterThan(16);

      // The second publish started later, so its clean memory stands: the first publish's
      // finding was never remembered, and it reads as new now.
      expect((await check())?.issues[0]).not.toHaveProperty("persistent");
    } finally {
      releaseFirst();
      exec.mockRestore();
    }
  });

  describe("the audit of a path ends on every way out of a check", () => {
    // Every check starts an audit of its path, and the path's ordering state lives until that
    // audit ends: after a check has returned, no path of it may still be in flight.
    const expectNoneLeft = async (run: () => Promise<unknown>) => {
      const before = layoutAuditPathsInFlight();
      await run();
      expect(layoutAuditPathsInFlight()).toBe(before);
    };

    test("a complete check", async () => {
      await install();
      await expectNoneLeft(check);
    });

    test("a check in which no width completed", async () => {
      await install({ missing: true });
      await expectNoneLeft(check);
    });

    test("a cancelled check", async () => {
      await install();
      await expectNoneLeft(() => check({ abortSignal: AbortSignal.abort() }));
    });

    test("work that throws", async () => {
      spyOn(runtime, "resolvePath").mockRejectedValue(new Error("ssh down"));
      await expectNoneLeft(() =>
        check({ location: { kind: "runtime", runtime, dir: "~/.xum/scratch/artifacts" } })
      );
    });

    test("a report that cannot be built is not checked and never throws", async () => {
      await install();
      const build = spyOn(layoutReport, "buildLayoutReport").mockImplementationOnce(() => {
        throw new Error("build failed");
      });
      try {
        await expectNoneLeft(async () => {
          expect(await check()).toMatchObject({ checked: false });
        });
      } finally {
        build.mockRestore();
      }
    });
  });

  test("a check in which no width completed changes no memory, so it pushes no other path out", async () => {
    const remember = (relPath: string) =>
      startLayoutAudit(sessionDir, relPath).finish(
        () => ({ report: undefined, next: { phone: new Set([relPath]) } }),
        true
      );
    for (let index = 0; index < LAYOUT_MEMORY_MAX_PATHS; index++) remember(`seed${index}.html`);
    await install({ missing: true });
    expect(await check({ relPath: "new.html" })).toMatchObject({ checked: false });
    const oldest = startLayoutAudit(sessionDir, "seed0.html").finish(
      (previous) => ({ report: previous, next: {} }),
      false
    );
    expect(oldest).toEqual({ phone: new Set(["seed0.html"]) });
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
      thrice("file:///var/mux/scratch/artifacts/my%20report/a%23b%3F.html")
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
    const exec = spyOn(runtime, "exec").mockImplementation(() =>
      Promise.resolve(execStream("", 127))
    );
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
    const exec = spyOn(runtime, "exec").mockImplementation(() =>
      Promise.resolve(execStream("", 127))
    );
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

  /** Over SSH the artifacts dir may start with `~`, which takes a lookup on the runtime. */
  const homeRelative = (): AvailableArtifactsLocation => ({
    kind: "runtime",
    runtime,
    dir: "~/.xum/scratch/artifacts",
  });
  /** A location whose home directory lookup never answers, like a dead connection. */
  const hungHome = () => {
    spyOn(runtime, "resolvePath").mockReturnValue(new Promise<string>(() => undefined));
    return homeRelative();
  };
  const everyWidth = (reason: LayoutAuditNotCheckedReason) =>
    ([390, 768, 1440] as const).map((viewport) => ({ viewport, reason }));

  test("a setup that never settles, with the call already cancelled, returns at once as aborted", async () => {
    const report = await check({
      location: hungHome(),
      budgetMs: 1,
      abortSignal: AbortSignal.abort(),
    });
    expect(notCheckedOf(report)).toEqual(everyWidth("aborted"));
    expect(report?.issues).toEqual([]);
  }, 10_000);

  test("a setup that never settles is not checked at any width once the deadline passes", async () => {
    const started = Date.now();
    const report = await check({ location: hungHome(), budgetMs: 200 });
    expect(notCheckedOf(report)).toEqual(everyWidth("timeout"));
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("a tool_env lookup that never settles is not checked at any width once the deadline passes", async () => {
    spyOn(runtime, "stat").mockReturnValue(new Promise<never>(() => undefined));
    const report = await check({ trusted: true, budgetMs: 200 });
    expect(notCheckedOf(report)).toEqual(everyWidth("timeout"));
  }, 10_000);

  test("a cancel stops the wait for a setup that never settles", async () => {
    const controller = new AbortController();
    const pending = check({ location: hungHome(), abortSignal: controller.signal });
    controller.abort();
    expect(notCheckedOf(await pending)).toEqual(everyWidth("aborted"));
  }, 10_000);

  test("a setup that fails after its deadline leaves no unhandled rejection", async () => {
    let failLate: (error: Error) => void = () => undefined;
    spyOn(runtime, "resolvePath").mockReturnValue(
      new Promise<string>((_, reject) => {
        failLate = reject;
      })
    );
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const report = await check({ location: homeRelative(), budgetMs: 50 });
      expect(notCheckedOf(report)).toEqual(everyWidth("timeout"));
      failLate(new Error("ssh down, long after the deadline"));
      // Unhandled rejections are reported after the microtask queue drains: one macrotask turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", record);
    }
    expect(unhandled).toEqual([]);
  }, 10_000);

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
