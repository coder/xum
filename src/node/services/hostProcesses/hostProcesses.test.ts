import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as disposableExec from "@/node/utils/disposableExec";
import {
  gitNoRepoAutomationEnvForLocalRepo,
  LOCAL_DISCOVERY_AUTOMATION_ERROR,
} from "@/node/utils/gitNoHooksEnv";
import type { HostProcesses } from "./hostProcesses";
import { nodeHostProcesses } from "./nodeHostProcesses";
import { commandLine, createScriptedHostProcesses } from "./scriptedCommands.testHarness";

// Two real commands: the running binary (bun) evaluates a one-line script.
const PRINTS_OK: [string, string[]] = [process.execPath, ["-e", "process.stdout.write('ok')"]];
const FAILS: [string, string[]] = [
  process.execPath,
  ["-e", "process.stderr.write('boom'); process.exit(3)"],
];
const HANGS: [string, string[]] = [process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]];

async function outcome(processes: HostProcesses, [file, args]: [string, string[]]) {
  using proc = processes.execFile(file, args);
  // Awaited here: `using` kills a running child when the function returns.
  return await proc.result.then(
    (output) => ({ output }),
    (error: Error & { code: unknown; stderr: unknown }) => ({
      error: { message: error.message, code: error.code, stderr: error.stderr },
    })
  );
}

// The scripted layer must answer the way execFileAsync does, so a test that swaps the Node layer
// for it sees the same results and the same rejections.
describe.each([
  ["node", () => nodeHostProcesses],
  [
    "scripted",
    () =>
      createScriptedHostProcesses({
        [commandLine(...PRINTS_OK)]: { stdout: "ok" },
        [commandLine(...FAILS)]: { stderr: "boom", exitCode: 3 },
        [commandLine(...HANGS)]: () => new Promise(() => undefined),
      }),
  ],
] as const)("HostProcesses on the %s layer", (_name, create) => {
  test("a command that exits 0 resolves with its output", async () => {
    expect(await outcome(create(), PRINTS_OK)).toEqual({ output: { stdout: "ok", stderr: "" } });
  });

  test("a command that exits non-zero rejects with its stderr and exit code", async () => {
    expect(await outcome(create(), FAILS)).toEqual({
      error: { message: "boom", code: 3, stderr: "boom" },
    });
  });

  test("an abort after the start rejects as a kill by SIGTERM", async () => {
    const controller = new AbortController();
    using proc = create().execFile(HANGS[0], HANGS[1], { signal: controller.signal });
    controller.abort();
    const error = await proc.result.then(
      () => null,
      (rejection: Error & { code: unknown; signal: unknown }) => rejection
    );
    expect([error?.message, error?.code, error?.signal]).toEqual([
      "Command killed by signal SIGTERM",
      null,
      "SIGTERM",
    ]);
  });
});

describe("the scripted layer", () => {
  test("a key tells apart argv arrays that join to the same string", async () => {
    const processes = createScriptedHostProcesses({ 'git show "a b"': { stdout: "one arg" } });
    expect(await outcome(processes, ["git", ["show", "a b"]])).toEqual({
      output: { stdout: "one arg", stderr: "" },
    });
    expect(await outcome(processes, ["git", ["show a", "b"]])).toEqual({
      error: { message: 'No scripted command: git "show a" b', code: null, stderr: "" },
    });
  });

  test("a command without an entry rejects and names the command, and every call is recorded", async () => {
    const processes = createScriptedHostProcesses({});
    expect(await outcome(processes, ["git", ["--version"]])).toEqual({
      error: { message: "No scripted command: git --version", code: null, stderr: "" },
    });
    expect(processes.calls).toEqual([{ file: "git", args: ["--version"], cwd: undefined }]);
  });

  test("an option that the entry cannot honor is refused by name, and one that holds passes", async () => {
    const processes = createScriptedHostProcesses({
      "git status": { stdout: "clean", stderr: "!" },
      "git fetch": () => ({ stdout: "" }),
    });
    const run = (args: string[], options: Parameters<HostProcesses["execFile"]>[2]) => {
      using proc = processes.execFile("git", args, options);
      return proc.result.then(
        (output) => output.stdout,
        (error: Error) => error.message
      );
    };
    // A fixed outcome settles at once and reads no environment.
    expect(
      await run(["status"], {
        timeoutMs: 10,
        killTreeOnTermination: true,
        env: {},
        maxOutputBytes: 6,
      })
    ).toBe("clean");
    expect(await run(["status"], { maxOutputBytes: 5 })).toBe(
      "The scripted layer cannot honor the option maxOutputBytes for: git status"
    );
    expect(await run(["status"], { onStderrData: () => undefined })).toBe(
      "The scripted layer cannot honor the option onStderrData for: git status"
    );
    // A function entry can be slow and gets only the call.
    expect(await run(["fetch"], { timeoutMs: 10 })).toBe(
      "The scripted layer cannot honor the option timeoutMs for: git fetch"
    );
    expect(await run(["fetch"], { env: {} })).toBe(
      "The scripted layer cannot honor the option env for: git fetch"
    );
  });

  test("fetchUrl answers a scripted URL and rejects any other", async () => {
    const processes = createScriptedHostProcesses(
      {},
      { "https://a.test/x": () => new Response("hi") }
    );
    expect(await (await processes.fetchUrl("https://a.test/x")).text()).toBe("hi");
    expect(
      await processes.fetchUrl("https://a.test/y").catch((error: Error) => error.message)
    ).toBe("No scripted URL: https://a.test/y");
  });

  test("the repo-automation probe spawns through the processes it gets and fails closed", async () => {
    const processes = createScriptedHostProcesses({});
    let refusal: unknown;
    try {
      await gitNoRepoAutomationEnvForLocalRepo("/repo", undefined, true, processes);
    } catch (error) {
      refusal = error;
    }
    expect((refusal as Error).message).toBe(LOCAL_DISCOVERY_AUTOMATION_ERROR);
    expect(processes.calls).toHaveLength(1);
  });
});

// skillsCatalogFetch.test.ts and gitNoHooksEnv.discovery.test.ts spy on these bindings. Their
// spies reach the moved callers only if the Node layer reads each binding at call time.
describe("the Node layer reads its bindings at call time", () => {
  afterEach(() => {
    mock.restore();
  });

  test("a spy on the disposableExec namespace reaches execFile", () => {
    const spawned = spyOn(disposableExec, "execFileAsync").mockImplementation(() => {
      throw new Error("injected");
    });
    expect(() => nodeHostProcesses.execFile("git", ["--version"])).toThrow("injected");
    expect(spawned).toHaveBeenCalledWith("git", ["--version"], undefined);
  });

  test("a spy on globalThis.fetch reaches fetchUrl", async () => {
    const fetched = spyOn(globalThis, "fetch").mockResolvedValue(new Response("spied"));
    expect(await (await nodeHostProcesses.fetchUrl("https://a.test/")).text()).toBe("spied");
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});
