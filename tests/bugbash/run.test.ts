import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RunDeps, runBugBash } from "./run";
import type { JobOutcome, LaunchOptions } from "./sandbox/launch";
import type { Ledger } from "./sandbox/proxyPolicy";
import { Refusal } from "./sandbox/runner";

// run.ts with a fake launcher: no container, no proxy, no model. The launcher's own tests
// (sandbox/runner.test.ts) cover the job itself.
const ENV = {
  BUGBASH_MODELS: "anthropic:claude-sonnet-5-5",
  BUGBASH_BUDGET_USD: "2",
  ANTHROPIC_API_KEY: "sk-run-test",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function charters(...slugs: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-run-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "charters.txt");
  fs.writeFileSync(file, slugs.map((slug) => `${slug}|web|default|look at ${slug}`).join("\n"));
  return ["--charters", file];
}

interface Call {
  args: string[];
  o: LaunchOptions;
}
/** A launcher that writes a one-step report into the job's output and returns `outcome`. */
function fakeLaunch(
  outcome: (call: Call, index: number) => Promise<JobOutcome> | JobOutcome,
  probeStatus = 502
) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const probes: Ledger[] = [];
  const deps: RunDeps = {
    // The app AI probe: 502 (the upstream failed) unless a test says otherwise.
    probeApp: (_job, _model, ledger) => {
      probes.push(ledger);
      return Promise.resolve({ status: probeStatus, records: [{ outcome: "settled" }] });
    },
    launchJob: async (args, o) => {
      const call = { args, o };
      calls.push(call);
      const output = path.join(o.cwd, args[args.indexOf("--output") + 1]);
      fs.mkdirSync(output, { recursive: true });
      const report = { run: { explore: { ended: "done", steps: [{}], findings: [] } } };
      fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report));
      return outcome(call, calls.length - 1);
    },
    out: (line) => {
      lines.push(line);
      const run = / -> (\S+)$/.exec(line)?.[1];
      if (run) cleanups.push(() => fs.rmSync(run, { recursive: true, force: true }));
    },
    err: (line) => lines.push(line),
  };
  return { deps, calls, lines, probes };
}
const until = (signal: AbortSignal): Promise<JobOutcome> =>
  new Promise((resolve) => {
    const done = () => resolve({ code: 130, cleanup: "removed", stopped: String(signal.reason) });
    if (signal.aborted) done();
    else signal.addEventListener("abort", done);
  });

test("B2: every charter runs through the launcher with one shared ledger, none on the host", async () => {
  const spawn = spyOn(childProcess, "spawn");
  try {
    const { deps, calls, lines } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }));
    const stop = new AbortController().signal;
    expect(await runBugBash([...charters("a", "b", "c")], ENV, stop, deps)).toBe(0);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.o.ledger)).size).toBe(1);
    expect(calls[0].o.ledger).toBeDefined();
    for (const { args, o } of calls) {
      expect(args[0]).toBe("explore");
      expect(args[1]).toStartWith("look at");
      expect(o.env).toMatchObject({ BUGBASH_AI: "mock", BUGBASH_MODEL: ENV.BUGBASH_MODELS });
      expect(o.env.BUGBASH_AI_RESOLVED).toBeUndefined();
    }
    expect(spawn).not.toHaveBeenCalled();
    const findings = lines.find((line) => line.startsWith("Findings: "))!.slice(10);
    expect(fs.readFileSync(findings, "utf8")).toMatch(
      /Cost: 0 proxied calls, 0 refused by the budget, \$0\.0000 of \$2\.0000 at list price/
    );
  } finally {
    spawn.mockRestore();
  }
});

test("B2: a proxy fault starts no new charter, stops the running one and exits 5", async () => {
  const { deps, calls } = fakeLaunch((call, index) =>
    index === 0
      ? until(call.o.stop) // still running when the fault comes
      : { code: 0, cleanup: "removed", proxyFault: "proxy: 1 call(s) cost more" }
  );
  const stop = new AbortController().signal;
  const args = [...charters("a", "b", "c", "d"), "--parallel", "2"];
  expect(await runBugBash(args, ENV, stop, deps)).toBe(5);
  expect(calls).toHaveLength(2);
});

