import { jest, mock, setSystemTime, spyOn } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import type { Tool } from "ai";

import assert from "@/common/utils/assert";
import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import * as mcpSdk from "@/node/services/mcpClient";
import { MCP_STARTUP_TIMEOUT_MS } from "@/node/services/mcpServerManager";

/**
 * Fake MCP servers for MCPServerManager tests.
 *
 * The manager is driven through its public API while the two process/network
 * boundaries are faked: `Runtime.exec` (stdio spawn) and `createMCPClient`
 * (the protocol client). Everything between them — startup deadlines,
 * override/admission fences, era-verdict caching, tool wrapping, instance
 * caching, leases and restarts — runs for real.
 *
 * Servers are keyed by what the manager actually launches: the stdio exec
 * command line, or the remote URL.
 */

// The manager's per-server startup deadline (a real timer), shared so the harness cannot drift.
export { MCP_STARTUP_TIMEOUT_MS };

// bun-types (^1.2.23) lags the pinned runtime (bun@1.3.5), which implements this.
const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

type MCPClientHandle = Awaited<ReturnType<typeof mcpSdk.createMCPClient>>;
type FakePrompt = Awaited<ReturnType<MCPClientHandle["prompts"]>>[number];

export interface FakeServerBehavior {
  /** Raw tools returned by tools/list (wrapped by the manager). */
  tools?: Record<string, Tool>;
  /** Overrides tools/list entirely, e.g. to count or hang refreshes. */
  listTools?: () => Promise<Record<string, Tool>>;
  prompts?: Array<Partial<FakePrompt> & { name: string }>;
  /** Overrides prompts/list entirely. */
  listPrompts?: (options?: { signal?: AbortSignal }) => Promise<unknown[]>;
  getPrompt?: (...args: unknown[]) => Promise<unknown>;
  /** Client close; production calls it when the instance is closed. */
  close?: () => Promise<unknown>;
  /** Modern-era connections get background tool refreshes; legacy ones do not. */
  era?: "legacy" | "modern";
  serverInfo?: unknown;
  /** Awaited before the connection resolves; reject to fail this startup. */
  connect?: () => Promise<void>;
  /** Never finish connecting, so only the manager's startup deadline ends the attempt. */
  hang?: boolean;
}

type BehaviorSource =
  | FakeServerBehavior
  | ((attempt: number) => FakeServerBehavior | Promise<FakeServerBehavior>);

interface FakeProcess {
  command: string;
  readonly exited: boolean;
  crash: () => void;
}

/** Notification the fake client sends over a stdio transport to learn which process it is attached to. */
const IDENTIFY_METHOD = "fake/identify";

export class FakeMcpServers {
  private readonly behaviors = new Map<string, BehaviorSource>();
  private readonly attempts = new Map<string, number>();
  private readonly processesByNonce = new Map<string, FakeProcess>();
  private readonly processes: FakeProcess[] = [];
  private nextNonce = 0;
  private hungConnects = 0;
  private clientSpy: ReturnType<typeof spyOn<typeof mcpSdk, "createMCPClient">> | null = null;

  /** Stable runtime whose exec spawns a fake process (pass it in workspace requests). */
  readonly exec = mock((command: string, options: ExecOptions) =>
    Promise.resolve(this.spawn(command, options))
  );
  // Only exec is reachable from MCP startup; the rest of Runtime is unused.
  readonly runtime = { exec: this.exec } as unknown as Runtime;

  /**
   * Register (or replace) the server reached by `key` (stdio command or URL).
   * A function behavior receives the 1-based connection attempt since this call.
   */
  serve(key: string, behavior: BehaviorSource = {}): void {
    this.install();
    this.behaviors.set(key, behavior);
    this.attempts.delete(key);
  }

