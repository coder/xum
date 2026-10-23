/**
 * The call record of the session locks: each lock call that the scenarios
 * reach, with the file that makes it and its options (path, timeout, label,
 * kind). Phase 4 moves these calls behind SessionLocks; each move PR must
 * keep this fixture byte for byte, so a changed path, timeout or label fails.
 *
 * The spies sit on the lock modules (namespace exports, the use-lease
 * prototype and the shared MutexMap). In Bun they also reach the named
 * imports of the callers, so the record sees each call before and after the
 * move. Calls from test files (the scenarios' own foreign holders) are left out.
 *
 * Record again after an intended change:
 * UPDATE_FIXTURE=1 bun test ./src/node/services/sessionLocks/sessionLocks.callOptions.test.ts
 * and then `make fmt`.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import * as crossProcessLock from "@/node/utils/main/crossProcessLock";
import { WorkspaceUseLeases } from "@/node/services/workspaceUseLeases";
import {
  oneFork,
  oneRefineApply,
  oneRefusal,
  oneRemoval,
  oneTurn,
} from "./sessionLocks.callOptions.scenarios.testHarness";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "callOptions.json");
const SRC = path.resolve(import.meta.dir, "../../..");
const TEST_FILE = /\.(test|testHarness)\.ts$/;

/**
 * The first source file on the stack below the spies of this file, or "test"
 * when a test file makes the call itself.
 */
function callSite(): string {
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    // A path may hold spaces (and a drive letter), so match up to the last
    // `.ts:line:col` instead of stopping at whitespace.
    const file = /((?:[A-Za-z]:)?[\\/][^():]*\.tsx?):\d+:\d+/.exec(line)?.[1];
    // Skip frames outside src and the spies of this file.
    if (file?.startsWith(SRC) !== true || file === import.meta.path) continue;
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    // The SessionLocks layers only forward a call: the site is their caller.
    if (rel.startsWith("node/services/sessionLocks/") && !TEST_FILE.test(rel)) continue;
    return TEST_FILE.test(rel) ? "test" : rel;
  }
  return "unknown";
}

const TMP = new RegExp(`${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/\\s]+`, "g");

/**
 * Temp root -> <tmp0>, <tmp1>, ... in order of first use, like the hashes: a
 * lock bound to the wrong backend root shows another token.
 */
const tmpTokens = new Map<string, string>();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Hash -> <h0>, <h1>, ... in order of first use in one record. A hash keys a
 * lock (one per workspace or target), so two calls that must share a lock show
 * the same token, and a call that hashes the wrong id shows a new one.
 */
const hashTokens = new Map<string, string>();

/** Masks temp roots, hashes and backend tokens: <tmp>/locks/history-<h0>.lock. */
function mask(text: string): string {
  return text
    .replace(TMP, (root) => {
      if (!tmpTokens.has(root)) tmpTokens.set(root, `<tmp${tmpTokens.size}>`);
      return tmpTokens.get(root)!;
    })
    .replace(UUID, "<uuid>")
    .replace(/[0-9a-f]{32,64}/g, (hash) => {
      if (!hashTokens.has(hash)) hashTokens.set(hash, `<h${hashTokens.size}>`);
      return hashTokens.get(hash)!;
    });
}

type Row = Record<string, unknown>;

/** Spies on every session lock function and records each distinct call. */
function recordLockCalls() {
  hashTokens.clear();
  tmpTokens.clear();
  const rows = new Map<string, Row>();
  /** Each recorded call in order, for checks of lock order (the rows are sorted). */
  const calls: Row[] = [];
  const waiters: Array<{ lockPath: string; resolve: () => void }> = [];
  const add = (row: Row, lockPath?: string) => {
    const site = callSite();
    if (site !== "test") {
      const full = { site, ...row };
      rows.set(JSON.stringify(full), full);
      calls.push(full);
    }
    if (lockPath === undefined) return;
    for (const waiter of waiters.splice(0)) {
      if (waiter.lockPath === lockPath) waiter.resolve();
      else waiters.push(waiter);
    }
  };

  const acquireFile = fileLock.acquireProcessFileLock;
  spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) => {
    add(
      {
        fn: "acquireProcessFileLock",
        lockPath: mask(options.lockPath),
        timeoutMs: options.timeoutMs,
        label: options.label,
      },
      options.lockPath
    );
    return acquireFile(options);
  });
  const acquireRecord = crossProcessLock.acquireCrossProcessLock;
  spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation((options) => {
    add(
      {
        fn: "acquireCrossProcessLock",
        lockPath: mask(options.lockPath),
        acquireTimeoutMs: options.acquireTimeoutMs,
        staleMs: options.staleMs,
        timeoutMessage:
          options.timeoutMessage === undefined ? undefined : mask(options.timeoutMessage),
      },
      options.lockPath
    );
    return acquireRecord(options);
  });
  const inspect = crossProcessLock.inspectCrossProcessLock;
  spyOn(crossProcessLock, "inspectCrossProcessLock").mockImplementation((lockPath) => {
    add({ fn: "inspectCrossProcessLock", lockPath: mask(lockPath) }, lockPath);
    return inspect(lockPath);
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this) below
  const hold = WorkspaceUseLeases.prototype.hold;
  spyOn(WorkspaceUseLeases.prototype, "hold").mockImplementation(function (
    this: WorkspaceUseLeases,
    workspaceId,
    kind
  ) {
    add({ fn: "WorkspaceUseLeases.hold", workspaceId: mask(workspaceId), kind });
    return hold.call(this, workspaceId, kind);
  });
  const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
  spyOn(workspaceFileLocks, "withLock").mockImplementation(((key, fn) => {
    // The key is the invariant of withLock: one FIFO per workspace.
    add({ fn: "workspaceFiles.withLock", key: mask(String(key)) });
    return withLock(key, fn);
  }) as typeof withLock);

  return {
    /** Resolves at the next lock call on lockPath after this call. */
    nextLockCall: (lockPath: string) =>
      new Promise<void>((resolve) => waiters.push({ lockPath, resolve })),
    /** The number of calls so far, and the calls from index `from` on. */
    callCount: () => calls.length,
    callsFrom: (from: number) => calls.slice(from),
    normalized: () =>
      [...rows.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

afterEach(() => {
  mock.restore();
});

test("moved lock calls keep their options", async () => {
  const record = recordLockCalls();
  await oneTurn(); // history writes, turn use lease, todo_write, review pane, blob lock
  await oneRefusal(); // a live gate: hold() refuses. A live turn owner: inspect says held.
  const removalFrom = record.callCount();
  await oneRemoval(); // removeSessionDirUnderMemoryLocks: refine, target, history lock
  // Removal takes refine, then target, then history: another order can deadlock against an
  // apply that holds refine and waits for history. The sorted rows cannot show the order.
  const removalLocks = record
    .callsFrom(removalFrom)
    .filter((call) => call.fn === "acquireProcessFileLock")
    .map((call) => /\/([a-z-]+)-<h\d+>\.lock$/.exec(String(call.lockPath))?.[1])
    // One target lock per memory target: keep the kind once.
    .filter((kind, index, kinds) => kind !== kinds[index - 1]);
  expect(removalLocks).toEqual(["refine-apply", "target", "history"]);
  await oneRefineApply(); // the staging lock of a pass, the apply lock
  await oneFork(record.nextLockCall); // the branch summary marker and its wait

  const actual = record.normalized();
  if (process.env.UPDATE_FIXTURE === "1") {
    await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
    await fs.writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = JSON.parse(await fs.readFile(FIXTURE, "utf-8")) as Row[];
  expect(actual).toEqual(expected);
}, 60_000);
