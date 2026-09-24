/**
 * Child-process driver for crossProcessLock.test.ts (not a test file itself).
 * Usage: bun crossProcessLock.testChild.ts <role> <lockPath> <staleMs> [arg]
 * Emits one JSON line per event on stdout; reads commands from stdin lines.
 *   hold          acquire, emit "acquired", wait for "release", report ownership, release
 *   hold-starved  like hold, but first blocks the fs threadpool on FIFOs in dir <arg>
 *   try           wait for "go", try-lock (timeout 0), emit acquired/refused, wait "release"
 *   contend       acquire with timeout <arg> ms, emit acquired/refused, release, exit
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

import { acquireCrossProcessLock } from "./crossProcessLock";

const [role, lockPath, staleMsArg, arg] = process.argv.slice(2);
const staleMs = Number(staleMsArg);
const emit = (event: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
// Async reads are fine: the parent unblocks a starved threadpool before "release".
const currentToken = async () =>
  (JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as { token: string }).token;

const lines = readline.createInterface({ input: process.stdin });
const pending: string[] = [];
const waiters: Array<() => void> = [];
lines.on("line", (line) => {
  pending.push(line.trim());
  waiters.splice(0).forEach((wake) => wake());
});
async function waitFor(command: string): Promise<void> {
  for (;;) {
    const index = pending.indexOf(command);
    if (index >= 0) {
      pending.splice(index, 1);
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}

async function acquire(timeoutMs: number) {
  return acquireCrossProcessLock({
    lockPath,
    acquireTimeoutMs: timeoutMs,
    staleMs,
    timeoutMessage: "child busy",
  });
}

async function main(): Promise<void> {
  if (role === "hold" || role === "hold-starved") {
    const release = await acquire(5_000);
    const token = await currentToken();
    if (role === "hold-starved") {
      // Each open() of a FIFO without a writer parks one fs worker thread;
      // the parent created one FIFO per worker plus spares.
      for (const name of await fsPromises.readdir(arg)) {
        fsPromises.open(path.join(arg, name), "r").then(
          (handle) => handle.close(),
          () => undefined
        );
      }
    }
    emit("acquired", { token });
    await waitFor("release");
    emit("resumed", { stillOwner: (await currentToken()) === token });
    await release();
    const lockExists = await fsPromises.stat(lockPath).then(
      () => true,
      () => false
    );
    emit("released", { lockExists });
  } else if (role === "try") {
    await waitFor("go");
    try {
      const release = await acquire(0);
      emit("acquired");
      await waitFor("release");
      await release();
    } catch (error) {
      emit("refused", { message: String(error) });
    }
  } else if (role === "contend") {
    try {
      const release = await acquire(Number(arg));
      emit("acquired", { token: await currentToken() });
      await release();
    } catch (error) {
      emit("refused", { message: String(error) });
    }
  } else {
    throw new Error(`unknown role ${role}`);
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
