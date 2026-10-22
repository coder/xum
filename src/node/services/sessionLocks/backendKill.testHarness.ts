/**
 * Harness for backendKill.test.ts: real `xum server` backends on one temp
 * XUM_ROOT, driven over ORPC with the mock model (XUM_MOCK_AI=1), so a test
 * can SIGKILL one backend in a turn and watch the next one recover.
 *
 * It spawns real processes on purpose: the recovery under test (dead-holder
 * reclaim of the history write lock, startup commit of partial.json, the
 * startup retry) only runs across a real process death. No model is paid.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import { historyWriteLockPath } from "@/node/services/workspaceRemoval";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_MS = 50;

export interface Backend {
  readonly pid: number;
  readonly exited: Promise<number>;
  createWorkspace(projectPath: string): Promise<string>;
  /** Posts workspace/sendMessage. It settles when the backend acks or dies. */
  send(workspaceId: string, message: string): Promise<unknown>;
  /** Waits until the workspace streams, then until it stops streaming. */
  waitForStreamStartThenEnd(workspaceId: string, timeoutMs: number): Promise<void>;
  kill(signal: NodeJS.Signals): void;
  /** SIGTERM, then waits for the exit. */
  stop(): Promise<void>;
  /** SIGKILL (no-op after exit), then waits for the exit. */
  killAndWait(): Promise<void>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address !== null && typeof address === "object", "listen(0) gives a port");
      server.close(() => resolve(address.port));
    });
  });
}

/** The env of the child: this process's env without Xum settings, plus the root. */
function childEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("XUM_") || key.startsWith("MUX_")) continue;
    env[key] = value;
  }
  env.XUM_ROOT = root;
  env.XUM_MOCK_AI = "1";
  return env;
}

export async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "xum-backend-kill-"));
}

/** A one-commit git repo for the workspace. */
export async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-backend-kill-project-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=a", ...args]);
  git("init", "-q", "-b", "main");
  await fs.writeFile(path.join(dir, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

async function waitForHealth(port: number, isAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert(isAlive(), "the backend exited before /health answered");
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(POLL_MS * 5);
  }
  throw new Error(`the backend on port ${port} gave no /health in ${HEALTH_TIMEOUT_MS} ms`);
}

/**
 * Starts `xum server` on root and pushes it to live, so afterEach can kill it.
 * `xum server` refuses a second server while the first pid lives
 * (cli/server.ts:138-143), so start the next one only after the first exited.
 */
export async function startBackend(
  root: string,
  projectPath: string,
  live: Backend[]
): Promise<Backend> {
  const port = await freePort();
  const child = Bun.spawn(
    [
      "bun",
      "src/cli/index.ts",
      "server",
      "--port",
      `${port}`,
      "--no-auth",
      "--add-project",
      projectPath,
    ],
    { cwd: REPO_ROOT, env: childEnv(root), stdout: "ignore", stderr: "ignore" }
  );
  const base = `http://127.0.0.1:${port}/orpc`;
  // A procedure with no input takes the body {} (no json key).
  const post = async (route: string, json?: unknown): Promise<unknown> => {
    const response = await fetch(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(json === undefined ? {} : { json }),
    });
    assert(response.ok, `${route} answered ${response.status}`);
    // A void procedure answers with a null body.
    return ((await response.json()) as { json?: unknown } | null)?.json;
  };
  const backend: Backend = {
    pid: child.pid,
    exited: child.exited,
    async createWorkspace(project) {
      await post("projects/setTrust", { projectPath: project, trusted: true });
      const created = (await post("workspace/create", {
        projectPath: project,
        branchName: "kill-test",
        trunkBranch: "main",
        title: "kill-test",
      })) as { success: boolean; metadata?: { id?: string } };
      assert(created.success && typeof created.metadata?.id === "string", "workspace/create");
      return created.metadata.id;
    },
    send: (workspaceId, message) =>
      post("workspace/sendMessage", {
        workspaceId,
        message,
        options: { model: "anthropic:claude-haiku-5-5", agentId: "exec" },
      }),
    async waitForStreamStartThenEnd(workspaceId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let seen = false;
      while (Date.now() < deadline) {
        const activity = (await post("workspace/activity/list")) as Record<
          string,
          { streaming?: boolean } | undefined
        >;
        const streaming = activity[workspaceId]?.streaming === true;
        if (streaming) seen = true;
        if (seen && !streaming) return;
        await sleep(POLL_MS * 5);
      }
      throw new Error(`no stream start and end in ${timeoutMs} ms (seen start: ${seen})`);
    },
    kill: (signal) => child.kill(signal),
    async stop() {
      child.kill("SIGTERM");
      await child.exited;
    },
    async killAndWait() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    },
  };
  live.push(backend);
  await waitForHealth(port, () => child.exitCode === null && child.signalCode === null);
  return backend;
}

