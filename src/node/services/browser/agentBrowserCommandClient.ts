import * as fsPromises from "node:fs/promises";
import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { getErrorMessage } from "@/common/utils/errors";
import {
  getAgentBrowserPortForSession,
  getAgentBrowserPortPath,
  getAgentBrowserSocketPath,
} from "./agentBrowserSocketPaths";

const MAX_DAEMON_COMMAND_ATTEMPTS = 5;
const DAEMON_COMMAND_RETRY_DELAY_MS = 200;

export interface AgentBrowserDaemonNavigateCommand {
  id: string;
  action: "navigate";
  url: string;
}

export type AgentBrowserDaemonCommand = AgentBrowserDaemonNavigateCommand;

export interface AgentBrowserDaemonCommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SendAgentBrowserDaemonCommandOptions {
  env: NodeJS.ProcessEnv;
  sessionName: string;
  command: AgentBrowserDaemonCommand;
  timeoutMs: number;
  retryDelayMs?: number;
}

export type SendAgentBrowserDaemonCommandFn = (
  options: SendAgentBrowserDaemonCommandOptions
) => Promise<AgentBrowserDaemonCommandResponse>;

interface AgentBrowserUnixEndpoint {
  kind: "unix";
  socketPath: string;
}

interface AgentBrowserTcpEndpoint {
  kind: "tcp";
  host: string;
  port: number;
}

export type AgentBrowserDaemonEndpoint = AgentBrowserUnixEndpoint | AgentBrowserTcpEndpoint;

interface ResolveAgentBrowserDaemonEndpointOptions {
  env: NodeJS.ProcessEnv;
  sessionName: string;
  platform?: NodeJS.Platform;
  readFileFn?: typeof fsPromises.readFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDaemonResponse(payload: string): AgentBrowserDaemonCommandResponse {
  const parsed: unknown = JSON.parse(payload);
  if (!isRecord(parsed) || typeof parsed.success !== "boolean") {
    return { success: false, error: "agent-browser daemon returned an invalid response" };
  }

  const response: AgentBrowserDaemonCommandResponse = { success: parsed.success };
  if ("data" in parsed) {
    response.data = parsed.data;
  }
  if (typeof parsed.error === "string") {
    response.error = parsed.error;
  }
  return response;
}

function parsePortFile(value: string): number | null {
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const port = Number.parseInt(trimmedValue, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export async function resolveAgentBrowserDaemonEndpoint(
  options: ResolveAgentBrowserDaemonEndpointOptions
): Promise<AgentBrowserDaemonEndpoint> {
  assert(options.sessionName.trim().length > 0, "agent-browser daemon requires a session name");
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      kind: "unix",
      socketPath: getAgentBrowserSocketPath(options.env, options.sessionName),
    };
  }

  let port = getAgentBrowserPortForSession(options.sessionName);
  const readFileFn = options.readFileFn ?? fsPromises.readFile;
  try {
    const portFile = await readFileFn(
      getAgentBrowserPortPath(options.env, options.sessionName),
      "utf8"
    );
    port = parsePortFile(portFile) ?? port;
  } catch {
    // agent-browser falls back to a stable hash-derived TCP port when the sidecar
    // file is missing or unreadable; do the same so file:// navigation still works
    // while the daemon is starting on Windows.
  }

  return { kind: "tcp", host: "127.0.0.1", port };
}

function createSocket(endpoint: AgentBrowserDaemonEndpoint): net.Socket {
  if (endpoint.kind === "unix") {
    return net.createConnection(endpoint.socketPath);
  }

  return net.createConnection({ host: endpoint.host, port: endpoint.port });
}

export function isTransientAgentBrowserDaemonError(error: string): boolean {
  return (
    error.includes("EAGAIN") ||
    error.includes("EWOULDBLOCK") ||
    error.includes("WouldBlock") ||
    error.includes("Resource temporarily unavailable") ||
    error.includes("EOF") ||
    error.includes("ENOENT") ||
    error.includes("ECONNREFUSED") ||
    error.includes("ECONNRESET") ||
    error.includes("EPIPE") ||
    error.includes("Connection reset") ||
    error.includes("Broken pipe") ||
    error.includes("agent-browser daemon closed before responding") ||
    error.includes("os error 35") ||
    error.includes("os error 11") ||
    error.includes("os error 54") ||
    error.includes("os error 104") ||
    error.includes("os error 2") ||
    error.includes("os error 61") ||
    error.includes("os error 111") ||
    error.includes("os error 10061") ||
    error.includes("os error 10054")
  );
}

export async function sendAgentBrowserDaemonCommand(
  options: SendAgentBrowserDaemonCommandOptions
): Promise<AgentBrowserDaemonCommandResponse> {
  assert(options.sessionName.trim().length > 0, "agent-browser daemon requires a session name");
  assert(options.timeoutMs > 0, "agent-browser daemon timeoutMs must be positive");

  const startTimeMs = Date.now();
  const retryDelayMs = options.retryDelayMs ?? DAEMON_COMMAND_RETRY_DELAY_MS;
  let lastResult: AgentBrowserDaemonCommandResponse | null = null;

  for (let attempt = 0; attempt < MAX_DAEMON_COMMAND_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const remainingBeforeDelayMs = options.timeoutMs - (Date.now() - startTimeMs);
      if (remainingBeforeDelayMs <= 0) {
        return createDaemonTimeoutResult(options);
      }
      await delay(Math.min(retryDelayMs * attempt, remainingBeforeDelayMs));
    }

    const remainingMs = options.timeoutMs - (Date.now() - startTimeMs);
    if (remainingMs <= 0) {
      return createDaemonTimeoutResult(options);
    }

    const endpoint = await resolveAgentBrowserDaemonEndpoint({
      env: options.env,
      sessionName: options.sessionName,
    });
    const result = await sendAgentBrowserDaemonCommandOnce(
      { ...options, timeoutMs: remainingMs },
      endpoint
    );
    if (
      result.success ||
      result.error == null ||
      !isTransientAgentBrowserDaemonError(result.error)
    ) {
      return result;
    }

    lastResult = result;
  }

