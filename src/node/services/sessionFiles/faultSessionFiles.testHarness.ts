/**
 * A fault layer for tests: it wraps another SessionFiles layer (node or memory) and cuts or fails
 * one call, so a test can reach a crash point without a child process.
 *
 * A rule names a path. Calls that take a file descriptor (writeSync, fsyncSync) and the methods
 * of an open FileHandle map back to the path that opened them, so writeSync(fd) faults too.
 * Each rule fires once, on the first matching call, and is then gone.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { SessionFilesTag } from "@/node/services/di/tags";
import type { SessionFiles } from "./sessionFiles";

/** A member of SessionFiles or of its promises, by name. */
export type FaultApi =
  | keyof SessionFiles["promises"]
  | Exclude<keyof SessionFiles, "promises" | "constants">;

/** The handle that the test keeps. It holds the rules, not the files. */
export interface Faults {
  /** The next write to path keeps afterBytes bytes, then throws EIO. A crash point. */
  cutNextWrite(path: string, cut: { afterBytes: number }): void;
  /** The next call of api on path throws an errno error, for example ENOSPC. */
  failNext(api: FaultApi, path: string, code: string): void;
}

class FaultRules implements Faults {
  private readonly cuts = new Map<string, number>();
  private readonly failures: Array<{ api: FaultApi; path: string; code: string }> = [];

  cutNextWrite(target: string, cut: { afterBytes: number }): void {
    assert(Number.isSafeInteger(cut.afterBytes) && cut.afterBytes >= 0, "afterBytes must be >= 0");
    this.cuts.set(path.resolve(target), cut.afterBytes);
  }

  failNext(api: FaultApi, target: string, code: string): void {
    this.failures.push({ api, path: path.resolve(target), code });
  }

  /** Throws (and drops) the first failNext rule for this call. */
  checkFail(api: FaultApi, target: string | undefined): void {
    if (target === undefined) return;
    const index = this.failures.findIndex((rule) => rule.api === api && rule.path === target);
    if (index < 0) return;
    const [rule] = this.failures.splice(index, 1);
    throw errnoError(rule.code, api, target);
  }

  /** The byte count of the cut for this path, and drops it; undefined when no cut applies. */
  takeCut(target: string | undefined): number | undefined {
    if (target === undefined) return undefined;
    const afterBytes = this.cuts.get(target);
    this.cuts.delete(target);
    return afterBytes;
  }
}

export function makeFaults(): Faults {
  return new FaultRules();
}

function errnoError(code: string, syscall: string, target: string): Error {
  return Object.assign(new Error(`${code}: injected fault, ${syscall} '${target}'`), {
    code,
    syscall,
    path: target,
  });
}

/** The first `count` bytes of string or binary write data. */
function head(data: unknown, count: number): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8").subarray(0, count);
  assert(ArrayBuffer.isView(data), "fault layer: unsupported write data");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).subarray(0, count);
}

type AnyFunction = (...args: unknown[]) => unknown;
type FileHandle = Awaited<ReturnType<SessionFiles["promises"]["open"]>>;

// Records over the member names, so a new SessionFiles member fails to compile until it is here.
const PROMISE_APIS = Object.keys({
  access: 0,
  appendFile: 0,
  mkdir: 0,
  open: 0,
  readdir: 0,
  readFile: 0,
  rename: 0,
  rm: 0,
  rmdir: 0,
  stat: 0,
  unlink: 0,
} satisfies Record<keyof SessionFiles["promises"], 0>) as Array<keyof SessionFiles["promises"]>;
const MEMBER_APIS = {
  fsyncSync: "sync",
  renameSync: "sync",
  rmdirSync: "sync",
  rmSync: "sync",
  unlinkSync: "sync",
  writeSync: "sync",
  writeFileAtomic: "async",
  fsyncParentDirectory: "async",
  ensurePrivateDir: "async",
} satisfies Record<Exclude<FaultApi, keyof SessionFiles["promises"]>, "sync" | "async">;

const eio = (target: string) => errnoError("EIO", "write", target);

