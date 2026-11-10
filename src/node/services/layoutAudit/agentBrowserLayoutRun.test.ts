import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditViewportWidth,
} from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { getToolEnvPath } from "@/node/services/hooks";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import { runLayoutPasses } from "./agentBrowserLayoutRun";
import {
  installFakeAgentBrowser,
  type FakeAgentBrowser,
  type FakeAgentBrowserScript,
} from "./fakeAgentBrowser.testHarness";
import type { ViewportOutcome } from "./viewportOutcome";

// Every test spawns shells (a fake CLI run is about a dozen processes); a loaded CI host is slow.
setDefaultTimeout(60_000);

const RUN_ORDER: LayoutAuditViewportWidth[] = [390, 1440, 768];
const FILE_URL = "file:///tmp/artifacts/chart.html";
// The run only forwards the script: any text will do.
const PAGE_SCRIPT = "(() => Promise.resolve({ marker: 1 }))()";
// Far more than a pipe buffer holds, like the real script.
const BIG_PAGE_SCRIPT = `(() => "${"x".repeat(300_000)}")()`;
const finding: LayoutAuditPageFinding = {
  rule: "clipped-text",
  selector: "div.card > h2",
  axis: "horizontal",
  overflowPx: 12.5,
};

describe("runLayoutPasses through a fake agent-browser", () => {
  let projectDir: string;
  let runtime: LocalRuntime;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-run-"));
    runtime = new LocalRuntime(projectDir);
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  /** The production path: the project's tool_env found like the bash tool finds it. */
  const run = async (
    script: FakeAgentBrowserScript,
    overrides: {
      fileUrl?: string;
      pageScript?: string;
      budgetMs?: number;
      abortSignal?: AbortSignal;
    } = {}
  ): Promise<{ outcomes: ViewportOutcome[]; fake: FakeAgentBrowser }> => {
    const fake = await installFakeAgentBrowser(projectDir, script);
    const outcomes = await runLayoutPasses({
      runtime,
      cwd: projectDir,
      toolEnvPath: await getToolEnvPath(runtime, projectDir),
      fileUrl: overrides.fileUrl ?? FILE_URL,
      pageScript: overrides.pageScript ?? PAGE_SCRIPT,
      deadlineMs: Date.now() + (overrides.budgetMs ?? 20_000),
      abortSignal: overrides.abortSignal,
    });
    return { outcomes, fake };
  };

  const summary = (outcomes: ViewportOutcome[]) =>
    outcomes.map((outcome) =>
      outcome.status === "failed"
        ? `${outcome.viewport.width} failed ${outcome.reason}`
        : `${outcome.viewport.width} ${outcome.status}`
    );

  /** Subcommand of each call: the first argv field that is not a global flag or its value. */
  const subcommands = (calls: string[][]) =>
    calls.map((argv) => {
      const flagsWithValue = ["--namespace", "--session", "--headed", "--idle-timeout"];
      for (let index = 0; index < argv.length; index++) {
        if (flagsWithValue.includes(argv[index] ?? "")) index += 1;
        else if (argv[index] !== "--json") return argv[index];
      }
      return undefined;
    });

  /** Global flags of every call: one session, one namespace, never `--all`. */
  const expectOneOwnSession = (calls: string[][]) => {
    const values = (flag: string) =>
      new Set(calls.map((argv) => argv[argv.indexOf(flag) + 1]));
    expect([...values("--namespace")]).toEqual(["xum-layout"]);
    const sessions = [...values("--session")];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^xum-layout-[0-9a-f]{12}$/);
    for (const argv of calls) {
      expect(argv).not.toContain("--all");
      expect(argv.slice(argv.indexOf("--headed"), argv.indexOf("--headed") + 4)).toEqual([
        "--headed",
        "false",
        "--idle-timeout",
        "30s",
      ]);
    }
  };

  test("checks 390, 1440 then 768 in one fresh session and closes it once", async () => {
    const { outcomes, fake } = await run({});
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
    expect(outcomes.map((outcome) => outcome.viewport.width)).toEqual(RUN_ORDER);
    const calls = await fake.calls();
    expect(subcommands(calls)).toEqual([
      "set", "open", "eval",
      "set", "open", "eval",
      "set", "open", "eval",
      "close",
    ]);
    expectOneOwnSession(calls);
    const sets = calls.filter((argv) => argv.includes("set"));
    expect(sets.map((argv) => argv.slice(argv.indexOf("viewport")))).toEqual(
      LAYOUT_AUDIT_VIEWPORTS.map((viewport) => ["viewport", String(viewport.width), String(viewport.height)])
    );
    expect(await fake.openedUrls()).toEqual([FILE_URL, FILE_URL, FILE_URL]);
  });

  test("evaluates the page script, piped on stdin and never put on the command line", async () => {
    const { fake } = await run({});
    const calls = await fake.calls();
    for (const width of RUN_ORDER) {
      expect(await fake.evalStdin(width)).toBe(PAGE_SCRIPT);
    }
    for (const argv of calls) expect(argv.join(" ")).not.toContain(PAGE_SCRIPT);
    expect(calls.filter((argv) => argv.includes("eval")).every((argv) => argv.includes("--stdin"))).toBe(true);
  });

  test("returns the findings of a complete pass", async () => {
    const { outcomes } = await run({ eval: { 1440: { kind: "pass", findings: [finding] } } });
    expect(outcomes[1]).toMatchObject({ status: "complete", findings: [finding] });
  });

  test("an unsettled pass drops its findings and the run goes on", async () => {
    const { outcomes, fake } = await run({
      eval: { 390: { kind: "pass", complete: false, findings: [finding] } },
    });
    expect(summary(outcomes)).toEqual(["390 unsettled", "1440 complete", "768 complete"]);
    expect(outcomes[0]).not.toHaveProperty("findings");
    expect(subcommands(await fake.calls()).filter((name) => name === "eval")).toHaveLength(3);
  });

  test("a browser that ignores the viewport is not a result", async () => {
    const { outcomes } = await run({ eval: { 1440: { kind: "pass", viewportWidth: 800 } } });
    expect(summary(outcomes)).toEqual(["390 complete", "1440 failed wrong-viewport", "768 complete"]);
  });

  test("no agent-browser on PATH: nothing runs and there is nothing to close", async () => {
    const { outcomes, fake } = await run({ missing: true });
    expect(summary(outcomes)).toEqual([
      "390 failed no-agent-browser",
      "1440 failed no-agent-browser",
      "768 failed no-agent-browser",
    ]);
    expect(await fake.calls()).toEqual([]);
  });

  test("a tool_env that fails to source is its own reason, and nothing runs", async () => {
    const { outcomes, fake } = await run({ toolEnvFails: true });
    expect(new Set(summary(outcomes).map((line) => line.split(" ").slice(1).join(" ")))).toEqual(
      new Set(["failed tool-env-failed"])
    );
    expect(await fake.calls()).toEqual([]);
  });

  test("a page that will not open stops the run, never reaches eval and still closes", async () => {
    const { outcomes, fake } = await run({ openFails: true });
    expect(summary(outcomes)).toEqual([
      "390 failed browser-failed",
      "1440 failed browser-failed",
      "768 failed browser-failed",
    ]);
    const calls = await fake.calls();
    expect(subcommands(calls)).toEqual(["set", "open", "close"]);
    expectOneOwnSession(calls);
  });

  test("a script that throws keeps the widths before it and stops the run", async () => {
    const { outcomes, fake } = await run({ eval: { 1440: { kind: "throw", message: "boom" } } });
    expect(summary(outcomes)).toEqual([
      "390 complete",
      "1440 failed script-failed",
      "768 failed script-failed",
    ]);
    expect(subcommands(await fake.calls()).filter((name) => name === "close")).toHaveLength(1);
  });

  test("output that is not JSON is a failed script, not a clean page", async () => {
    const { outcomes } = await run({ eval: { 390: { kind: "garbage" } } });
    expect(summary(outcomes)[0]).toBe("390 failed script-failed");
  });

  test("a result that is not a page result is a failed script", async () => {
    for (const result of [null, "ok", { complete: true }, { complete: true, viewportWidth: 390, findings: [{ rule: "nope" }] }]) {
      const { outcomes } = await run({ eval: { 390: { kind: "result", result } } });
      expect(summary(outcomes)[0]).toBe("390 failed script-failed");
    }
  });

  test("a hang keeps the earlier widths, times the rest out and still closes", async () => {
    const { outcomes, fake } = await run({ eval: { 1440: { kind: "hang" } } }, { budgetMs: 6_000 });
    expect(summary(outcomes)).toEqual(["390 complete", "1440 failed timeout", "768 failed timeout"]);
    const calls = await fake.calls();
    expect(subcommands(calls)).toEqual(["set", "open", "eval", "set", "open", "eval", "close"]);
    expectOneOwnSession(calls);
  });

  test("a cancel mid-run keeps the earlier widths, reports aborted and still closes", async () => {
    const controller = new AbortController();
    const pending = run({ eval: { 1440: { kind: "hang" } } }, { abortSignal: controller.signal });
    // The fake exists once `run` has installed it; the hang marker says the call is in flight.
    await waitForCondition(async () => {
      const started = await fs
        .access(path.join(projectDir, "fake-state", "hang-started"))
        .then(() => true, () => false);
      return started;
    }, { timeoutMs: 10_000 });
    controller.abort();
    const { outcomes, fake } = await pending;
    expect(summary(outcomes)).toEqual(["390 complete", "1440 failed aborted", "768 failed aborted"]);
    expect(subcommands(await fake.calls()).filter((name) => name === "close")).toHaveLength(1);
  });

  test("a cancel before the run starts reports aborted at every width", async () => {
    const { outcomes } = await run({}, { abortSignal: AbortSignal.abort() });
    expect(new Set(summary(outcomes).map((line) => line.split(" ").slice(1).join(" ")))).toEqual(
      new Set(["failed aborted"])
    );
  });

  test("a runtime that cannot exec reports browser-failed and never throws", async () => {
    const exec = spyOn(runtime, "exec").mockRejectedValue(new Error("connection reset"));
    const { outcomes } = await run({});
    expect(exec).toHaveBeenCalledTimes(2);
    expect(new Set(summary(outcomes).map((line) => line.split(" ").slice(1).join(" ")))).toEqual(
      new Set(["failed browser-failed"])
    );
  });

  test("passes the URL as data: spaces, #, quotes and shell syntax arrive unchanged", async () => {
    const nasty = "file:///tmp/my%20report%20%231/it's \"x\" $(touch pwned) `id`; &&.html";
    const { outcomes, fake } = await run({}, { fileUrl: nasty });
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
    expect(await fake.openedUrls()).toEqual([nasty, nasty, nasty]);
    expect(
      await fs.access(path.join(projectDir, "pwned")).then(() => true, () => false)
    ).toBe(false);
  });

  test("a page script bigger than a pipe buffer still reaches every eval", async () => {
    const { outcomes, fake } = await run({}, { pageScript: BIG_PAGE_SCRIPT });
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
    for (const width of RUN_ORDER) expect(await fake.evalStdin(width)).toBe(BIG_PAGE_SCRIPT);
  });

  test("a big page script does not hide why nothing ran", async () => {
    const missing = await run({ missing: true }, { pageScript: BIG_PAGE_SCRIPT });
    expect(summary(missing.outcomes)).toEqual([
      "390 failed no-agent-browser",
      "1440 failed no-agent-browser",
      "768 failed no-agent-browser",
    ]);
    const toolEnvFails = await run({ toolEnvFails: true }, { pageScript: BIG_PAGE_SCRIPT });
    expect(summary(toolEnvFails.outcomes)[0]).toBe("390 failed tool-env-failed");
  });

  test("each run uses its own session, and the close names it", async () => {
    const sessionOf = (argv: string[] | undefined) => argv?.[argv.indexOf("--session") + 1];
    const first = await run({});
    const firstCalls = await first.fake.calls();
    const second = await run({});
    const secondCalls = await second.fake.calls();
    expect(sessionOf(firstCalls[0])).not.toBe(sessionOf(secondCalls[0]));
    const closeCall = secondCalls.find((argv) => argv.includes("close"));
    expect(sessionOf(closeCall)).toBe(sessionOf(secondCalls[0]));
  });
});