  return {
    success: false,
    error: `${lastResult?.error ?? "agent-browser daemon did not respond"} (after ${MAX_DAEMON_COMMAND_ATTEMPTS} attempts - daemon may be busy or unresponsive)`,
  };
}

function createDaemonTimeoutResult(
  options: SendAgentBrowserDaemonCommandOptions
): AgentBrowserDaemonCommandResponse {
  return {
    success: false,
    error: `agent-browser ${options.command.action} for session ${options.sessionName} timed out after ${options.timeoutMs}ms`,
  };
}

async function sendAgentBrowserDaemonCommandOnce(
  options: SendAgentBrowserDaemonCommandOptions,
  endpoint: AgentBrowserDaemonEndpoint
): Promise<AgentBrowserDaemonCommandResponse> {
  return await new Promise<AgentBrowserDaemonCommandResponse>((resolve) => {
    let socket: net.Socket;
    try {
      socket = createSocket(endpoint);
    } catch (error) {
      resolve({ success: false, error: getErrorMessage(error) });
      return;
    }

    let settled = false;
    let responseBuffer = "";

    const finish = (result: AgentBrowserDaemonCommandResponse): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      socket.destroy();
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish(createDaemonTimeoutResult(options));
    }, options.timeoutMs);
    timeoutId.unref?.();

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      try {
        socket.write(`${JSON.stringify(options.command)}\n`);
      } catch (error) {
        finish({ success: false, error: getErrorMessage(error) });
      }
    });

    socket.on("data", (chunk: Buffer | string) => {
      responseBuffer += chunk.toString();
      const newlineIndex = responseBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const responseLine = responseBuffer.slice(0, newlineIndex).trim();
      if (responseLine.length === 0) {
        finish({ success: false, error: "agent-browser daemon returned an empty response" });
        return;
      }

      try {
        finish(parseDaemonResponse(responseLine));
      } catch (error) {
        finish({
          success: false,
          error: `Invalid agent-browser daemon response: ${getErrorMessage(error)}`,
        });
      }
    });

    socket.once("end", () => {
      finish({ success: false, error: "agent-browser daemon closed before responding" });
    });

    socket.once("error", (error) => {
      finish({ success: false, error: getErrorMessage(error) });
    });

    socket.once("close", () => {
      finish({ success: false, error: "agent-browser daemon closed before responding" });
    });
  });
}
