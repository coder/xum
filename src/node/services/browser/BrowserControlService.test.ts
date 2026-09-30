import { PassThrough } from "node:stream";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  BrowserControlService,
  type BrowserControlAction,
  type BrowserControlParams,
} from "./BrowserControlService";
import type { SendAgentBrowserDaemonCommandFn } from "./agentBrowserCommandClient";

const WORKSPACE_ID = "workspace-1";
const SESSION_NAME = "session-a";

class MockChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kill = mock(() => true);
  public readonly pid = undefined;
  public readonly stdin = null;
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "close") {
      this.exitCode = (args[0] as number | null | undefined) ?? null;
      this.signalCode = (args[1] as NodeJS.Signals | null | undefined) ?? null;
    }
    if (event === "error") {
      this.killed = true;
    }
    return super.emit(event, ...args);
  }

  writeStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  writeStderr(chunk: string): void {
    this.stderr.write(chunk);
  }

  close(code = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
    this.stdout.end();
    this.stderr.end();
  }

  fail(error: Error): void {
    this.emit("error", error);
    this.stdout.end();
    this.stderr.end();
  }
}

function createAttachableSession() {
  return {
    sessionName: SESSION_NAME,
    pid: 101,
    cwd: "/tmp/project",
    status: "attachable" as const,
    streamPort: 9222,
  };
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function createService(options?: {
  getSessionConnection?: (
    workspaceId: string,
    sessionName: string,
    options?: { allowOtherWorkspaceSession?: boolean }
  ) => Promise<ReturnType<typeof createAttachableSession> | null>;
  resolveSessionEnvFn?: (workspaceId: string) => Promise<NodeJS.ProcessEnv>;
  spawnFn?: SpawnFn;
  sendDaemonCommandFn?: SendAgentBrowserDaemonCommandFn;
  timeoutMs?: number;
}): BrowserControlService {
  return new BrowserControlService({
    browserSessionDiscoveryService: {
      getSessionConnection:
        options?.getSessionConnection ??
        mock((_workspaceId: string, _sessionName: string) =>
          Promise.resolve(createAttachableSession())
        ),
    },
    resolveSessionEnvFn:
      options?.resolveSessionEnvFn ??
      mock(() => Promise.resolve({ AGENT_BROWSER_SOCKET_DIR: "/tmp/socket" })),
    spawnFn: options?.spawnFn,
    sendDaemonCommandFn: options?.sendDaemonCommandFn,
    timeoutMs: options?.timeoutMs,
  });
}

// CI saw occasional hangs when mocked child events were queued during spawn.
// Waiting until the service has definitely spawned the child keeps the tests
// independent of runtime-specific microtask ordering.
function createSpawnHarness(child: MockChildProcess) {
  const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  let resolveSpawned: (() => void) | null = null;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });

  return {
    spawnCalls,
    spawnFn: mock((command: string, args: string[], options: SpawnOptions) => {
      spawnCalls.push({ command, args, options });
      resolveSpawned?.();
      return child as unknown as ChildProcess;
    }),
    waitForSpawn: () => spawned,
  };
}