function wrapWithFaults(inner: SessionFiles, rules: FaultRules): SessionFiles {
  const fdPaths = new Map<number, string>();
  const targetOf = (arg: unknown) =>
    typeof arg === "number"
      ? fdPaths.get(arg)
      : typeof arg === "string"
        ? path.resolve(arg)
        : undefined;

  // Own properties shadow the FileHandle's methods, so `await using` (which calls close) and the
  // other methods keep working on the real handle.
  const wrapHandle = (handle: FileHandle, target: string): FileHandle => {
    const { fd } = handle;
    fdPaths.set(fd, target);
    const close = handle.close.bind(handle);
    const write = handle.write.bind(handle) as unknown as AnyFunction;
    const writeFile = handle.writeFile.bind(handle) as unknown as AnyFunction;
    Object.assign(handle, {
      close: async () => {
        fdPaths.delete(fd);
        await close();
      },
      write: async (...args: unknown[]) => {
        const cut = rules.takeCut(target);
        if (cut === undefined) return write(...args);
        const [buffer, offset = 0, length, position] = args as [
          Uint8Array,
          number?,
          number?,
          number?,
        ];
        assert(ArrayBuffer.isView(buffer), "fault layer: cut a write(buffer, ...) only");
        await write(buffer, offset, Math.min(cut, length ?? buffer.byteLength - offset), position);
        throw eio(target);
      },
      writeFile: async (...args: unknown[]) => {
        const cut = rules.takeCut(target);
        if (cut === undefined) return writeFile(...args);
        await writeFile(head(args[0], cut));
        throw eio(target);
      },
    });
    return handle;
  };

  // `call` reads the inner member at each call, so spies on the Node layer keep working.
  const run = (api: FaultApi, call: AnyFunction, args: unknown[]): unknown => {
    const target = targetOf(args[0]);
    rules.checkFail(api, target);
    const cut = api === "appendFile" || api === "writeSync" ? rules.takeCut(target) : undefined;
    if (cut === undefined) {
      if (api !== "open") return call(...args);
      return (call(...args) as Promise<FileHandle>).then((handle) => wrapHandle(handle, target!));
    }
    if (api === "writeSync") {
      const [fd, buffer, offset = 0, length] = args as [number, Uint8Array, number?, number?];
      call(fd, buffer, offset, Math.min(cut, length ?? buffer.byteLength - offset));
      throw eio(target!);
    }
    return (call(args[0], head(args[1], cut)) as Promise<void>).then(() => {
      throw eio(target!);
    });
  };
  // An async member rejects instead of throwing, as `.catch()` chains in the callers expect.
  const wrapAsync =
    (api: FaultApi, call: AnyFunction): AnyFunction =>
    (...args) => {
      try {
        return Promise.resolve(run(api, call, args));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    };

  const promises = Object.fromEntries(
    PROMISE_APIS.map((api) => [
      api,
      wrapAsync(api, (...args) => (inner.promises[api] as AnyFunction)(...args)),
    ])
  ) as unknown as SessionFiles["promises"];
  const members = Object.fromEntries(
    Object.entries(MEMBER_APIS).map(([name, kind]) => {
      const api = name as keyof typeof MEMBER_APIS;
      const call: AnyFunction = (...args) => (inner[api] as AnyFunction)(...args);
      return [
        api,
        kind === "async" ? wrapAsync(api, call) : (...args: unknown[]) => run(api, call, args),
      ];
    })
  ) as unknown as Omit<SessionFiles, "promises" | "constants">;
  return { ...members, promises, constants: inner.constants };
}

/** A layer that builds inner, then wraps each call with the rules of faults. */
export function withFaults(
  inner: Layer.Layer<SessionFilesTag>,
  faults: Faults
): Layer.Layer<SessionFilesTag> {
  assert(faults instanceof FaultRules, "withFaults needs a Faults from makeFaults()");
  return Layer.effect(
    SessionFilesTag,
    Effect.gen(function* () {
      return wrapWithFaults(yield* SessionFilesTag, faults);
    })
  ).pipe(Layer.provide(inner));
}
