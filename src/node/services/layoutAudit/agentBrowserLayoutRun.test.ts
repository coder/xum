import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS,
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
// The calls of a clean run: `set offline on`, three widths of set, open and eval, then the close.
const CALLS_OF_A_CLEAN_RUN = 11;
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
      // A clean run ends long before this. A loaded host (load 25 and more) once spent 20 s on
      // the ten fake calls of one run and timed 768 out; only the hang tests set a short budget.
      deadlineMs: Date.now() + (overrides.budgetMs ?? 60_000),
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
      const flagsWithValue = ["--session", "--config", "--idle-timeout", "--args"];
      for (let index = 0; index < argv.length; index++) {
        if (flagsWithValue.includes(argv[index] ?? "")) index += 1;
        else if (argv[index] !== "--json") return argv[index];
      }
      return undefined;
    });

  /** Global flags of every call: one session of its own, never `--all`, never `--headed`. */
  const expectOneOwnSession = (calls: string[][]) => {
    const values = (flag: string) => new Set(calls.map((argv) => argv[argv.indexOf(flag) + 1]));
    const sessions = [...values("--session")];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^xum-layout-[0-9a-f]{12}$/);
    for (const argv of calls) {
      expect(argv).not.toContain("--all");
      expect(argv).not.toContain("--headed");
      expect(
        argv.slice(argv.indexOf("--idle-timeout"), argv.indexOf("--idle-timeout") + 2)
      ).toEqual(["--idle-timeout", "10s"]);
    }
  };

  test("checks 390, 1440 then 768 in one fresh session and closes it once", async () => {
    const { outcomes, fake } = await run({});
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
    expect(outcomes.map((outcome) => outcome.viewport.width)).toEqual(RUN_ORDER);
    const calls = await fake.calls();
    expect(subcommands(calls)).toEqual([
      "set",
      "set",
      "open",
      "eval",
      "set",
      "open",
      "eval",
      "set",
      "open",
      "eval",
      "close",
    ]);
    expectOneOwnSession(calls);
    const [, ...viewportSets] = calls.filter((argv) => argv.includes("set"));
    expect(viewportSets.map((argv) => argv.slice(argv.indexOf("viewport")))).toEqual(
      LAYOUT_AUDIT_VIEWPORTS.map((viewport) => [
        "viewport",
        String(viewport.width),
        String(viewport.height),
      ])
    );
    expect(await fake.openedUrls()).toEqual([FILE_URL, FILE_URL, FILE_URL]);
  });

  test("turns the network off once, before the first page opens", async () => {
    const { fake } = await run({});
    const calls = await fake.calls();
    const offline = calls.flatMap((argv, index) =>
      argv.join(" ").endsWith("set offline on") ? [index] : []
    );
    expect(offline).toEqual([0]);
    expect(subcommands(calls).indexOf("open")).toBeGreaterThan(0);
  });

  // `set offline` covers one tab. A window the page opens is another tab, so the whole browser
  // also launches with flags that send every connection to a dead end.
  const NETWORK_OFF_FLAGS = [
    "--proxy-server=127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];

  test("launches the whole browser with the network-off flags, on every call, the close included", async () => {
    const { fake } = await run({});
    const calls = await fake.calls();
    const values = calls.map((argv) => argv[argv.indexOf("--args") + 1]);
    // The first call launches the browser; the others must not give it other launch settings.
    expect(new Set(values).size).toBe(1);
    expect(calls.every((argv) => argv.includes("--args"))).toBe(true);
    expect(values[0]?.split(",")).toEqual(NETWORK_OFF_FLAGS);
    expect(subcommands(calls).at(-1)).toBe("close");
  });

  // A window the page opens takes over the browser's active tab, and eval then runs there.
  test.each([
    ["a window that failed to load", "chrome-error://chromewebdata/"],
    ["a window on another host", "http://127.0.0.1:9/window-open"],
    ["another file", "file:///tmp/artifacts/other.html"],
    ["a blank window", "about:blank"],
    ["no address", ""],
  ])("a pass from %s is not a clean result, and the other widths stand", async (_name, href) => {
    const { outcomes } = await run({ eval: { 1440: { kind: "pass", href } } });
    expect(summary(outcomes)).toEqual([
      "390 complete",
      "1440 failed script-failed",
      "768 complete",
    ]);
  });

  test("a pass from the artifact is accepted whatever the page did to its hash, query or escaping", async () => {
    const fileUrl = "file:///tmp/artifacts/a%26b%5B1%5D.html";
    const { outcomes } = await run(
      {
        eval: {
          390: { kind: "pass", href: "file:///tmp/artifacts/a&b[1].html" },
          1440: { kind: "pass", href: `${fileUrl}#section` },
          768: { kind: "pass", href: `${fileUrl}?tab=2` },
        },
      },
      { fileUrl }
    );
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
  });

  test("evaluates the page script, piped on stdin and never put on the command line", async () => {
    const { fake } = await run({});
    const calls = await fake.calls();
    for (const width of RUN_ORDER) {
      expect(await fake.evalStdin(width)).toBe(PAGE_SCRIPT);
    }
    for (const argv of calls) expect(argv.join(" ")).not.toContain(PAGE_SCRIPT);
    expect(
      calls.filter((argv) => argv.includes("eval")).every((argv) => argv.includes("--stdin"))
    ).toBe(true);
  });

  test("returns the findings of a complete pass", async () => {
    const { outcomes } = await run({ eval: { 1440: { kind: "pass", findings: [finding] } } });
    expect(outcomes[1]).toMatchObject({ status: "complete", findings: [finding] });
  });

  // A selector at the long end of what the page script writes: five parts, a class and an index.
  const findingsOf = (count: number): LayoutAuditPageFinding[] =>
    Array.from({ length: count }, (_, index) => ({
      ...finding,
      selector: `body > main#app > section.dashboard-panel:nth-of-type(2) > div.card-body > p.card-title:nth-of-type(${index})`,
    }));

  test("three passes at the findings bound come back whole: the output bound fits them", async () => {
    const atBound = {
      kind: "pass",
      findings: findingsOf(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS),
    } as const;
    const { outcomes } = await run({ eval: { 390: atBound, 1440: atBound, 768: atBound } });
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
    for (const outcome of outcomes) {
      expect(outcome.status === "complete" ? outcome.findings.length : -1).toBe(
        LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS
      );
    }
  });

  test("a page result over the findings bound is rejected, and that width is not checked", async () => {
    const { outcomes } = await run({
      eval: {
        1440: { kind: "pass", findings: findingsOf(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS + 1) },
      },
    });
    expect(summary(outcomes)).toEqual([
      "390 complete",
      "1440 failed script-failed",
      "768 complete",
    ]);
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
    expect(summary(outcomes)).toEqual([
      "390 complete",
      "1440 failed wrong-viewport",
      "768 complete",
    ]);
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
    expect(subcommands(calls)).toEqual(["set", "set", "open", "close"]);
    expectOneOwnSession(calls);
  });

  // Fail closed: a network that cannot be turned off is not "clean", it is not checked. The call
  // starts the browser, so the close still runs.
  test("a network that will not go off stops the run before any page opens and still closes", async () => {
    const { outcomes, fake } = await run({ offlineFails: true });
    expect(summary(outcomes)).toEqual([
      "390 failed browser-failed",
      "1440 failed browser-failed",
      "768 failed browser-failed",
    ]);
    expect(await fake.openedUrls()).toEqual([]);
    const calls = await fake.calls();
    expect(subcommands(calls)).toEqual(["set", "close"]);
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
    for (const result of [
      null,
      "ok",
      { complete: true },
      { complete: true, viewportWidth: 390, findings: [{ rule: "nope" }] },
    ]) {
      const { outcomes } = await run({ eval: { 390: { kind: "result", result } } });
      expect(summary(outcomes)[0]).toBe("390 failed script-failed");
    }
  });

  test("a hang keeps the earlier widths, times the rest out and still closes", async () => {
    const { outcomes, fake } = await run({ eval: { 1440: { kind: "hang" } } }, { budgetMs: 6_000 });
    expect(summary(outcomes)).toEqual([
      "390 complete",
      "1440 failed timeout",
      "768 failed timeout",
    ]);
    const calls = await fake.calls();
    const names = subcommands(calls);
    // On a loaded host the budget can run out while 1440 still opens, before its eval starts:
    // what must hold is that 390 finished, 768 never opened, and the browser was closed.
    expect(names.slice(0, 6)).toEqual(["set", "set", "open", "eval", "set", "open"]);
    expect(names.filter((name) => name === "open")).toHaveLength(2);
    expect(names.at(-1)).toBe("close");
    expectOneOwnSession(calls);
  });

  test("a cancel mid-run keeps the earlier widths, reports aborted and still closes", async () => {
    const controller = new AbortController();
    const pending = run({ eval: { 1440: { kind: "hang" } } }, { abortSignal: controller.signal });
    // The fake exists once `run` has installed it; the hang marker says the call is in flight.
    await waitForCondition(
      async () => {
        const started = await fs.access(path.join(projectDir, "fake-state", "hang-started")).then(
          () => true,
          () => false
        );
        return started;
      },
      { timeoutMs: 10_000 }
    );
    controller.abort();
    const { outcomes, fake } = await pending;
    expect(summary(outcomes)).toEqual([
      "390 complete",
      "1440 failed aborted",
      "768 failed aborted",
    ]);
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
    // The run, the close, and the removal that follows a close that did not end well.
    expect(exec).toHaveBeenCalledTimes(3);
    expect(new Set(summary(outcomes).map((line) => line.split(" ").slice(1).join(" ")))).toEqual(
      new Set(["failed browser-failed"])
    );
  });

  test("passes the URL as data: spaces, #, quotes and shell syntax arrive unchanged", async () => {
    const nasty = 'file:///tmp/my%20report%20%231/it\'s "x" $(touch pwned) `id`; &&.html';
    const { outcomes, fake } = await run({}, { fileUrl: nasty });
    expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
    expect(await fake.openedUrls()).toEqual([nasty, nasty, nasty]);
    expect(
      await fs.access(path.join(projectDir, "pwned")).then(
        () => true,
        () => false
      )
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

  test("a run keeps its session files in a folder of its own and removes it after the close", async () => {
    const exec = spyOn(runtime, "exec");
    const { fake } = await run({});
    // The run and the close: a close that ended well needs no removal step after it.
    expect(exec).toHaveBeenCalledTimes(2);
    const seen = await fake.socketDirs();
    const session = (await fake.calls())[0]?.[1];
    // Every call, the close included, saw the one folder, and it existed while they ran.
    expect(new Set(seen.map((call) => call.dir))).toEqual(new Set([`/tmp/${session}`]));
    expect(seen.every((call) => call.existed)).toBe(true);
    expect(seen).toHaveLength(CALLS_OF_A_CLEAN_RUN);
    expect(
      await fs.stat(`/tmp/${session}`).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("an inherited agent-browser setting never reaches a call, whatever its name", async () => {
    const inherited = {
      AGENT_BROWSER_CDP: "1",
      AGENT_BROWSER_PROFILE: "/nonexistent-profile",
      AGENT_BROWSER_FUTURE_FLAG: "1",
      AGENT_BROWSER_ARGS: "--proxy-server=direct://",
    };
    Object.assign(process.env, inherited);
    try {
      const { outcomes, fake } = await run({});
      expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
      // Every call of the run saw its own folder and nothing else.
      expect(await fake.agentBrowserEnvNames()).toEqual(
        Array.from({ length: CALLS_OF_A_CLEAN_RUN }, () => ["AGENT_BROWSER_SOCKET_DIR"])
      );
    } finally {
      for (const name of Object.keys(inherited)) delete process.env[name];
    }
  });

  // The scripts run in a new shell, so tool_env's shell state stays behind: a readonly variable
  // cannot stop the sweep, and a variable named like one of the scripts' own cannot steer them.
  test.each([
    // In the sourcing shell, IFS=" " would make the sweep read its two names as one word.
    ["a readonly IFS", 'readonly IFS=" "; export AGENT_BROWSER_CDP=1 AGENT_BROWSER_FUTURE_FLAG=1'],
    ["a readonly agent-browser setting", "export AGENT_BROWSER_CDP=1; readonly AGENT_BROWSER_CDP"],
    ["a readonly socket folder", "readonly AGENT_BROWSER_SOCKET_DIR=/tmp/not-the-runs-folder"],
    ["a readonly command prefix", "readonly ab_wrap='env AGENT_BROWSER_CDP=1'"],
    ["a readonly result", "readonly status=0 envelope=forged width=1 page_script=forged"],
    // A /bin/sh that is bash would switch these options on again from the exported variables.
    ["an exported shell option", "set -e; shopt -s nullglob; export SHELLOPTS BASHOPTS"],
  ])("%s in tool_env reaches neither the run nor the close", async (_name, line) => {
    const { outcomes, fake } = await run({ toolEnvLines: [line] });
    expect(summary(outcomes)).toEqual(RUN_ORDER.map((width) => `${width} complete`));
    expect(await fake.agentBrowserEnvNames()).toEqual(
      Array.from({ length: CALLS_OF_A_CLEAN_RUN }, () => ["AGENT_BROWSER_SOCKET_DIR"])
    );
    const dirs = new Set((await fake.socketDirs()).map((call) => call.dir));
    expect([...dirs]).toEqual([`/tmp/${(await fake.calls())[0]?.[1]}`]);
    expect(await fake.evalStdin(390)).toBe(PAGE_SCRIPT);
  });

  test("every call names a config of the run's own folder, and it is empty", async () => {
    const { fake } = await run({});
    const dirs = (await fake.socketDirs()).map((call) => call.dir);
    const configs = await fake.configs();
    expect(configs).toHaveLength(CALLS_OF_A_CLEAN_RUN);
    expect(new Set(dirs).size).toBe(1);
    for (const config of configs) {
      expect(config.path).toBe(`${dirs[0]}/config.json`);
      expect(JSON.parse(config.content ?? "null")).toEqual({});
    }
  });

  test("a hung run still has its folder removed by the close", async () => {
    const { fake } = await run({ eval: { 390: { kind: "hang" } } }, { budgetMs: 3_000 });
    const seen = await fake.socketDirs();
    expect(seen.at(-1)?.existed).toBe(true);
    expect(
      await fs.stat(seen[0]?.dir ?? "").then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  // The bound on the close needs `timeout`, which stock macOS lacks (the folder then stays).
  test.skipIf(Bun.which("timeout") === null)(
    "a close that never answers is cut short, and the folder is still removed",
    async () => {
      const started = Date.now();
      const { outcomes, fake } = await run({ closeHangs: true });
      expect(summary(outcomes)).toEqual(["390 complete", "1440 complete", "768 complete"]);
      const seen = await fake.socketDirs();
      expect(
        await fs.stat(seen[0]?.dir ?? "").then(
          () => true,
          () => false
        )
      ).toBe(false);
      // Far below the fake's 60 s hang and the run's 60 s default budget.
      expect(Date.now() - started).toBeLessThan(15_000);
    }
  );

  test("a close that is killed before it removes the folder still leaves no folder behind", async () => {
    // A third of this budget is the close's time: less than the close waits for an answer, so
    // the exec is killed while it waits, as on a host too loaded to finish in time.
    const { fake } = await run({ closeHangs: true }, { budgetMs: 3_000 });
    const seen = await fake.socketDirs();
    expect(seen.at(-1)?.existed).toBe(true);
    expect(
      await fs.stat(seen[0]?.dir ?? "").then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("a run never adopts a socket folder it did not create", async () => {
    // A name only this process uses, so parallel runs of this file on one host cannot collide.
    const bytes = Buffer.alloc(6);
    bytes.writeUInt32BE(process.pid, 2);
    const taken = `/tmp/xum-layout-${bytes.toString("hex")}`;
    const spy = spyOn(crypto, "randomBytes").mockImplementation(((size: number) =>
      bytes.subarray(0, size)) as typeof crypto.randomBytes);
    await fs.mkdir(taken);
    try {
      const { outcomes, fake } = await run({});
      expect(summary(outcomes)).toEqual([
        "390 failed browser-failed",
        "1440 failed browser-failed",
        "768 failed browser-failed",
      ]);
      // No browser call was made, and no close: the close is what removes the folder.
      expect(await fake.calls()).toEqual([]);
      expect(
        await fs.stat(taken).then(
          () => true,
          () => false
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
      await fs.rm(taken, { recursive: true, force: true });
    }
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
