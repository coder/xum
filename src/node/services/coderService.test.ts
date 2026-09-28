import { EventEmitter } from "events";
import { Readable } from "stream";
import { describe, it, expect, vi, beforeEach, afterEach, spyOn } from "bun:test";
import { CoderService, compareVersions } from "./coderService";
import * as childProcess from "child_process";
import * as muxSshConfigWriter from "@/node/runtime/muxSshConfigWriter";
import * as disposableExec from "@/node/utils/disposableExec";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

/**
 * Mock execAsync / execFileAsync for non-streaming tests.
 * Uses spyOn instead of vi.mock to avoid polluting other test files.
 */
let execAsyncSpy: ReturnType<typeof spyOn<typeof disposableExec, "execAsync">> | null = null;
let execFileAsyncSpy: ReturnType<typeof spyOn<typeof disposableExec, "execFileAsync">> | null =
  null;

// Minimal mock that satisfies the interface used by CoderService
// Uses cast via `unknown` because we only implement the subset actually used by tests
function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  // Prevent Bun from surfacing immediate Promise.reject() as an unhandled rejection
  // before CoderService awaits proc.result.
  void result.catch(noop);

  const mock = {
    result,
    get promise() {
      return result;
    },
    child: {}, // not used by CoderService
    [Symbol.dispose]: noop,
  };
  return mock as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

function mockExecOk(stdout: string, stderr = ""): void {
  execFileAsyncSpy?.mockReturnValue(createMockExecResult(Promise.resolve({ stdout, stderr })));
}

function mockExecError(error: Error): void {
  execFileAsyncSpy?.mockReturnValue(createMockExecResult(Promise.reject(error)));
}

function isCoderCommand(file: string, args: string[], expectedArgs: string[]): boolean {
  return (
    file === "coder" &&
    args.length === expectedArgs.length &&
    args.every((arg, i) => arg === expectedArgs[i])
  );
}

function mockVersionAndWhoami(options: { version: string; username?: string }): void {
  execAsyncSpy?.mockImplementationOnce(() =>
    createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
  );
  execFileAsyncSpy?.mockImplementationOnce(() =>
    createMockExecResult(
      Promise.resolve({ stdout: JSON.stringify({ version: options.version }), stderr: "" })
    )
  );
  const whoamiPayload = {
    url: "https://coder.example.com",
    ...(options.username ? { username: options.username } : {}),
  };
  execFileAsyncSpy?.mockImplementationOnce(() =>
    createMockExecResult(Promise.resolve({ stdout: JSON.stringify([whoamiPayload]), stderr: "" }))
  );
}

/**
 * Mock spawn for streaming createWorkspace() tests.
 * Uses spyOn instead of vi.mock to avoid polluting other test files.
 */
let spawnSpy: ReturnType<typeof spyOn<typeof childProcess, "spawn">> | null = null;

function mockCoderCommandResult(options: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): void {
  const stdout = Readable.from(options.stdout ? [Buffer.from(options.stdout)] : []);
  const stderr = Readable.from(options.stderr ? [Buffer.from(options.stderr)] : []);
  const events = new EventEmitter();

  spawnSpy?.mockReturnValue({
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  } as never);

  // Emit close after handlers are attached.
  setTimeout(() => events.emit("close", options.exitCode), 0);
}

type RichParameter = Parameters<CoderService["computeExtraParams"]>[0][number];

interface CoderServiceTestAccess {
  runCoderCommand: (
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error?: string;
  }>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function richParam(name: string, overrides: Partial<RichParameter> = {}): RichParameter {
  return {
    name,
    defaultValue: "val",
    type: "string",
    ephemeral: false,
    required: false,
    ...overrides,
  };
}

function getServiceTestAccess(service: CoderService): CoderServiceTestAccess {
  return service as unknown as CoderServiceTestAccess;
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _line of iterable) {
    // drain
  }
}