async function expectRejectMessage<T>(promise: Promise<T>, message: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected promise to reject with: ${message}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

afterEach(() => {
  mock.restore();
});

describe("BrowserControlService", () => {
  test("executeControl builds the expected CLI args for each action", async () => {
    const actionCases: Array<{
      action: BrowserControlAction;
      url?: string;
      expectedArgs: string[];
    }> = [
      {
        action: "open",
        url: "https://example.com/path",
        expectedArgs: ["--session", SESSION_NAME, "open", "https://example.com/path"],
      },
      {
        action: "back",
        expectedArgs: ["--session", SESSION_NAME, "back"],
      },
      {
        action: "forward",
        expectedArgs: ["--session", SESSION_NAME, "forward"],
      },
      {
        action: "reload",
        expectedArgs: ["--session", SESSION_NAME, "reload"],
      },
    ];

    for (const actionCase of actionCases) {
      const child = new MockChildProcess();
      const { spawnCalls, spawnFn, waitForSpawn } = createSpawnHarness(child);
      const resolveSessionEnvFn = mock(() => Promise.resolve({ TEST_ENV: "1" }));
      const service = createService({
        spawnFn,
        resolveSessionEnvFn,
      });

      const params: BrowserControlParams = {
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: actionCase.action,
        url: actionCase.url,
      };

      const executionPromise = service.executeControl(params);
      await waitForSpawn();
      child.close();

      expect(await executionPromise).toEqual({ success: true });
      expect(resolveSessionEnvFn).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.command).toBe("agent-browser");
      expect(spawnCalls[0]?.args).toEqual(actionCase.expectedArgs);
      expect(spawnCalls[0]?.options).toMatchObject({
        env: { TEST_ENV: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    }
  });

  test("executeControl sends explicit file URLs directly to the daemon", async () => {
    const spawnFn = mock(() => new MockChildProcess() as unknown as ChildProcess);
    const resolveSessionEnvFn = mock(() => Promise.resolve({ TEST_ENV: "1" }));
    const daemonCommandCalls: Array<Parameters<SendAgentBrowserDaemonCommandFn>[0]> = [];
    const sendDaemonCommandFn = mock((options: Parameters<SendAgentBrowserDaemonCommandFn>[0]) => {
      daemonCommandCalls.push(options);
      return Promise.resolve({ success: true });
    });
    const service = createService({
      spawnFn,
      resolveSessionEnvFn,
      sendDaemonCommandFn,
    });

    expect(
      await service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "open",
        url: "file:///Users/me/report.html",
      })
    ).toEqual({ success: true });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(resolveSessionEnvFn).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(sendDaemonCommandFn).toHaveBeenCalledTimes(1);
    expect(daemonCommandCalls).toHaveLength(1);
    expect(daemonCommandCalls[0]).toMatchObject({
      env: { TEST_ENV: "1" },
      sessionName: SESSION_NAME,
      timeoutMs: 15_000,
      command: {
        action: "navigate",
        url: "file:///Users/me/report.html",
      },
    });
    expect(typeof daemonCommandCalls[0]?.command.id).toBe("string");
  });

  test("executeControl does not fall back to the CLI when file URL daemon navigation fails", async () => {
    const spawnFn = mock(() => new MockChildProcess() as unknown as ChildProcess);
    const sendDaemonCommandFn = mock(() =>
      Promise.resolve({ success: false, error: "daemon rejected navigation" })
    );
    const service = createService({
      spawnFn,
      sendDaemonCommandFn,
    });

    expect(
      await service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "open",
        url: "file:///Users/me/report.html",
      })
    ).toEqual({ success: false, error: "daemon rejected navigation" });

    expect(sendDaemonCommandFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('executeControl requires a non-empty URL for "open"', async () => {
    const service = createService();

    await expectRejectMessage(
      service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "open",
      }),
      'BrowserControlService "open" requires a url'
    );

    await expectRejectMessage(
      service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "open",
        url: "   ",
      }),
      'BrowserControlService "open" requires a non-empty url'
    );
  });

  test('executeControl rejects URLs for non-"open" actions', async () => {
    const service = createService();

    await expectRejectMessage(
      service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "back",
        url: "https://example.com",
      }),
      'BrowserControlService action "back" does not accept a url'
    );
  });

  test("executeControl fails closed on unknown actions", async () => {
    const service = createService();

    await expectRejectMessage(
      service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "unknown" as BrowserControlAction,
      }),
      "Unsupported browser control action: unknown"
    );
  });

  test("executeControl validates the session before spawning the CLI", async () => {
    const spawnFn = mock(() => new MockChildProcess() as unknown as ChildProcess);
    const service = createService({
      getSessionConnection: mock(() => Promise.resolve(null)),
      spawnFn,
    });

    expect(
      await service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "reload",
      })
    ).toEqual({
      success: false,
      error: `Session "${SESSION_NAME}" not found for workspace "${WORKSPACE_ID}"`,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test("executeControl validates explicitly allowed other sessions with matching scope", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const getSessionConnection = mock(() => Promise.resolve(createAttachableSession()));
    const service = createService({
      getSessionConnection,
      spawnFn,
    });

    const executionPromise = service.executeControl({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
      action: "reload",
      allowOtherWorkspaceSession: true,
    });
    await waitForSpawn();
    child.close();

    expect(await executionPromise).toEqual({ success: true });
    expect(getSessionConnection).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_NAME, {
      allowOtherWorkspaceSession: true,
    });
  });

  test("getUrl validates explicitly allowed other sessions with matching scope", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const getSessionConnection = mock(() => Promise.resolve(createAttachableSession()));
    const service = createService({
      getSessionConnection,
      spawnFn,
    });

    const resultPromise = service.getUrl(WORKSPACE_ID, SESSION_NAME, {
      allowOtherWorkspaceSession: true,
    });
    await waitForSpawn();
    child.writeStdout("https://example.com/current\n");
    child.close();

    expect(await resultPromise).toEqual({ url: "https://example.com/current" });
    expect(getSessionConnection).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_NAME, {
      allowOtherWorkspaceSession: true,
    });
  });

  test("getUrl parses stdout from the CLI", async () => {
    const child = new MockChildProcess();
    const { spawnCalls, spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.getUrl(WORKSPACE_ID, SESSION_NAME);
    await waitForSpawn();
    child.writeStdout("https://example.com/current\n");
    child.close();

    expect(await resultPromise).toEqual({
      url: "https://example.com/current",
    });
    expect(spawnCalls[0]?.args).toEqual(["--session", SESSION_NAME, "get", "url"]);
  });

  test("listTabs parses tab metadata from the CLI", async () => {
    const child = new MockChildProcess();
    const { spawnCalls, spawnFn, waitForSpawn } = createSpawnHarness(child);
    const getSessionConnection = mock(() => Promise.resolve(createAttachableSession()));
    const service = createService({ getSessionConnection, spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
      allowOtherWorkspaceSession: true,
    });
    await waitForSpawn();
    child.writeStdout(
      JSON.stringify({
        success: true,
        data: {
          tabs: [
            {
              active: false,
              label: null,
              tabId: "t1",
              title: "First",
              type: "page",
              url: "about:blank",
            },
            {
              active: true,
              label: "docs",
              tabId: "t2",
              title: "Docs",
              type: "webview",
              url: "https://docs.example.com/",
            },
          ],
        },
        error: null,
      })
    );
    child.close();

    expect(await resultPromise).toEqual({
      tabs: [
        {
          active: false,
          label: null,
          tabId: "t1",
          title: "First",
          type: "page",
          url: "about:blank",
        },
        {
          active: true,
          label: "docs",
          tabId: "t2",
          title: "Docs",
          type: "webview",
          url: "https://docs.example.com/",
        },
      ],
    });
    expect(getSessionConnection).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_NAME, {
      allowOtherWorkspaceSession: true,
    });
    expect(spawnCalls[0]?.args).toEqual(["--json", "--session", SESSION_NAME, "tab"]);
  });

  test("listTabs surfaces structured JSON errors from the CLI", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
    });
    await waitForSpawn();
    child.writeStdout(
      JSON.stringify({
        success: false,
        data: null,
        error: "tab list failed",
      })
    );
    child.close();

    expect(await resultPromise).toEqual({ tabs: [], error: "tab list failed" });
  });

  test("listTabs reports structured CLI failures without details", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
    });
    await waitForSpawn();
    child.writeStdout(JSON.stringify({ success: false, data: null, error: "" }));
    child.close();

    expect(await resultPromise).toEqual({ tabs: [], error: "failed without details" });
  });

  test("listTabs reports invalid JSON from the CLI", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
    });
    await waitForSpawn();
    child.writeStdout("not-json");
    child.close();

    expect(await resultPromise).toEqual({ tabs: [], error: "invalid JSON" });
  });

  test("listTabs reports unexpected CLI payloads", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
    });
    await waitForSpawn();
    child.writeStdout(JSON.stringify({ success: true, data: {} }));
    child.close();

    expect(await resultPromise).toEqual({ tabs: [], error: "unexpected JSON payload" });
  });

  test("listTabs filters non-page targets and malformed entries", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
    });
    await waitForSpawn();
    child.writeStdout(
      JSON.stringify({
        success: true,
        data: {
          tabs: [
            null,
            {
              active: true,
              label: null,
              tabId: "t1",
              title: "First",
              type: "page",
              url: "about:blank",
            },
            {
              active: false,
              label: null,
              tabId: "malformed-page",
              type: "page",
              url: "https://example.com/malformed",
            },
            {
              active: false,
              label: null,
              tabId: "worker-1",
              title: "Worker",
              type: "service_worker",
              url: "https://example.com/worker.js",
            },
          ],
        },
      })
    );
    child.close();

    expect(await resultPromise).toEqual({
      tabs: [
        {
          active: true,
          label: null,
          tabId: "t1",
          title: "First",
          type: "page",
          url: "about:blank",
        },
      ],
    });
  });

  test("listTabs reports when every page tab entry is malformed", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const resultPromise = service.listTabs({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
    });
    await waitForSpawn();
    child.writeStdout(
      JSON.stringify({
        success: true,
        data: {
          tabs: [
            {
              active: true,
              label: null,
              tabId: "t1",
              type: "page",
              url: "about:blank",
            },
          ],
        },
      })
    );
    child.close();

    expect(await resultPromise).toEqual({ tabs: [], error: "all tab entries failed validation" });
  });

  test("selectTab switches the active browser tab", async () => {
    const child = new MockChildProcess();
    const { spawnCalls, spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const executionPromise = service.selectTab({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
      tabRef: " t2 ",
    });
    await waitForSpawn();
    child.close();

    expect(await executionPromise).toEqual({ success: true });
    expect(spawnCalls[0]?.args).toEqual(["--session", SESSION_NAME, "tab", "t2"]);
  });

  test("selectTab rejects flag-like tab refs before spawning the CLI", async () => {
    const spawnFn = mock(() => new MockChildProcess() as unknown as ChildProcess);
    const service = createService({ spawnFn });

    expect(
      await service.selectTab({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        tabRef: " --help ",
      })
    ).toEqual({ success: false, error: "Browser tab ref must not start with '-'" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test("selectTab validates the session before spawning the CLI", async () => {
    const spawnFn = mock(() => new MockChildProcess() as unknown as ChildProcess);
    const service = createService({
      getSessionConnection: mock(() => Promise.resolve(null)),
      spawnFn,
    });

    expect(
      await service.selectTab({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        tabRef: "t2",
      })
    ).toEqual({
      success: false,
      error: `Session "${SESSION_NAME}" not found for workspace "${WORKSPACE_ID}"`,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test("selectTab validates explicitly allowed other sessions with matching scope", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const getSessionConnection = mock(() => Promise.resolve(createAttachableSession()));
    const service = createService({
      getSessionConnection,
      spawnFn,
    });

    const executionPromise = service.selectTab({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
      tabRef: "t2",
      allowOtherWorkspaceSession: true,
    });
    await waitForSpawn();
    child.close();

    expect(await executionPromise).toEqual({ success: true });
    expect(getSessionConnection).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_NAME, {
      allowOtherWorkspaceSession: true,
    });
  });

  test("executeControl returns timeout errors", async () => {
    const child = new MockChildProcess();
    const service = createService({
      spawnFn: mock(() => child as unknown as ChildProcess),
      timeoutMs: 5,
    });

    expect(
      await service.executeControl({
        workspaceId: WORKSPACE_ID,
        sessionName: SESSION_NAME,
        action: "reload",
      })
    ).toEqual({
      success: false,
      error: `agent-browser reload for session ${SESSION_NAME} timed out after 5ms`,
    });
  });

  test("executeControl surfaces stderr when the CLI exits with an error", async () => {
    const child = new MockChildProcess();
    const { spawnFn, waitForSpawn } = createSpawnHarness(child);
    const service = createService({ spawnFn });

    const executionPromise = service.executeControl({
      workspaceId: WORKSPACE_ID,
      sessionName: SESSION_NAME,
      action: "forward",
    });
    await waitForSpawn();
    child.writeStderr("navigation failed\n");
    child.close(1);

    expect(await executionPromise).toEqual({
      success: false,
      error: "navigation failed",
    });
  });
});
