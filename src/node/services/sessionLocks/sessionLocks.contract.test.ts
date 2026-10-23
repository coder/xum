import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileLockTimeoutMessage } from "@/node/utils/concurrency/fileLock";
import type { ProcessIdentity } from "@/node/utils/concurrency/processLiveness";
import { SessionLocksNode } from "./nodeSessionLocks";
import {
  buildSessionLocks,
  describeSessionLocksContract,
  type ForeignHolder,
  type LocksUnderTest,
} from "./sessionLocks.contract.testHarness";

const CHILD = path.join(import.meta.dir, "sessionLocks.testChild.ts");
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

/**
 * A real foreign holder: another process takes the lock (sessionLocks.testChild.ts).
 * Dead: the test kills it with SIGKILL, so the lock stays behind with a dead pid.
 */
async function childHolder(
  lockPath: string,
  state: "live" | "dead",
  kind: "file" | "record"
): Promise<ForeignHolder> {
  const child = Bun.spawn(["bun", CHILD, kind, lockPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`the holder exited before it was ready: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const ready = /^ready (.*)$/m.exec(output);
  if (ready === null) throw new Error(`unexpected holder output: ${output}`);
  const { pid, identity } = JSON.parse(ready[1]) as { pid: number; identity: ProcessIdentity };
  if (state === "dead") {
    child.kill("SIGKILL");
    await child.exited;
  }
  return {
    pid,
    identity,
    release: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write("release\n");
      await child.stdin.end();
      await child.exited;
    },
  };
}

async function nodeLocks(): Promise<LocksUnderTest> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-session-locks-"));
  return {
    layer: SessionLocksNode,
    dir,
    foreignHolder: childHolder,
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describeSessionLocksContract("node", nodeLocks);

test("node: the timeout text for a live child holder is fileLockTimeoutMessage", async () => {
  const t = await nodeLocks();
  try {
    const locks = await buildSessionLocks(t.layer);
    const lockPath = path.join(t.dir, "text.lock");
    const holder = await t.foreignHolder(lockPath, "live", "file");
    const error = await locks
      .acquireProcessFileLock({ lockPath, timeoutMs: 200, label: "contract lock" })
      .then(
        () => null,
        (caught: unknown) => caught
      );
    // The fake layers build their refusal with the same function, so both texts match.
    const why = process.platform === "linux" ? "that process is running" : "that pid is running";
    expect((error as Error).message).toBe(
      fileLockTimeoutMessage("contract lock", lockPath, 200, {
        holder: { pid: holder.pid, identity: holder.identity ?? undefined },
        why,
      })
    );
    await holder.release();
  } finally {
    await t.cleanup();
  }
});