describe("CoderService", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
    vi.clearAllMocks();
    // Set up spies for mocking - uses spyOn instead of vi.mock to avoid polluting other test files
    execAsyncSpy = spyOn(disposableExec, "execAsync");
    execFileAsyncSpy = spyOn(disposableExec, "execFileAsync");
    spawnSpy = spyOn(childProcess, "spawn");
  });

  afterEach(() => {
    execAsyncSpy?.mockRestore();
    execAsyncSpy = null;
    execFileAsyncSpy?.mockRestore();
    execFileAsyncSpy = null;
    spawnSpy?.mockRestore();
    spawnSpy = null;
  });

  describe("getCoderInfo", () => {
    it("returns available state with valid version", async () => {
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "available",
        version: "2.28.2",
        username: "coder-user",
        url: "https://coder.example.com",
      });
    });

    it("returns available state for exact minimum version", async () => {
      mockVersionAndWhoami({ version: "2.25.0", username: "coder-user" });

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "available",
        version: "2.25.0",
        username: "coder-user",
        url: "https://coder.example.com",
      });
    });

    it("returns outdated state for version below minimum", async () => {
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.24.9" }), stderr: "" })
        )
      );

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "outdated",
        version: "2.24.9",
        minVersion: "2.25.0",
        binaryPath: "/usr/local/bin/coder",
      });
    });

    it("returns outdated state without binaryPath when lookup fails", async () => {
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.reject(new Error("lookup failed")))
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.24.9" }), stderr: "" })
        )
      );

      const info = await service.getCoderInfo();

      expect(info).toEqual({ state: "outdated", version: "2.24.9", minVersion: "2.25.0" });
    });
    it("handles version with dev suffix", async () => {
      mockVersionAndWhoami({
        version: "2.28.2-devel+903c045b9",
        username: "coder-user",
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "available",
        version: "2.28.2-devel+903c045b9",
        username: "coder-user",
        url: "https://coder.example.com",
      });
    });

    it("returns unavailable state with not-logged-in reason when whoami fails", async () => {
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.reject(
            new Error(
              `Encountered an error running "coder whoami", see "coder whoami --help" for more information\nerror: You are not logged in. Try logging in using 'coder login <url>'.`
            )
          )
        )
      );

      const info = await service.getCoderInfo();

      expect(info).toMatchObject({
        state: "unavailable",
        reason: { kind: "not-logged-in" },
      });

      if (
        info.state !== "unavailable" ||
        typeof info.reason === "string" ||
        info.reason.kind !== "not-logged-in"
      ) {
        throw new Error(`Expected not-logged-in unavailable state, got: ${JSON.stringify(info)}`);
      }

      expect(info.reason.message).toContain("/usr/local/bin/coder");
      expect(info.reason.message.toLowerCase()).toContain("not logged in");
    });

    it("re-checks whoami after transient failure (does not cache error state)", async () => {
      // First call: whoami transient error
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.reject(new Error("error: Connection refused")))
      );

      // Second call: should try again (previous error must not be cached)
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.reject(new Error("error: Connection refused")))
      );

      const first = await service.getCoderInfo();
      expect(first).toMatchObject({ state: "unavailable", reason: { kind: "error" } });

      if (
        first.state !== "unavailable" ||
        typeof first.reason === "string" ||
        first.reason.kind !== "error"
      ) {
        throw new Error(`Expected unavailable error state, got: ${JSON.stringify(first)}`);
      }

      expect(first.reason.message.toLowerCase()).toContain("connection refused");

      const second = await service.getCoderInfo();
      expect(second).toMatchObject({ state: "unavailable", reason: { kind: "error" } });

      const whoamiCalls =
        execFileAsyncSpy?.mock.calls.filter(([file, args]) =>
          isCoderCommand(file, args, ["whoami", "--output=json"])
        ) ?? [];
      expect(whoamiCalls).toHaveLength(2);
    });

    it("re-checks login status after not-logged-in and caches once logged in", async () => {
      // First call: not logged in
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execFileAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.reject(
            new Error(
              `Encountered an error running "coder whoami", see "coder whoami --help" for more information\nerror: You are not logged in. Try logging in using 'coder login <url>'.`
            )
          )
        )
      );

      // Second call: now logged in
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });

      const first = await service.getCoderInfo();
      expect(first).toMatchObject({
        state: "unavailable",
        reason: { kind: "not-logged-in" },
      });

      if (
        first.state !== "unavailable" ||
        typeof first.reason === "string" ||
        first.reason.kind !== "not-logged-in"
      ) {
        throw new Error(`Expected not-logged-in unavailable state, got: ${JSON.stringify(first)}`);
      }

      expect(first.reason.message).toContain("/usr/local/bin/coder");
      expect(first.reason.message.toLowerCase()).toContain("not logged in");

      const second = await service.getCoderInfo();
      expect(second).toEqual({
        state: "available",
        version: "2.28.2",
        username: "coder-user",
        url: "https://coder.example.com",
      });

      const asyncCallsAfterSecond = execAsyncSpy?.mock.calls.length ?? 0;
      const fileCallsAfterSecond = execFileAsyncSpy?.mock.calls.length ?? 0;

      // Third call should come from cache (no extra exec calls)
      await service.getCoderInfo();
      expect(execAsyncSpy?.mock.calls.length ?? 0).toBe(asyncCallsAfterSecond);
      expect(execFileAsyncSpy?.mock.calls.length ?? 0).toBe(fileCallsAfterSecond);

      const whoamiCalls =
        execFileAsyncSpy?.mock.calls.filter(([file, args]) =>
          isCoderCommand(file, args, ["whoami", "--output=json"])
        ) ?? [];
      expect(whoamiCalls).toHaveLength(2);
    });

    it("returns unavailable state with reason missing when CLI not installed", async () => {
      mockExecError(new Error("command not found: coder"));

      const info = await service.getCoderInfo();

      expect(info).toEqual({ state: "unavailable", reason: "missing" });
    });

    it("returns unavailable state with error reason for other errors", async () => {
      mockExecError(new Error("Connection refused"));

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "unavailable",
        reason: { kind: "error", message: "Connection refused" },
      });
    });

    it("returns unavailable state with error when version is missing from output", async () => {
      mockExecOk(JSON.stringify({}));

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "unavailable",
        reason: { kind: "error", message: "Version output missing from CLI" },
      });
    });

    it("caches the result", async () => {
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });

      await service.getCoderInfo();
      await service.getCoderInfo();

      expect(execAsyncSpy).toHaveBeenCalledTimes(1);
      expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("verifyAuthenticatedSession", () => {
    it("resolves when coder whoami succeeds", async () => {
      execFileAsyncSpy?.mockImplementation((file: string, args: string[]) => {
        if (isCoderCommand(file, args, ["whoami", "--output=json"])) {
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                { url: "https://coder.example.com", username: "coder-user", id: "user-1" },
              ]),
              stderr: "",
            })
          );
        }
        return createMockExecResult(
          Promise.reject(new Error(`Unexpected command: ${file} ${args.join(" ")}`))
        );
      });

      await service.verifyAuthenticatedSession();
      expect(execFileAsyncSpy).toHaveBeenCalledTimes(1);
    });

    it("throws when coder whoami fails (not logged in)", async () => {
      execFileAsyncSpy?.mockImplementation((file: string, args: string[]) => {
        if (isCoderCommand(file, args, ["whoami", "--output=json"])) {
          return createMockExecResult(Promise.reject(new Error("error: not logged in")));
        }
        return createMockExecResult(
          Promise.reject(new Error(`Unexpected command: ${file} ${args.join(" ")}`))
        );
      });

      try {
        await service.verifyAuthenticatedSession();
        throw new Error("expected verifyAuthenticatedSession to throw");
      } catch (error) {
        expect((error as Error).message).toContain("not logged in");
      }
      expect(execFileAsyncSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("listTemplates", () => {
    it("returns templates with display names", async () => {
      execFileAsyncSpy?.mockReturnValue(
        createMockExecResult(
          Promise.resolve({
            stdout: JSON.stringify([
              {
                Template: {
                  name: "template-1",
                  display_name: "Template One",
                  organization_name: "org1",
                },
              },
              { Template: { name: "template-2", display_name: "Template Two" } },
            ]),
            stderr: "",
          })
        )
      );

      const templates = await service.listTemplates();

      expect(templates).toEqual({
        ok: true,
        templates: [
          { name: "template-1", displayName: "Template One", organizationName: "org1" },
          { name: "template-2", displayName: "Template Two", organizationName: "default" },
        ],
      });
    });

    it("uses name as displayName when display_name not present", async () => {
      execFileAsyncSpy?.mockReturnValue(
        createMockExecResult(
          Promise.resolve({
            stdout: JSON.stringify([{ Template: { name: "my-template" } }]),
            stderr: "",
          })
        )
      );

      const templates = await service.listTemplates();

      expect(templates).toEqual({
        ok: true,
        templates: [
          { name: "my-template", displayName: "my-template", organizationName: "default" },
        ],
      });
    });

    it("returns error result on error", async () => {
      mockExecError(new Error("not logged in"));

      const templates = await service.listTemplates();

      expect(templates).toEqual({ ok: false, error: "not logged in" });
    });

    it("returns empty array for empty output", async () => {
      mockExecOk("");

      const templates = await service.listTemplates();

      expect(templates).toEqual({ ok: true, templates: [] });
    });
  });

  describe("listPresets", () => {
    it("returns presets for a template", async () => {
      mockExecOk(
        JSON.stringify([
          {
            TemplatePreset: {
              ID: "preset-1",
              Name: "Small",
              Description: "Small instance",
              Default: true,
            },
          },
          {
            TemplatePreset: {
              ID: "preset-2",
              Name: "Large",
              Description: "Large instance",
            },
          },
        ])
      );

      const presets = await service.listPresets("my-template");

      expect(presets).toEqual({
        ok: true,
        presets: [
          { id: "preset-1", name: "Small", description: "Small instance", isDefault: true },
          { id: "preset-2", name: "Large", description: "Large instance", isDefault: false },
        ],
      });
    });

    it("returns empty array when template has no presets", async () => {
      mockExecOk("");

      const presets = await service.listPresets("no-presets-template");

      expect(presets).toEqual({ ok: true, presets: [] });
    });

    it("returns empty array when CLI prints info message instead of JSON", async () => {
      mockExecOk('No presets found for template "my-template" and template-version "v1".\n');

      const presets = await service.listPresets("my-template");

      expect(presets).toEqual({ ok: true, presets: [] });
    });

    it("returns error result on error", async () => {
      mockExecError(new Error("template not found"));

      const presets = await service.listPresets("nonexistent");

      expect(presets).toEqual({ ok: false, error: "template not found" });
    });
  });

  describe("listWorkspaces", () => {
    it("returns all workspaces regardless of status", async () => {
      mockExecOk(
        JSON.stringify([
          {
            name: "ws-1",
            template_name: "t1",
            template_display_name: "t1",
            latest_build: { status: "running" },
          },
          {
            name: "ws-2",
            template_name: "t2",
            template_display_name: "t2",
            latest_build: { status: "stopped" },
          },
          {
            name: "ws-3",
            template_name: "t3",
            template_display_name: "t3",
            latest_build: { status: "starting" },
          },
        ])
      );

      const workspaces = await service.listWorkspaces();

      expect(workspaces).toEqual({
        ok: true,
        workspaces: [
          { name: "ws-1", templateName: "t1", templateDisplayName: "t1", status: "running" },
          { name: "ws-2", templateName: "t2", templateDisplayName: "t2", status: "stopped" },
          { name: "ws-3", templateName: "t3", templateDisplayName: "t3", status: "starting" },
        ],
      });
    });

    it("returns error result on failure", async () => {
      mockExecError(
        new Error(
          `Encountered an error running "coder list", see "coder list --help" for more information\nerror: You are not logged in. Try logging in using '/usr/local/bin/coder login <url>'.`
        )
      );

      const workspaces = await service.listWorkspaces();

      expect(workspaces).toEqual({
        ok: false,
        error: "You are not logged in. Try logging in using '/usr/local/bin/coder login <url>'.",
      });
    });
  });

  describe("workspaceExists", () => {
    it("returns true when exact match is found in search results", async () => {
      mockExecOk(JSON.stringify([{ name: "ws-1" }, { name: "ws-10" }]));

      const exists = await service.workspaceExists("ws-1");

      expect(exists).toBe(true);
    });

    it("returns false when only prefix matches", async () => {
      mockExecOk(JSON.stringify([{ name: "ws-10" }]));

      const exists = await service.workspaceExists("ws-1");

      expect(exists).toBe(false);
    });

    it("returns false on CLI error", async () => {
      mockExecError(new Error("not logged in"));

      const exists = await service.workspaceExists("ws-1");

      expect(exists).toBe(false);
    });
  });

  describe("getWorkspaceStatus", () => {
    it("returns status for exact match (search is prefix-based)", async () => {
      mockCoderCommandResult({
        exitCode: 0,
        stdout: JSON.stringify([
          { name: "ws-1", latest_build: { status: "running" } },
          { name: "ws-10", latest_build: { status: "stopped" } },
        ]),
      });

      const result = await service.getWorkspaceStatus("ws-1");

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.status).toBe("running");
      }
    });

    it("returns not_found when only prefix matches", async () => {
      mockCoderCommandResult({
        exitCode: 0,
        stdout: JSON.stringify([{ name: "ws-10", latest_build: { status: "running" } }]),
      });

      const result = await service.getWorkspaceStatus("ws-1");

      expect(result.kind).toBe("not_found");
    });

    it("returns error for unknown workspace status", async () => {
      mockCoderCommandResult({
        exitCode: 0,
        stdout: JSON.stringify([{ name: "ws-1", latest_build: { status: "weird" } }]),
      });

      const result = await service.getWorkspaceStatus("ws-1");

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.error).toContain("Unknown status");
      }
    });
  });

  describe("waitForStartupScripts", () => {
    it("streams stdout/stderr lines while waiting", async () => {
      mockCoderCommandResult({ exitCode: 0, stdout: "Waiting for agent...\nAgent ready\n" });

      const lines: string[] = [];
      for await (const line of service.waitForStartupScripts("my-ws")) {
        lines.push(line);
      }

      expect(lines).toContain("$ coder ssh my-ws --wait=yes -- true");
      expect(lines).toContain("Waiting for agent...");
      expect(lines).toContain("Agent ready");
      expect(spawnSpy).toHaveBeenCalledWith("coder", ["ssh", "my-ws", "--wait=yes", "--", "true"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

    it("throws when exit code is non-zero", async () => {
      mockCoderCommandResult({ exitCode: 1, stderr: "Connection refused\n" });

      const lines: string[] = [];
      const run = async () => {
        for await (const line of service.waitForStartupScripts("my-ws")) {
          lines.push(line);
        }
      };

      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe(
        "coder ssh --wait failed (exit 1): Connection refused"
      );
    });
  });

  describe("provisioning sessions", () => {
    function mockTokenCommands() {
      execFileAsyncSpy?.mockImplementation((file: string, args: string[]) => {
        if (
          file === "coder" &&
          args[0] === "tokens" &&
          args[1] === "create" &&
          args[2] === "--lifetime" &&
          args[3] === "5m" &&
          args[4] === "--name"
        ) {
          return createMockExecResult(Promise.resolve({ stdout: "token-123", stderr: "" }));
        }
        if (file === "coder" && args[0] === "tokens" && args[1] === "delete") {
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }
        return createMockExecResult(
          Promise.reject(new Error(`Unexpected command: ${file} ${args.join(" ")}`))
        );
      });
    }

    it("reuses provisioning sessions for the same workspace", async () => {
      mockTokenCommands();
      const session1 = await service.ensureProvisioningSession("ws");
      const session2 = await service.ensureProvisioningSession("ws");

      expect(session1).toBe(session2);
      expect(session1.token).toBe("token-123");

      await service.disposeProvisioningSession("ws");
      expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    });

    it("takeProvisioningSession returns and clears the session", async () => {
      mockTokenCommands();
      const session = await service.ensureProvisioningSession("ws");
      const taken = service.takeProvisioningSession("ws");

      expect(taken).toBe(session);
      expect(service.takeProvisioningSession("ws")).toBeUndefined();

      await taken?.dispose();
      expect(execFileAsyncSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("createWorkspace", () => {
    // Capture original fetch once per describe block to avoid nested mock issues
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    // Helper to mock the pre-fetch calls that happen before spawn
    function mockPrefetchCalls(options?: { presetParamNames?: string[] }) {
      // Mock getDeploymentUrl (coder whoami)
      // Mock getActiveTemplateVersionId (coder templates list)
      // Mock getPresetParamNames (coder templates presets list)
      // Mock getTemplateRichParameters (coder tokens create + fetch)
      execFileAsyncSpy?.mockImplementation((file: string, args: string[]) => {
        if (isCoderCommand(file, args, ["whoami", "--output=json"])) {
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                { url: "https://coder.example.com", username: "coder-user" },
              ]),
              stderr: "",
            })
          );
        }
        if (isCoderCommand(file, args, ["templates", "list", "--output=json"])) {
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                { Template: { name: "my-template", active_version_id: "version-123" } },
                { Template: { name: "tmpl", active_version_id: "version-456" } },
              ]),
              stderr: "",
            })
          );
        }
        if (
          file === "coder" &&
          args[0] === "templates" &&
          args[1] === "presets" &&
          args[2] === "list"
        ) {
          const paramNames = options?.presetParamNames ?? [];
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                {
                  TemplatePreset: {
                    Name: "preset",
                    Parameters: paramNames.map((name) => ({ Name: name })),
                  },
                },
              ]),
              stderr: "",
            })
          );
        }
        if (
          file === "coder" &&
          args[0] === "tokens" &&
          args[1] === "create" &&
          args[2] === "--lifetime" &&
          args[3] === "5m" &&
          args[4] === "--name"
        ) {
          return createMockExecResult(Promise.resolve({ stdout: "fake-token-123", stderr: "" }));
        }
        if (file === "coder" && args[0] === "tokens" && args[1] === "delete") {
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }
        // Fallback for any other command
        return createMockExecResult(
          Promise.reject(new Error(`Unexpected command: ${file} ${args.join(" ")}`))
        );
      });
    }

    // Helper to mock fetch for rich parameters API
    function mockFetchRichParams(
      params: Array<{
        name: string;
        default_value: string;
        ephemeral?: boolean;
        required?: boolean;
      }>
    ) {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(params),
      }) as unknown as typeof fetch;
    }

    it("streams stdout/stderr lines and passes expected args", async () => {
      mockPrefetchCalls();
      mockFetchRichParams([]);

      mockCoderCommandResult({ exitCode: 0, stdout: "out-1\nout-2\n", stderr: "err-1\n" });

      const lines: string[] = [];
      for await (const line of service.createWorkspace("my-workspace", "my-template")) {
        lines.push(line);
      }

      expect(spawnSpy).toHaveBeenCalledWith(
        "coder",
        ["create", "my-workspace", "-t", "my-template", "--yes"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      // First line is the command, rest are stdout/stderr
      expect(lines[0]).toBe("$ coder create my-workspace -t my-template --yes");
      expect(lines.slice(1).sort()).toEqual(["err-1", "out-1", "out-2"]);
    });

    it("includes --preset when provided", async () => {
      mockPrefetchCalls({ presetParamNames: ["covered-param"] });
      mockFetchRichParams([{ name: "covered-param", default_value: "val" }]);

      mockCoderCommandResult({ exitCode: 0 });

      await drain(service.createWorkspace("ws", "tmpl", "preset"));

      expect(spawnSpy).toHaveBeenCalledWith(
        "coder",
        ["create", "ws", "-t", "tmpl", "--yes", "--preset", "preset"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("includes --parameter flags for uncovered non-ephemeral params", async () => {
      mockPrefetchCalls({ presetParamNames: ["covered-param"] });
      mockFetchRichParams([
        { name: "covered-param", default_value: "val1" },
        { name: "uncovered-param", default_value: "val2" },
        { name: "ephemeral-param", default_value: "val3", ephemeral: true },
      ]);

      mockCoderCommandResult({ exitCode: 0 });

      await drain(service.createWorkspace("ws", "tmpl", "preset"));

      expect(spawnSpy).toHaveBeenCalledWith(
        "coder",
        [
          "create",
          "ws",
          "-t",
          "tmpl",
          "--yes",
          "--preset",
          "preset",
          "--parameter",
          "uncovered-param=val2",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("throws when exit code is non-zero", async () => {
      mockPrefetchCalls();
      mockFetchRichParams([]);

      mockCoderCommandResult({ exitCode: 42 });

      let thrown: unknown;
      try {
        await drain(service.createWorkspace("ws", "tmpl"));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain(
        "coder create failed (exit 42)"
      );
    });

    it("aborts before spawn when already aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      let thrown: unknown;
      try {
        await drain(service.createWorkspace("ws", "tmpl", undefined, abortController.signal));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("aborted");
    });

    it("throws when required param has no default and is not covered by preset", async () => {
      mockPrefetchCalls({ presetParamNames: [] });
      mockFetchRichParams([{ name: "required-param", default_value: "", required: true }]);

      let thrown: unknown;
      try {
        await drain(service.createWorkspace("ws", "tmpl"));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("required-param");
    });
  });
});

describe("computeExtraParams", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
  });

  it("returns empty array when all params are covered by preset", () => {
    const params = [
      richParam("param1", { defaultValue: "val1" }),
      richParam("param2", { defaultValue: "val2" }),
    ];
    const covered = new Set(["param1", "param2"]);

    expect(service.computeExtraParams(params, covered)).toEqual([]);
  });

  it("returns uncovered non-ephemeral params with defaults", () => {
    const params = [
      richParam("covered", { defaultValue: "val1" }),
      richParam("uncovered", { defaultValue: "val2" }),
    ];
    const covered = new Set(["covered"]);

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "uncovered", encoded: "uncovered=val2" },
    ]);
  });

  it("excludes ephemeral params", () => {
    const params = [
      richParam("normal", { defaultValue: "val1" }),
      richParam("ephemeral", { defaultValue: "val2", ephemeral: true }),
    ];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "normal", encoded: "normal=val1" },
    ]);
  });

  it("includes params with empty default values", () => {
    const params = [richParam("empty-default", { defaultValue: "" })];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "empty-default", encoded: "empty-default=" },
    ]);
  });

  it("CSV-encodes list(string) values containing quotes", () => {
    const params = [
      richParam("Select IDEs", {
        defaultValue: '["vscode","code-server","cursor"]',
        type: "list(string)",
      }),
    ];
    const covered = new Set<string>();

    // CLI uses CSV parsing, so quotes need escaping: " -> ""
    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "Select IDEs", encoded: '"Select IDEs=[""vscode"",""code-server"",""cursor""]"' },
    ]);
  });

  it("passes empty list(string) array without CSV encoding", () => {
    const params = [richParam("empty-list", { defaultValue: "[]", type: "list(string)" })];
    const covered = new Set<string>();

    // No quotes or commas, so no encoding needed
    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "empty-list", encoded: "empty-list=[]" },
    ]);
  });
});