  /** Connection attempts (successful or failed) against `key` since it was last served. */
  connectCount(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  /**
   * Exit every live process launched with `command`: the transport closes
   * and the manager marks the instance closed.
   */
  async crash(command: string): Promise<void> {
    // Only live processes: crashing an already-exited one must not satisfy a restart test.
    const matching = this.processes.filter(
      (process) => process.command === command && !process.exited
    );
    assert(matching.length > 0, `FakeMcpServers.crash: no live process for ${command}`);
    for (const process of matching) process.crash();
    // The transport observes the exit asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Run `operation` until `hangs` more `hang` connections are reached, then
   * fire the manager's startup deadline on fake timers instead of waiting a
   * real minute. Leaves the clock frozen at the advanced time (afterEach's
   * setSystemTime() restores it), so backoff windows are measured from it.
   */
  async expireStartupDeadline<T>(operation: () => Promise<T>, hangs = 1): Promise<T> {
    const target = this.hungConnects + hangs;
    const startedAt = Date.now();
    fakeTimers.useFakeTimers();
    setSystemTime(new Date(startedAt));
    try {
      const pending = operation();
      // setImmediate is not faked, so real I/O in the startup path keeps flowing.
      for (let turn = 0; this.hungConnects < target; turn++) {
        assert(turn < 10_000, "FakeMcpServers.expireStartupDeadline: startup never hung");
        await new Promise((resolve) => setImmediate(resolve));
      }
      fakeTimers.advanceTimersByTime(MCP_STARTUP_TIMEOUT_MS);
      return await pending;
    } finally {
      const now = Date.now();
      fakeTimers.useRealTimers();
      setSystemTime(new Date(now));
    }
  }

  /** Restore createMCPClient and forget every server; call from afterEach. */
  reset(): void {
    this.clientSpy?.mockRestore();
    this.clientSpy = null;
    this.behaviors.clear();
    this.attempts.clear();
    this.processesByNonce.clear();
    this.processes.length = 0;
    this.hungConnects = 0;
    this.exec.mockClear();
  }

  private install(): void {
    this.clientSpy ??= spyOn(mcpSdk, "createMCPClient").mockImplementation((config) =>
      this.connect(config)
    );
  }

  private spawn(command: string, options: ExecOptions): ExecStream {
    if (options.abortSignal?.aborted) throw new Error("fake exec aborted");
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const exitCode = new Promise<number>((resolve) => (exit = resolve));
    let exited = false;
    const process: FakeProcess = {
      command,
      get exited() {
        return exited;
      },
      crash: () => {
        if (exited) return;
        exited = true;
        try {
          stdout.close();
        } catch {
          // The transport already cancelled stdout.
        }
        exit(1);
      },
    };
    // Like a real exec, a later abort kills the process: an abandoned (e.g.
    // timed-out) generation must not stay live and satisfy crash().
    options.abortSignal?.addEventListener("abort", () => process.crash(), { once: true });
    this.processes.push(process);
    const decoder = new TextDecoder();
    return {
      stdout: new ReadableStream<Uint8Array>({
        start: (controller) => {
          stdout = controller;
        },
      }),
      stderr: new ReadableStream<Uint8Array>(),
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => {
          for (const line of decoder.decode(chunk).split("\n")) {
            if (line.trim() === "") continue;
            const message = JSON.parse(line) as { method?: string; params?: { nonce?: string } };
            if (message.method === IDENTIFY_METHOD && message.params?.nonce !== undefined) {
              this.processesByNonce.set(message.params.nonce, process);
            }
          }
        },
      }),
      exitCode,
      duration: exitCode.then(() => 0),
    };
  }

  private async identify(transport: mcpSdk.MCPClientConfig["transport"]): Promise<string> {
    if ("type" in transport && (transport.type === "http" || transport.type === "sse")) {
      return transport.url;
    }
    assert("send" in transport, "FakeMcpServers: stdio transport expected");
    const nonce = String(this.nextNonce++);
    const identify: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: IDENTIFY_METHOD,
      params: { nonce },
    };
    await transport.send(identify);
    const process = this.processesByNonce.get(nonce);
    assert(process, "FakeMcpServers: stdio transport is not attached to a fake process");
    return process.command;
  }

  private async connect(config: mcpSdk.MCPClientConfig): Promise<MCPClientHandle> {
    const key = await this.identify(config.transport);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const source = this.behaviors.get(key);
    if (source === undefined) throw new Error(`no fake MCP server for ${key}`);
    const behavior = typeof source === "function" ? await source(attempt) : source;
    await behavior.connect?.();
    if (behavior.hang === true) {
      this.hungConnects += 1;
      await new Promise<never>(() => undefined);
    }
    const modern = behavior.era === "modern";
    const handle = {
      tools: behavior.listTools ?? (() => Promise.resolve(behavior.tools ?? {})),
      prompts: behavior.listPrompts ?? (() => Promise.resolve(behavior.prompts ?? [])),
      getPrompt: behavior.getPrompt ?? (() => Promise.resolve({ messages: [], context: {} })),
      negotiatedProtocolVersion: () => (modern ? "2026-07-28" : "2025-11-25"),
      serverInfo: () => behavior.serverInfo,
      priorDiscovery: () =>
        modern ? { kind: "modern" as const, discover: {} } : { kind: "legacy" as const },
      close: behavior.close ?? (() => Promise.resolve()),
    };
    // Tests supply loosely typed prompt/result fixtures; the manager validates them itself.
    return handle as unknown as MCPClientHandle;
  }
}