export function sessionDir(root: string, workspaceId: string): string {
  return path.join(root, "sessions", workspaceId);
}

/** Waits until partial.json parses and holds at least one part. */
export async function waitForPartial(root: string, workspaceId: string): Promise<void> {
  const file = path.join(sessionDir(root, workspaceId), "partial.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const partial = JSON.parse(await fs.readFile(file, "utf-8")) as { parts?: unknown[] };
      if ((partial.parts?.length ?? 0) > 0) return;
    } catch {
      // Absent, or caught between writes.
    }
    await sleep(POLL_MS);
  }
  throw new Error("partial.json gave no part in 30 s");
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** The turn use lease files of the workspace, as paths under <root>/locks. */
export async function turnLeaseFiles(root: string): Promise<string[]> {
  return (await listFiles(path.join(root, "locks"))).filter((file) => file.endsWith(".turn.lock"));
}

/**
 * Writes the history write lock of a dead backend, as fileLock.ts:172 builds
 * its token (`pid:nonce:birthHex:identityHex`), from that backend's turn use
 * lease record. So the next backend must judge the holder dead and reclaim it.
 */
export async function writeDeadHistoryToken(root: string, workspaceId: string): Promise<void> {
  const leases = await turnLeaseFiles(root);
  assert(leases.length === 1, `one turn use lease at the kill, got ${leases.length}`);
  const record = JSON.parse(
    await fs.readFile(path.join(root, "locks", leases[0]), "utf-8")
  ) as Record<string, unknown>;
  assert(typeof record.pid === "number", "the lease record names a pid");
  const identity = parseProcessIdentity(record);
  const hex = (text: string) => Buffer.from(text).toString("hex");
  const token = `${record.pid}:killed:${identity.birth === null ? "" : hex(identity.birth)}:${hex(JSON.stringify(identity))}`;
  await fs.writeFile(historyWriteLockPath(root, workspaceId), token);
}

interface RowShape {
  role: unknown;
  id: string;
  historySequence: unknown;
  partial: boolean;
  error: boolean;
  parts: unknown[];
}

export interface Snapshot {
  rows: RowShape[];
  partial: RowShape | null;
  locks: string[];
  /** The text of the partial, or of each row, for the prefix check. */
  partialText: string;
  rowTexts: string[];
}

function textOf(message: { parts?: Array<{ type?: unknown; text?: unknown }> }): string {
  return (message.parts ?? [])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function shapeOf(message: Record<string, unknown>): RowShape {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  const parts = (message.parts ?? []) as Array<{ type?: unknown }>;
  return {
    role: message.role,
    id: String(message.id),
    historySequence: metadata.historySequence,
    partial: metadata.partial === true,
    error: "error" in metadata,
    parts: parts.map((part) => part.type),
  };
}

/** Rows of chat.jsonl, partial.json and the listing of <root>/locks. */
export async function snapshot(root: string, workspaceId: string): Promise<Snapshot> {
  const dir = sessionDir(root, workspaceId);
  const lines = (await fs.readFile(path.join(dir, "chat.jsonl"), "utf-8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
  const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  let partial: Record<string, unknown> | null = null;
  try {
    partial = JSON.parse(await fs.readFile(path.join(dir, "partial.json"), "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    partial = null;
  }
  return {
    rows: messages.map(shapeOf),
    partial: partial === null ? null : shapeOf(partial),
    locks: await listFiles(path.join(root, "locks")),
    partialText: partial === null ? "" : textOf(partial),
    rowTexts: messages.map(textOf),
  };
}

/**
 * Masks what changes from run to run: ids become id0, id1, ... in order of
 * first use (so a reused id stays visible), and hashes, the workspace id and
 * lease tokens in lock paths become placeholders.
 */
export function normalize(
  workspaceId: string,
  snapshots: Record<string, Snapshot>
): Record<string, unknown> {
  const ids = new Map<string, string>();
  const idOf = (id: string) => {
    if (!ids.has(id)) ids.set(id, `id${ids.size}`);
    return ids.get(id)!;
  };
  const leases = new Map<string, string>();
  const lockOf = (file: string) =>
    file
      .split(workspaceId)
      .join("<ws>")
      .replace(/[0-9a-f]{64}/g, "<h64>")
      .replace(/history-[0-9a-f]{32}\.lock/g, "history-<h32>.lock")
      .replace(/[0-9a-f-]{36}(?=\.turn\.lock$)/, (token) => {
        if (!leases.has(token)) leases.set(token, `<lease${leases.size}>`);
        return leases.get(token)!;
      });
  const row = (shape: RowShape) => ({ ...shape, id: idOf(shape.id) });
  const out: Record<string, unknown> = {};
  for (const [name, snap] of Object.entries(snapshots)) {
    out[name] = {
      rows: snap.rows.map(row),
      partial: snap.partial === null ? null : row(snap.partial),
      locks: snap.locks.map(lockOf),
    };
  }
  return out;
}