describe("validateRequiredParams", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
  });

  it("does not throw when all required params have defaults", () => {
    const params = [richParam("required-with-default", { required: true })];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("does not throw when required params are covered by preset", () => {
    const params = [richParam("required-no-default", { defaultValue: "", required: true })];
    const covered = new Set(["required-no-default"]);

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("throws when required param has no default and is not covered", () => {
    const params = [richParam("missing-param", { defaultValue: "", required: true })];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).toThrow("missing-param");
  });

  it("ignores ephemeral required params", () => {
    const params = [
      richParam("ephemeral-required", { defaultValue: "", ephemeral: true, required: true }),
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("lists all missing required params in error", () => {
    const params = [
      richParam("missing1", { defaultValue: "", required: true }),
      richParam("missing2", { defaultValue: "", required: true }),
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).toThrow(
      /missing1.*missing2|missing2.*missing1/
    );
  });
});

describe("non-string parameter defaults", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
  });

  it("validateRequiredParams passes when required param has numeric default 0", () => {
    // After parseRichParameters, numeric 0 becomes "0" (not "")
    const params = [richParam("count", { defaultValue: "0", type: "number", required: true })];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("validateRequiredParams passes when required param has boolean default false", () => {
    // After parseRichParameters, boolean false becomes "false" (not "")
    const params = [richParam("enabled", { defaultValue: "false", type: "bool", required: true })];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("computeExtraParams emits numeric default correctly", () => {
    const params = [richParam("count", { defaultValue: "42", type: "number" })];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "count", encoded: "count=42" },
    ]);
  });

  it("computeExtraParams emits boolean default correctly", () => {
    const params = [richParam("enabled", { defaultValue: "true", type: "bool" })];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "enabled", encoded: "enabled=true" },
    ]);
  });

  it("computeExtraParams emits array default as JSON with CSV encoding", () => {
    // After parseRichParameters, array becomes JSON string
    const params = [richParam("tags", { defaultValue: '["a","b"]', type: "list(string)" })];
    const covered = new Set<string>();

    // JSON array with quotes gets CSV-encoded (quotes escaped as "")
    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "tags", encoded: '"tags=[""a"",""b""]"' },
    ]);
  });
});

