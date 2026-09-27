import { TextDecoder, TextEncoder } from "util";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/client";
import type { ExecStream } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

// After stdin closes, how long a server gets to exit on its own before close() kills it.
const MCP_STDIO_EXIT_GRACE_MS = 2_000;
// Upper bound on waiting for the killed process to report its exit (a remote exec may never).
const MCP_STDIO_KILL_JOIN_MS = 5_000;

/**
 * Minimal stdio transport for MCP servers using newline-delimited JSON (NDJSON).
 * Each message is a single line of JSON followed by \n.
 * This matches the protocol used by the official SDK's StdioClientTransport,
 * but reads/writes a Runtime.exec() stream so MCP servers can run on remote
 * (SSH/devcontainer) runtimes too.
 */
export class MCPStdioTransport implements Transport {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private running = false;
  private readonly exitPromise: Promise<number>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * @param options.kill Kills the server's process tree (its exec's abort). Without it, close()
   *   only closes stdin and stops reading, so a server that ignores EOF keeps running.
   */
  constructor(
    execStream: ExecStream,
    private readonly options?: { kill?: () => void }
  ) {
    this.stdoutReader = execStream.stdout.getReader();
    this.stdinWriter = execStream.stdin.getWriter();
    this.exitPromise = execStream.exitCode;
    // Observe process exit to trigger close event. A rejected exit observation proves nothing
    // (see close()), so it does not close; handled so it is not an unhandled rejection.
    void this.exitPromise.then(
      () => {
        if (this.onclose) this.onclose();
      },
      () => undefined
    );
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    void this.readLoop();
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // NDJSON: serialize as JSON followed by newline
    const line = JSON.stringify(message) + "\n";
    const bytes = this.encoder.encode(line);
    await this.stdinWriter.write(bytes);
  }

  async close(): Promise<void> {
    try {
      await this.stdinWriter.close();
    } catch (error) {
      log.debug("Failed to close MCP stdin writer", { error });
    }
    try {
      await this.stdoutReader.cancel();
    } catch (error) {
      log.debug("Failed to cancel MCP stdout reader", { error });
    }
    // Workspace removal stops servers before deleting the checkout (#4760): observe the exit,
    // and kill a server that ignores EOF, so none outlives the checkout.
    const kill = this.options?.kill;
    if (kill === undefined) return;
    // A rejected exit observation (e.g. a child-process error) does not prove the tree exited.
    const exited = await raceWithAbortAndTimeout(this.exitPromise, {
      timeoutMs: MCP_STDIO_EXIT_GRACE_MS,
    }).catch(() => ({ kind: "rejected" as const }));
    if (exited.kind === "ok") return;
    kill();
    await raceWithAbortAndTimeout(this.exitPromise, { timeoutMs: MCP_STDIO_KILL_JOIN_MS }).catch(
      () => undefined
    );
  }

  private async readLoop(): Promise<void> {
    try {
      while (true) {
        const { value, done } = await this.stdoutReader.read();
        if (done) break;
        if (value) {
          this.buffer += this.decoder.decode(value, { stream: true });
          this.processBuffer();
        }
      }
    } catch (error) {
      if (this.onerror) {
        this.onerror(error as Error);
      } else {
        log.error("MCP stdio transport read error", { error });
      }
    } finally {
      if (this.onclose) this.onclose();
    }
  }

  private processBuffer(): void {
    // Process complete lines (NDJSON format)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim().length === 0) continue; // Skip empty lines

      try {
        const message = JSON.parse(line) as JSONRPCMessage;
        if (this.onmessage) {
          this.onmessage(message);
        }
      } catch (error) {
        if (this.onerror) {
          this.onerror(error as Error);
        } else {
          log.error("Failed to parse MCP message", { error, line });
        }
      }
    }
  }
}