test("B2: a fault reported from inside a running job stops every running job at once", async () => {
  const { deps, calls } = fakeLaunch(async (call, index) => {
    if (index === 1) call.o.onProxyFault!("proxy: a call cost more than its reserved bound");
    // Every job, the faulty one too, runs until its stop comes: only the halt ends them.
    const outcome = await until(call.o.stop);
    return { ...outcome, stopped: undefined, ...(index === 1 && { proxyFault: "x" }) };
  });
  const stop = new AbortController().signal;
  const args = [...charters("a", "b", "c"), "--parallel", "2"];
  expect(await runBugBash(args, ENV, stop, deps)).toBe(5);
  expect(calls).toHaveLength(2); // the third never starts
});

test("B2: an unknown container state outranks the stop of the run", async () => {
  const stop = new AbortController();
  const { deps } = fakeLaunch(() => {
    stop.abort("SIGTERM");
    return { code: 0, cleanup: "unknown: process groups 1 still run", stopped: "SIGTERM" };
  });
  expect(await runBugBash([...charters("a", "b")], ENV, stop.signal, deps)).toBe(3);
});

test("B2: a stopped run exits with the signal, and a refused launch exits 2", async () => {
  const stop = new AbortController();
  const first = fakeLaunch(() => {
    stop.abort("SIGTERM");
    return { code: 0, cleanup: "removed", stopped: "SIGTERM" };
  });
  expect(await runBugBash([...charters("a", "b")], ENV, stop.signal, first.deps)).toBe(143);
  expect(first.calls).toHaveLength(1);
  const refused = fakeLaunch(() => {
    throw new Refusal("docker: no endpoint");
  });
  const live = new AbortController().signal;
  expect(await runBugBash([...charters("a")], ENV, live, refused.deps)).toBe(2);
});

test("D1: a charter whose e2e exits 3 ends the run with 6, and only an unknown container gives 3", async () => {
  const stop = new AbortController().signal;
  const own3 = fakeLaunch(() => ({ code: 3, cleanup: "removed" }));
  expect(await runBugBash([...charters("a")], ENV, stop, own3.deps)).toBe(6);
  const unknown = fakeLaunch(() => ({ code: 3, cleanup: "unknown: x" }));
  expect(await runBugBash([...charters("a")], ENV, stop, unknown.deps)).toBe(3);
});

test("B2: a charter that exits 130 on its own fails the run", async () => {
  const { deps } = fakeLaunch(() => ({ code: 130, cleanup: "removed" }));
  const stop = new AbortController().signal;
  expect(await runBugBash([...charters("a")], ENV, stop, deps)).toBe(130);
});

test("B2: a config other than the two bug-bash ones refuses (exit 2) before any job or folder", async () => {
  const { deps, calls, lines } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }));
  const stop = new AbortController().signal;
  // An existing file, so only the sandbox's config allowlist refuses it.
  const args = [...charters("a"), "--config", path.join(import.meta.dir, "run.ts")];
  expect(await runBugBash(args, ENV, stop, deps)).toBe(2);
  expect(calls).toHaveLength(0);
  expect(lines.join("\n")).toMatch(/only e2e\.config\.ts or e2e\.mcpapps\.config\.ts run/);
  expect(lines.some((line) => line.includes(" -> "))).toBe(false);
  // The MCP Apps config still runs.
  const mcp = fakeLaunch(() => ({ code: 0, cleanup: "removed" }));
  const mcpArgs = [
    ...charters("a"),
    "--config",
    path.join(import.meta.dir, "e2e.mcpapps.config.ts"),
  ];
  expect(await runBugBash(mcpArgs, ENV, stop, mcp.deps)).toBe(0);
  expect(mcp.calls[0].args).toContain("e2e.mcpapps.config.ts");
});