describe("deleteWorkspace", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
    vi.clearAllMocks();
  });

  // deleteWorkspace is a thin wrapper around deleteWorkspaceEventually.
  // Detailed polling/retry behavior is tested in the deleteWorkspaceEventually suite.

  it("delegates to deleteWorkspaceEventually with correct options", async () => {
    const spy = spyOn(service, "deleteWorkspaceEventually").mockResolvedValue({
      success: true as const,
      data: undefined,
    });

    await service.deleteWorkspace("mux-my-workspace");

    expect(spy).toHaveBeenCalledWith("mux-my-workspace", {
      timeoutMs: 30_000,
      waitForExistence: false,
    });
  });

  it("throws when deleteWorkspaceEventually returns an error", async () => {
    spyOn(service, "deleteWorkspaceEventually").mockResolvedValue({
      success: false as const,
      error: "workspace stuck",
    });

    let error: unknown;
    try {
      await service.deleteWorkspace("mux-my-workspace");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("workspace stuck");
  });
});

describe("deleteWorkspaceEventually", () => {
  it("polls past initial not_found when waitForExistence=true", async () => {
    const service = new CoderService();

    const getWorkspaceStatusSpy = spyOn(service, "getWorkspaceStatus");
    const statuses = [
      { kind: "not_found" as const },
      { kind: "ok" as const, status: "pending" as const },
      { kind: "ok" as const, status: "deleting" as const },
    ];
    getWorkspaceStatusSpy.mockImplementation(() =>
      Promise.resolve(statuses.shift() ?? { kind: "ok" as const, status: "deleting" as const })
    );

    const serviceHack = getServiceTestAccess(service);

    serviceHack.runCoderCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    );
    serviceHack.sleep = vi.fn(() => Promise.resolve());

    const result = await service.deleteWorkspaceEventually("mux-my-workspace", {
      timeoutMs: 1_000,
      waitForExistence: true,
    });

    expect(result.success).toBe(true);
    expect(getWorkspaceStatusSpy.mock.calls.length).toBeGreaterThan(1);
    expect(serviceHack.runCoderCommand).toHaveBeenCalled();
  });

  it("treats sustained not_found as success after timeout when waitForExistence=true", async () => {
    const service = new CoderService();

    let now = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);

    const getWorkspaceStatusSpy = spyOn(service, "getWorkspaceStatus").mockResolvedValue({
      kind: "not_found" as const,
    });

    const serviceHack = getServiceTestAccess(service);

    serviceHack.runCoderCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    );
    serviceHack.sleep = vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    });

    try {
      const result = await service.deleteWorkspaceEventually("mux-my-workspace", {
        timeoutMs: 1_000,
        waitForExistence: true,
      });

      expect(result.success).toBe(true);
      expect(getWorkspaceStatusSpy).toHaveBeenCalled();
      expect(serviceHack.runCoderCommand).not.toHaveBeenCalled();
    } finally {
      // Reset Date.now even if the test fails.
      nowSpy.mockRestore();
    }
  });

  it("short-circuits on waitForExistenceTimeoutMs before overall timeout", async () => {
    const service = new CoderService();

    let now = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);

    const getWorkspaceStatusSpy = spyOn(service, "getWorkspaceStatus").mockResolvedValue({
      kind: "not_found" as const,
    });

    const serviceHack = getServiceTestAccess(service);

    serviceHack.runCoderCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    );
    serviceHack.sleep = vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    });

    try {
      const result = await service.deleteWorkspaceEventually("mux-my-workspace", {
        timeoutMs: 60_000,
        waitForExistence: true,
        // Short existence-wait window: succeed after ~5s of only not_found
        waitForExistenceTimeoutMs: 5_000,
      });

      expect(result.success).toBe(true);
      expect(getWorkspaceStatusSpy).toHaveBeenCalled();
      // Should never attempt `coder delete` since we only saw not_found
      expect(serviceHack.runCoderCommand).not.toHaveBeenCalled();
      // Should have returned well before the 60s overall timeout
      expect(now).toBeLessThan(10_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("treats a successful delete as terminal even if status polling errors", async () => {
    const service = new CoderService();

    spyOn(service, "getWorkspaceStatus").mockResolvedValue({
      kind: "error" as const,
      error: "auth failed",
    });

    const serviceHack = getServiceTestAccess(service);

    serviceHack.runCoderCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    );
    serviceHack.sleep = vi.fn(() => Promise.resolve());

    const result = await service.deleteWorkspaceEventually("mux-my-workspace", {
      timeoutMs: 60_000,
      waitForExistence: false,
    });

    expect(result.success).toBe(true);
    expect(serviceHack.runCoderCommand).toHaveBeenCalledTimes(1);
    expect(serviceHack.sleep).not.toHaveBeenCalled();
  });

  it("treats a successful delete as terminal even when waitForExistence=true", async () => {
    const service = new CoderService();

    spyOn(service, "getWorkspaceStatus").mockResolvedValue({
      kind: "error" as const,
      error: "auth failed",
    });

    const serviceHack = getServiceTestAccess(service);

    serviceHack.runCoderCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
    );
    serviceHack.sleep = vi.fn(() => Promise.resolve());

    const result = await service.deleteWorkspaceEventually("mux-my-workspace", {
      timeoutMs: 60_000,
      waitForExistence: true,
    });

    expect(result.success).toBe(true);
    expect(serviceHack.runCoderCommand).toHaveBeenCalledTimes(1);
    expect(serviceHack.sleep).not.toHaveBeenCalled();
  });
});

