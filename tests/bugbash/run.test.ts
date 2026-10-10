import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RunDeps, runBugBash } from "./run";
import type { JobOutcome, LaunchOptions } from "./sandbox/launch";
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
function fakeLaunch(outcome: (call: Call, index: number) => Promise<JobOutcome> | JobOutcome) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const deps: RunDeps = {
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
  return { deps, calls, lines };
}
const until = (signal: AbortSignal): Promise<JobOutcome> =>
  new Promise((resolve) =>
    signal.addEventListener("abort", () =>
      resolve({ code: 130, cleanup: "removed", stopped: String(signal.reason) })
    )
  );

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

test.each([
  ["the real app AI", { BUGBASH_AI: "real" }, /only the mock app AI/],
  ["auto", { BUGBASH_AI: "auto" }, /only the mock app AI/],
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