test.each([
  ["an unknown app AI mode", { BUGBASH_AI: "maybe" }, /auto, real or mock/],
  ["a mode resolved elsewhere", { BUGBASH_AI_RESOLVED: "real" }, /unset BUGBASH_AI_RESOLVED/],
  ["an unpriced app model", { BUGBASH_APP_MODEL: "anthropic:claude-x-9" }, /only a priced/],
  ["no budget", { BUGBASH_BUDGET_USD: "" }, /BUGBASH_BUDGET_USD/],
  ["no key", { ANTHROPIC_API_KEY: "" }, /ANTHROPIC_API_KEY/],
  ["an OpenAI model", { BUGBASH_MODELS: "openai:gpt-6.1-sol" }, /only anthropic/],
])("B2: %s refuses (exit 2) before any job or folder", async (_name, over, message) => {
  const { deps, calls, lines } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }));
  const stop = new AbortController().signal;
  expect(await runBugBash([...charters("a")], { ...ENV, ...over }, stop, deps)).toBe(2);
  expect(calls).toHaveLength(0);
  expect(lines.join("\n")).toMatch(message);
  expect(lines.some((line) => line.includes(" -> "))).toBe(false); // no run folder
});

// B3: the real app AI, resolved once on the host through the run's budget.
function chartersWithMock() {
  const [flag, file] = charters("a");
  fs.appendFileSync(file, "\nerrs|web|default|send '[mock:error] x' and read the error");
  return [flag, file];
}

test("B3: a probe answered 200 gives every charter the real app AI, except [mock:...] ones", async () => {
  const { deps, calls, probes } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }), 200);
  const stop = new AbortController().signal;
  expect(await runBugBash(chartersWithMock(), ENV, stop, deps)).toBe(0);
  expect(probes).toHaveLength(1);
  expect(probes[0]).toBe(calls[0].o.ledger!); // the probe spends from the run's one budget
  const real = calls.find((c) => c.args[1].startsWith("look at"))!;
  const mock = calls.find((c) => c.args[1].includes("[mock:"))!;
  expect(real.o.env).toMatchObject({
    BUGBASH_AI: "real",
    BUGBASH_AI_RESOLVED: "real",
    BUGBASH_APP_MODEL: "anthropic:claude-haiku-4-5",
  });
  expect(mock.o.env).toMatchObject({ BUGBASH_AI: "mock" });
  expect(mock.o.env.BUGBASH_AI_RESOLVED).toBeUndefined();
});

test.each([
  ["auto, upstream unavailable: the mock", {}, 502, 0],
  ["real, upstream unavailable: refused", { BUGBASH_AI: "real" }, 502, 2],
  ["auto, a rejected key: refused", {}, 401, 2],
  ["mock: no probe", { BUGBASH_AI: "mock" }, 200, 0],
])("B3: %s", async (_name, over, status, code) => {
  const { deps, calls, probes } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }), status);
  const stop = new AbortController().signal;
  expect(await runBugBash([...charters("a")], { ...ENV, ...over }, stop, deps)).toBe(code);
  if (code === 0) expect(calls[0].o.env.BUGBASH_AI).toBe("mock");
  else expect(calls).toHaveLength(0);
  expect(probes).toHaveLength("BUGBASH_AI" in over && over.BUGBASH_AI === "mock" ? 0 : 1);
});

test("B3: a stop during the app AI probe ends the run before any job", async () => {
  const stop = new AbortController();
  const { deps, calls } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }));
  deps.probeApp = (_job, _model, _ledger, signal) => {
    expect(signal).toBe(stop.signal); // the run's stop reaches the probe
    stop.abort("SIGINT");
    return Promise.resolve({ status: 502, records: [] });
  };
  expect(await runBugBash([...charters("a")], ENV, stop.signal, deps)).toBe(130);
  expect(calls).toHaveLength(0);
});

test("B3: a proxy fault in the probe stops the run before any job (exit 5)", async () => {
  const { deps, calls } = fakeLaunch(() => ({ code: 0, cleanup: "removed" }));
  deps.probeApp = () => Promise.reject(new Error("proxy: 1 call(s) cost more"));
  const stop = new AbortController().signal;
  expect(await runBugBash([...charters("a")], ENV, stop, deps)).toBe(5);
  expect(calls).toHaveLength(0);
});