describe("CoderService.ensureMuxCoderSSHConfig", () => {
  it("skips SSH config writes when coder binary is unavailable", async () => {
    const service = new CoderService();
    const resolveCoderBinaryPathSpy = spyOn(
      service as unknown as { resolveCoderBinaryPath: () => Promise<string | null> },
      "resolveCoderBinaryPath"
    ).mockResolvedValue(null);
    const ensureMuxCoderSSHConfigFileSpy = spyOn(
      muxSshConfigWriter,
      "ensureMuxCoderSSHConfigFile"
    ).mockResolvedValue();

    try {
      await service.ensureMuxCoderSSHConfig();

      expect(resolveCoderBinaryPathSpy).toHaveBeenCalledTimes(1);
      expect(ensureMuxCoderSSHConfigFileSpy).not.toHaveBeenCalled();
    } finally {
      resolveCoderBinaryPathSpy.mockRestore();
      ensureMuxCoderSSHConfigFileSpy.mockRestore();
    }
  });

  it("writes SSH config when coder binary is resolved", async () => {
    const service = new CoderService();
    const resolveCoderBinaryPathSpy = spyOn(
      service as unknown as { resolveCoderBinaryPath: () => Promise<string | null> },
      "resolveCoderBinaryPath"
    ).mockResolvedValue("/usr/local/bin/coder");
    const ensureMuxCoderSSHConfigFileSpy = spyOn(
      muxSshConfigWriter,
      "ensureMuxCoderSSHConfigFile"
    ).mockResolvedValue();

    try {
      await service.ensureMuxCoderSSHConfig();

      expect(resolveCoderBinaryPathSpy).toHaveBeenCalledTimes(1);
      expect(ensureMuxCoderSSHConfigFileSpy).toHaveBeenCalledWith({
        coderBinaryPath: "/usr/local/bin/coder",
      });
    } finally {
      resolveCoderBinaryPathSpy.mockRestore();
      ensureMuxCoderSSHConfigFileSpy.mockRestore();
    }
  });

  it("writes SSH config when coder binary resolves to normalized Windows path", async () => {
    const service = new CoderService();
    const resolveCoderBinaryPathSpy = spyOn(
      service as unknown as { resolveCoderBinaryPath: () => Promise<string | null> },
      "resolveCoderBinaryPath"
    ).mockResolvedValue("C:\\Users\\me\\bin\\coder.exe");
    const ensureMuxCoderSSHConfigFileSpy = spyOn(
      muxSshConfigWriter,
      "ensureMuxCoderSSHConfigFile"
    ).mockResolvedValue();

    try {
      await service.ensureMuxCoderSSHConfig();

      expect(resolveCoderBinaryPathSpy).toHaveBeenCalledTimes(1);
      expect(ensureMuxCoderSSHConfigFileSpy).toHaveBeenCalledWith({
        coderBinaryPath: "C:\\Users\\me\\bin\\coder.exe",
      });
    } finally {
      resolveCoderBinaryPathSpy.mockRestore();
      ensureMuxCoderSSHConfigFileSpy.mockRestore();
    }
  });
});

