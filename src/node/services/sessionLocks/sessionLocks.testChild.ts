/**
 * A foreign lock holder for the SessionLocks contract: another process that
 * takes one lock, prints "ready <json>", and holds it until stdin says
 * "release" (then it releases and exits) or until the test kills it (then
 * the lock stays behind with a dead pid). Run: bun <this file> <file|record> <path>
 */
import * as readline from "node:readline";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { getSelfIdentity } from "@/node/utils/concurrency/processLiveness";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";

async function main(): Promise<void> {
  const [kind, lockPath] = process.argv.slice(2);
  if ((kind !== "file" && kind !== "record") || lockPath === undefined) {
    throw new Error("usage: sessionLocks.testChild.ts <file|record> <lockPath>");
  }
  const release =
    kind === "file"
      ? await acquireProcessFileLock({
          lockPath,
          timeoutMs: 5_000,
          label: "contract child lock",
        }).then((lock) => () => lock[Symbol.asyncDispose]())
      : await acquireCrossProcessLock({
          lockPath,
          acquireTimeoutMs: 5_000,
          staleMs: 60_000,
          timeoutMessage: "contract child lock is held",
        });
  console.log(`ready ${JSON.stringify({ pid: process.pid, identity: getSelfIdentity() })}`);
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim() === "release") break;
  }
  await release();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
