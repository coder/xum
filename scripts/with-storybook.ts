#!/usr/bin/env bun

/**
 * Run a command with a ready Storybook dev server.
 *
 * Why this exists: visual iteration is much faster when agents and humans can
 * reuse a warm Storybook process instead of repeatedly paying the cold-start
 * cost and hand-writing cleanup logic around ad-hoc Playwright scripts.
 */
import { spawn, type ChildProcess } from "child_process";

const childSpawnErrors = new WeakMap<ChildProcess, Error>();

interface Options {
  port: number;
  timeoutMs: number;
  command: string[];
}

const STORYBOOK_PROBE_TIMEOUT_MS = 2_000;

const DEFAULT_PORT = 6006;
const DEFAULT_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function printHelp(): void {
  console.log(`Usage:
  bun scripts/with-storybook.ts [--port <port>] [--timeout-ms <ms>] -- <command> [args...]

Starts Storybook only when it is not already ready on the requested port, then
runs the command with STORYBOOK_URL and STORYBOOK_PORT in its environment.

Examples:
  bun scripts/with-storybook.ts -- bun -e 'console.log(process.env.STORYBOOK_URL)'
  STORYBOOK_PORT=6010 bun scripts/with-storybook.ts --port 6010 -- bun scripts/my-check.ts
  make storybook-run CMD='bun -e "console.log(process.env.STORYBOOK_URL)"'
`);
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const port = parsePositiveInteger(value, "--port");
  if (port > 65_535) {
    throw new Error(`--port must be <= 65535, got: ${value}`);
  }
  return port;
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let port = parsePort(process.env.STORYBOOK_PORT ?? String(DEFAULT_PORT));
  let timeoutMs = parsePositiveInteger(
    process.env.STORYBOOK_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    "--timeout-ms"
  );

  const delimiterIndex = argv.indexOf("--");
  const optionArgs = delimiterIndex === -1 ? [] : argv.slice(0, delimiterIndex);
  const command = delimiterIndex === -1 ? argv : argv.slice(delimiterIndex + 1);
  if (delimiterIndex === -1 && argv[0]?.startsWith("-")) {
    throw new Error("Missing `-- <command>` delimiter. Run with --help for usage.");
  }
  if (command.length === 0) {
    throw new Error("Missing command after `--`. Run with --help for usage.");
  }

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--port" || arg === "-p") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      port = parsePort(value);
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      timeoutMs = parsePositiveInteger(value, arg);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { port, timeoutMs, command };
}

function storybookUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function isStorybookReady(url: string): Promise<boolean> {
  try {
    // `/index.json` is Storybook-specific. Checking it prevents us from
    // accidentally reusing an unrelated process that merely occupies the port.
    // Keep each probe bounded so a half-open local server cannot outlive the
    // overall Storybook startup timeout.
    const response = await fetch(`${url}/index.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(STORYBOOK_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const indexJson = await response.json();
    return typeof indexJson === "object" && indexJson != null && "entries" in indexJson;
  } catch {
    return false;
  }
}

async function waitForStorybook(
  url: string,
  timeoutMs: number,
  serverProcess?: ReturnType<typeof spawnInherited>
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isStorybookReady(url)) {
      return;
    }
    if (serverProcess) {
      const spawnError = childSpawnErrors.get(serverProcess);
      if (spawnError) {
        throw new Error(`Storybook failed to start: ${spawnError.message}`);
      }
      if (serverProcess.exitCode != null || serverProcess.signalCode != null) {
        throw new Error(
          `Storybook exited before becoming ready (code=${serverProcess.exitCode ?? "null"}, signal=${
            serverProcess.signalCode ?? "null"
          })`
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Storybook at ${url}`);
}

function spawnInherited(command: string[], env: NodeJS.ProcessEnv = process.env) {
  const [executable, ...args] = command;
  if (!executable) {
    throw new Error("Cannot spawn an empty command");
  }
  const child = spawn(executable, args, {
    env,
    stdio: "inherit",
    shell: false,
  });
  child.once("error", (error) => {
    childSpawnErrors.set(child, error);
  });
  return child;
}

async function waitForExit(child: ReturnType<typeof spawnInherited>): Promise<number> {
  const existingError = childSpawnErrors.get(child);
  if (existingError) {
    console.error(`Failed to start process: ${existingError.message}`);
    return 1;
  }
  if (typeof child.exitCode === "number") {
    return child.exitCode;
  }
  if (child.signalCode != null) {
    console.error(`Process exited from signal ${child.signalCode}`);
    return 1;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve(exitCode);
    };

    child.once("error", (error) => {
      console.error(`Failed to start process: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        finish(code);
      } else {
        console.error(`Process exited from signal ${signal ?? "unknown"}`);
        finish(1);
      }
    });
  });
}

async function waitForExitWithTimeout(
  child: ReturnType<typeof spawnInherited>,
  timeoutMs: number
): Promise<boolean> {
  if (childSpawnErrors.has(child) || child.exitCode != null || child.signalCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("error", () => finish(true));
    child.once("exit", () => finish(true));
  });
}

async function terminateProcess(child: ReturnType<typeof spawnInherited>): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForExitWithTimeout(child, SHUTDOWN_TIMEOUT_MS)) {
    return;
  }

  console.error("Storybook did not exit after SIGTERM; sending SIGKILL");
  child.kill("SIGKILL");
  await waitForExitWithTimeout(child, SHUTDOWN_TIMEOUT_MS);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const url = storybookUrl(options.port);

  let startedStorybook: ReturnType<typeof spawnInherited> | null = null;
  let cleaningUp = false;

  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (startedStorybook) {
      // Only kill the server we started. Reused Storybook instances belong to
      // the developer's session and should stay warm for the next visual check.
      await terminateProcess(startedStorybook);
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    console.error(`Received ${signal}; cleaning up`);
    cleanup()
      .then(() => process.exit(signal === "SIGINT" ? 130 : 143))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    if (await isStorybookReady(url)) {
      console.log(`Reusing Storybook at ${url}`);
    } else {
      console.log(`Starting Storybook at ${url}`);
      startedStorybook = spawnInherited([
        "bun",
        "x",
        "storybook",
        "dev",
        "-p",
        String(options.port),
        "--ci",
        "--quiet",
        "--no-open",
        "--no-version-updates",
        "--disable-telemetry",
        "--exact-port",
      ]);
      await waitForStorybook(url, options.timeoutMs, startedStorybook);
      console.log(`Storybook ready at ${url}`);
    }

    const commandEnv = {
      ...process.env,
      STORYBOOK_URL: url,
      STORYBOOK_PORT: String(options.port),
    };
    const commandProcess = spawnInherited(options.command, commandEnv);
    return await waitForExit(commandProcess);
  } finally {
    await cleanup();
  }
}

try {
  const exitCode = await main();
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