describe("compareVersions", () => {
  const cases: Array<[string, string, "lt" | "eq" | "gt"]> = [
    ["2.28.6", "2.28.6", "eq"],
    ["v2.28.6", "2.28.6", "eq"],
    ["v2.28.6+hash", "2.28.6", "eq"],
    ["2.25.0", "2.28.6", "lt"],
    ["2.28.5", "2.28.6", "lt"],
    ["1.0.0", "2.0.0", "lt"],
    ["2.28.6", "2.25.0", "gt"],
    ["2.28.6", "2.28.5", "gt"],
    ["3.0.0", "2.28.6", "gt"],
    ["v2.28.6", "2.25.0", "gt"],
    ["v2.25.0", "v2.28.6", "lt"],
    ["v2.28.2-devel+903c045b9", "2.25.0", "gt"],
    ["v2.28.2-devel+903c045b9", "2.28.2", "eq"],
    ["2.28", "2.28.0", "eq"],
    ["2.28", "2.28.1", "lt"],
  ];

  for (const [left, right, expected] of cases) {
    it(`${left} is ${expected} ${right}`, () => {
      const result = compareVersions(left, right);
      if (expected === "eq") expect(result).toBe(0);
      if (expected === "lt") expect(result).toBeLessThan(0);
      if (expected === "gt") expect(result).toBeGreaterThan(0);
    });
  }
});
