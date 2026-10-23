/**
 * The call record of the session locks: each lock call that the scenarios
 * reach, with the file that makes it and all its arguments (every option).
 * Phase 4 moves these calls behind SessionLocks; each move PR must keep this
 * fixture byte for byte, so a changed path, timeout, label or option fails.
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
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fileLock from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import * as crossProcessLock from "@/node/utils/main/crossProcessLock";
import { targetMutationLockFilePath } from "@/node/services/refinement/targetMutationLocks";
import { historyWriteLockPath, refineApplyLockPath } from "@/node/services/workspaceRemoval";
import {
  WorkspaceUseLeases,
  workspaceMutationLockPath,
  workspaceUseLockDir,
} from "@/node/services/workspaceUseLeases";
import {
  type LockNames,
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
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The digest in the last segment of a lock path the code builds. */
function digestOf(file: string): string {
  const digest = /([0-9a-f]{32,64})(\.lock)?$/.exec(path.basename(file))?.[1];
  assert(digest !== undefined, `no digest in ${file}`);
  return digest;
}

/**
 * Masks by name, not by order of use: each temp root and workspace id that the
 * scenarios name, and each digest that the code's own path functions make of
 * them. So a lock built from the wrong id or root shows another name, even
 * when it occurs once. A digest or temp path with no name is collected, and
 * the test fails on it.
 */
function createNames() {
  const roots = new Map<string, string>();
  const hashes = new Map<string, string>();
  const unknown = new Set<string>();
  const names: LockNames = {
    root: (dir, label) => void roots.set(path.resolve(dir), `<root:${label}>`),
    id: (workspaceId) => {
      for (const file of [
        historyWriteLockPath("/", workspaceId),
        refineApplyLockPath("/", workspaceId),
        workspaceMutationLockPath("/", workspaceId),
        workspaceUseLockDir("/", workspaceId),
      ]) {
        hashes.set(digestOf(file), `<hash:${workspaceId}>`);
      }
    },
    target: (key) =>
      void hashes.set(digestOf(targetMutationLockFilePath("/", key)), `<hash:${key}>`),
  };
  const mask = (text: string) => {
    // Hashes first: a target's name holds its raw path, which the roots mask next.
    let out = text.replace(/[0-9a-f]{32,64}/g, (hash) => {
      if (!hashes.has(hash)) unknown.add(hash);
      return hashes.get(hash) ?? "<hash:unknown>";
    });
    for (const [dir, label] of roots) out = out.split(dir).join(label);
    out = out.replace(TMP, (root) => {
      unknown.add(root);
      return "<root:unknown>";
    });
    return out.replace(UUID, "<uuid>");
  };
  return { names, mask, unknown };
}

/**
 * Serializes every argument of a lock call by its kind, so no option can drop
 * out of the record. Strings are masked. An argument of another kind fails.
 */
function serialize(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") return mask(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return "<function>";
  if (value instanceof AbortSignal) return "<AbortSignal>";
  if (Array.isArray(value)) return value.map((item) => serialize(item, mask));
  const proto: unknown = Object.getPrototypeOf(value);
  assert(proto === Object.prototype || proto === null, `lock call argument of unknown kind`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, serialize(item, mask)])
  );
}

type Row = Record<string, unknown>;

/** Spies on every session lock function and records each call with all its arguments. */
function recordLockCalls() {
  const { names, mask, unknown } = createNames();
  /** Each call in order, unmasked: the scenarios name their roots while they run. */
  const calls: Array<{ site: string; fn: string; args: unknown[] }> = [];
  const waiters: Array<{ lockPath: string; resolve: () => void }> = [];
  const add = (fn: string, args: unknown[], lockPath?: string) => {
    const site = callSite();
    if (site !== "test") calls.push({ site, fn, args });
    if (lockPath === undefined) return;
    for (const waiter of waiters.splice(0)) {
      if (waiter.lockPath === lockPath) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  const masked = (from = 0): Row[] =>
    calls.slice(from).map((call) => ({ ...call, args: serialize(call.args, mask) }));

  const acquireFile = fileLock.acquireProcessFileLock;
  spyOn(fileLock, "acquireProcessFileLock").mockImplementation((options) => {
    add("acquireProcessFileLock", [options], options.lockPath);
    return acquireFile(options);
  });
  const acquireRecord = crossProcessLock.acquireCrossProcessLock;
  spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation((options) => {
    add("acquireCrossProcessLock", [options], options.lockPath);
    return acquireRecord(options);
  });
  const inspect = crossProcessLock.inspectCrossProcessLock;
  spyOn(crossProcessLock, "inspectCrossProcessLock").mockImplementation((lockPath) => {
    add("inspectCrossProcessLock", [lockPath], lockPath);
    return inspect(lockPath);
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with .call(this) below
  const hold = WorkspaceUseLeases.prototype.hold;
  spyOn(WorkspaceUseLeases.prototype, "hold").mockImplementation(function (
    this: WorkspaceUseLeases,
    workspaceId,
    kind
  ) {
    add("WorkspaceUseLeases.hold", [workspaceId, kind]);
    return hold.call(this, workspaceId, kind);
  });
  const withLock = workspaceFileLocks.withLock.bind(workspaceFileLocks);
  spyOn(workspaceFileLocks, "withLock").mockImplementation(((key, fn) => {
    // The key is the invariant of withLock: one FIFO per workspace.
    add("workspaceFiles.withLock", [key, fn]);
    return withLock(key, fn);
  }) as typeof withLock);

  return {
    names,
    /** Resolves at the next lock call on lockPath after this call. */
    nextLockCall: (lockPath: string) =>
      new Promise<void>((resolve) => waiters.push({ lockPath, resolve })),
    /** The number of calls so far, and the masked calls from index `from` on. */
    callCount: () => calls.length,
    callsFrom: masked,
    /** The distinct masked calls, sorted. Fails on a digest or temp path with no name. */
    normalized: () => {
      const rows = new Map(masked().map((row) => [JSON.stringify(row), row]));
      assert(unknown.size === 0, `lock calls with no name: ${[...unknown].join(", ")}`);
      return [...rows.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    },
  };
}

afterEach(() => {
  mock.restore();
});

test("moved lock calls keep their options", async () => {
  const record = recordLockCalls();
  await oneTurn(record.names); // history writes, turn use lease, todo_write, review pane, blob lock
  await oneRefusal(record.names); // a live gate: hold() refuses. A live turn owner: inspect says held.
  const removalFrom = record.callCount();
  await oneRemoval(record.names); // removeSessionDirUnderMemoryLocks: refine, target, history lock
  // Removal takes refine, then target, then history: another order can deadlock against an
  // apply that holds refine and waits for history. The sorted rows cannot show the order.
  const removalLocks = record
    .callsFrom(removalFrom)
    .filter((call) => call.fn === "acquireProcessFileLock")
    .map((call) => /\/locks\/([a-z-]+?)-<hash:/.exec(JSON.stringify(call.args))?.[1])
    // One target lock per memory target: keep the kind once.
    .filter((kind, index, kinds) => kind !== kinds[index - 1]);
  expect(removalLocks).toEqual(["refine-apply", "target", "history"]);
  await oneRefineApply(record.names); // the staging lock of a pass, the apply lock
  await oneFork(record.names, record.nextLockCall); // the branch summary marker and its wait

  const actual = record.normalized();
  if (process.env.UPDATE_FIXTURE === "1") {
    await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
    await fs.writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = JSON.parse(await fs.readFile(FIXTURE, "utf-8")) as Row[];
  expect(actual).toEqual(expected);
}, 60_000);
