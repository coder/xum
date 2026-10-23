/**
 * Host trap for the in-memory agent-loop proof (phase 5 of the agent-loop refactor).
 *
 * installHostTrap() wraps the host modules (fs, fs/promises, child_process, net, os), the Bun
 * process and file APIs, fetch and the timers. While the trap is armed, each call adds a row
 * { api, arg, site }. The proof arms the trap before it builds the loop and fails on any row
 * that its disk rule does not allow.
 *
 * Only tests/hostTrap.preload.ts calls installHostTrap(), and only `make test-host-proof`
 * loads that preload, through tests/hostProof.bunfig.toml, BEFORE tests/setup.ts. Never load
 * it from tests/setup.ts or bunfig.toml: the trap must stay out of the normal suite.
 *
 * Why it is preloaded first: on Bun 1.4.3 a patch made after the first ESM import of a module misses the
 * named, namespace and dynamic imports of it. A patch made first catches every import form.
 * So this file must not import a host module itself (a type-only import is fine), and it
 * reaches the CommonJS module objects through process.getBuiltinModule.
 *
 * Why one global flag and no AsyncLocalStorage: Bun 1.4.3 loses that context across
 * MessageChannel, a ReadableStream made outside the scope and an emitter that outside work
 * emits. The proof process runs only proof files, so the flag catches every call in the
 * window, from any async context.
 *
 * Not recorded: Date.now and performance.now (phase 3 guards clock reads, and the proof checks
 * row times), and process.env.
 */
import type * as NodeFs from "node:fs";

export interface HostTrapRow {
  api: string;
  /** The first argument: a path, a command, a URL, a delay or an fd. */
  arg: string;
  /** The first src/ or tests/ stack frame outside this file. */
  site: string;
}

export interface HostTrap {
  /** Clears the rows and the open work, then records. */
  arm(): void;
  disarm(): void;
  rows(): readonly HostTrapRow[];
  /**
   * Waits until no recorded host work is open: promises, callbacks, streams, children,
   * FileHandles, Bun.file reads and timers made while armed. Fails after maxMs and names
   * the open work. Bun's process.getActiveResourcesInfo() returns [] (a stub), so the trap
   * counts this work itself.
   */
  drain(maxMs?: number): Promise<void>;
  /** False when tests/setup.ts ran before the trap: then the trap misses imports. */
  readonly installedBeforeSetup: boolean;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

const TRAP_KEY = Symbol.for("xum.hostTrap");
const HARNESS_FILE = "hostTrap.testHarness.ts";

function isFunction(value: unknown): value is AnyFunction {
  return typeof value === "function";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    isFunction((value as { then?: unknown }).then)
  );
}

function argText(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL) return arg.href;
  if (typeof arg === "number") return `fd/${arg}`;
  if (Array.isArray(arg)) return String(arg[0]);
  if (typeof arg === "object" && arg !== null && "url" in arg) return String(arg.url);
  return "";
}

function callSite(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  for (const frame of frames) {
    const match = /((?:src|tests)\/[^:)\s]+\.tsx?:\d+)/.exec(frame);
    if (match && !match[1].includes(HARNESS_FILE)) return match[1];
  }
  return "?";
}

function createTrap(installedBeforeSetup: boolean) {
  const rows: HostTrapRow[] = [];
  const open = new Map<number, string>();
  let armed = false;
  let recording = false;
  let nextId = 1;
  // Taken before the timers are wrapped, so drain() itself adds no row.
  const realSetImmediate = globalThis.setImmediate;

  /** Adds a row and returns its id, or null when the trap is not armed. */
  function record(api: string, arg: unknown): number | null {
    if (!armed || recording) return null;
    // A host call inside the bookkeeping below must not record itself.
    recording = true;
    try {
      rows.push({ api, arg: argText(arg), site: callSite() });
      return nextId++;
    } finally {
      recording = false;
    }
  }

  /** Opens work that adds no row (a zero-delay timer), or null when the trap is not armed. */
  function track(what: string): number | null {
    if (!armed || recording) return null;
    const id = nextId++;
    open.set(id, what);
    return id;
  }

  function openUntil(id: number | null, what: string, done: PromiseLike<unknown>): void {
    if (id === null) return;
    open.set(id, what);
    const settle = () => open.delete(id);
    done.then(settle, settle);
  }

  function openUntilEvent(
    id: number | null,
    what: string,
    emitter: { once(event: string, listener: () => void): unknown }
  ): void {
    if (id === null) return;
    open.set(id, what);
    emitter.once("close", () => open.delete(id));
  }

  const trap: HostTrap = {
    arm() {
      rows.length = 0;
      open.clear();
      armed = true;
    },
    disarm() {
      armed = false;
    },
    rows: () => rows,
    async drain(maxMs = 3000) {
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        if (open.size === 0) return;
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      throw new Error(`hostTrap: host work still open: ${[...open.values()].join(", ")}`);
    },
    installedBeforeSetup,
  };
  return { trap, record, track, openUntil, openUntilEvent, open };
}

type Recorder = ReturnType<typeof createTrap>;

/** Child-process functions that return a ChildProcess, which emits "close". */
const CHILD_FUNCTIONS = new Set(["spawn", "exec", "execFile", "fork"]);

function wrapFunction(rec: Recorder, original: AnyFunction, api: string, promiseApi: boolean) {
  const name = api.slice(api.indexOf(".") + 1);
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const id = rec.record(api, args[0]);
    if (id !== null && !promiseApi && !name.endsWith("Sync")) {
      // Callback form (fs.readFile(path, cb)): open until the callback runs.
      const at = args.findLastIndex(isFunction);
      if (at >= 0) {
        const callback = args[at] as AnyFunction;
        rec.open.set(id, api);
        args[at] = function (this: unknown, ...results: unknown[]) {
          rec.open.delete(id);
          return callback.apply(this, results);
        };
      }
    }
    const result = original.apply(this, args);
    if (api === "fs.createWriteStream") wrapStreamWrite(rec, result, args[0]);
    if (id === null) return result;
    if (api === "fsp.open" && isThenable(result)) {
      // A FileHandle stays open until close(), after the open promise settled.
      rec.open.set(id, `FileHandle ${argText(args[0])}`);
      result.then(
        (handle) => {
          const fileHandle = handle as { close: AnyFunction };
          const close = fileHandle.close;
          fileHandle.close = function (this: unknown, ...closeArgs: unknown[]) {
            const closed = close.apply(this, closeArgs);
            if (isThenable(closed))
              closed.then(
                () => rec.open.delete(id),
                () => rec.open.delete(id)
              );
            return closed;
          };
        },
        () => rec.open.delete(id)
      );
      return result;
    }
    const exited = (result as { exited?: unknown } | null)?.exited;
    if (isThenable(result)) {
      rec.openUntil(id, api, result);
    } else if (isThenable(exited)) {
      // Bun.spawn: open until the child exits.
      rec.openUntil(id, api, exited);
    } else if (
      /^fs\.create(Read|Write)Stream$/.test(api) ||
      (api.startsWith("cp.") && CHILD_FUNCTIONS.has(name))
    ) {
      const emitter = result as { once(event: string, listener: () => void): unknown };
      rec.openUntilEvent(id, api, emitter);
    }
    return result;
  };
  // Keep the properties of the original, such as util.promisify.custom on fs.exists.
  Object.assign(wrapped, original);
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    Reflect.set(wrapped, symbol, Reflect.get(original, symbol));
  }
  return wrapped;
}

/**
 * The log sink writes through a WriteStream, whose fs calls are native, so the trap records
 * write(). It wraps every stream, also one opened before arm() (the log sink can open first),
 * and record() decides at each write whether the trap is armed.
 */
function wrapStreamWrite(rec: Recorder, stream: unknown, path: unknown): void {
  const write = (stream as { write?: unknown } | null)?.write;
  if (!isFunction(write)) return;
  (stream as { write: AnyFunction }).write = function (this: unknown, ...writeArgs: unknown[]) {
    rec.record("WriteStream.write", path);
    return write.apply(this, writeArgs);
  };
}

function wrapModule(rec: Recorder, mod: object, prefix: string, promiseApi: boolean): void {
  for (const name of Object.keys(mod)) {
    const original: unknown = Reflect.get(mod, name);
    // Skip classes (Stats, ReadStream, ...) and constants.
    if (!isFunction(original) || /^[A-Z]/.test(name)) continue;
    Reflect.set(mod, name, wrapFunction(rec, original, `${prefix}${name}`, promiseApi));
  }
}

function wrapBun(rec: Recorder): void {
  const bun = globalThis.Bun as unknown as Record<string, unknown>;
  for (const name of ["spawn", "spawnSync", "write"] as const) {
    const original = bun[name];
    if (isFunction(original))
      bun[name] = wrapFunction(rec, original, `Bun.${name}`, name === "write");
  }
  const file = bun.file;
  if (isFunction(file)) {
    bun.file = function (this: unknown, ...args: unknown[]) {
      rec.record("Bun.file", args[0]);
      const handle = file.apply(this, args) as Record<string, unknown>;
      // Bun.file() reads lazily: record and track each read.
      for (const method of ["text", "json", "arrayBuffer", "bytes", "exists"]) {
        const read = handle[method];
        if (!isFunction(read)) continue;
        handle[method] = function (this: unknown, ...readArgs: unknown[]) {
          const id = rec.record(`Bun.file.${method}`, args[0]);
          const result = read.apply(this, readArgs);
          if (isThenable(result)) rec.openUntil(id, `Bun.file.${method}`, result);
          return result;
        };
      }
      return handle;
    };
  }
  const fetch = globalThis.fetch as unknown as AnyFunction;
  globalThis.fetch = wrapFunction(rec, fetch, "fetch", true) as unknown as typeof globalThis.fetch;
}

function wrapTimers(rec: Recorder): void {
  const handles = new Map<unknown, number>();
  for (const [setName, clearName] of [
    ["setTimeout", "clearTimeout"],
    ["setInterval", "clearInterval"],
  ] as const) {
    const set = globalThis[setName] as unknown as AnyFunction;
    const clear = globalThis[clearName] as unknown as AnyFunction;
    const wrappedSet = function (
      this: unknown,
      callback: unknown,
      delay?: unknown,
      ...rest: unknown[]
    ) {
      // A delay under 1 ms is a yield, not a wait: phase 3 lets it pass, so it adds no row. It
      // still stays open until its callback runs, so drain() cannot end the window before a
      // host call in that callback.
      const ms = typeof delay === "number" ? delay : 0;
      const id = ms >= 1 ? rec.record(setName, String(ms)) : rec.track(`${setName} ${ms}`);
      let run = callback;
      if (id !== null && setName === "setTimeout" && isFunction(callback)) {
        run = function (this: unknown, ...args: unknown[]) {
          rec.open.delete(id);
          return callback.apply(this, args);
        };
      }
      const handle = set.call(this, run, delay, ...rest);
      if (id !== null) {
        rec.open.set(id, `${setName} ${ms}`);
        handles.set(handle, id);
      }
      return handle;
    };
    const wrappedClear = function (this: unknown, handle: unknown) {
      const id = handles.get(handle);
      if (id !== undefined) {
        rec.open.delete(id);
        handles.delete(handle);
      }
      return clear.call(this, handle);
    };
    Reflect.set(globalThis, setName, Object.assign(wrappedSet, set));
    Reflect.set(globalThis, clearName, wrappedClear);
  }
  // setImmediate is a yield too: no row, but open until its callback runs or it is cleared.
  const setImmediateReal = globalThis.setImmediate as unknown as AnyFunction;
  const clearImmediateReal = globalThis.clearImmediate as unknown as AnyFunction;
  const immediates = new Map<unknown, number>();
  const wrappedSetImmediate = function (this: unknown, callback: unknown, ...rest: unknown[]) {
    const id = isFunction(callback) ? rec.track("setImmediate") : null;
    const run =
      id === null
        ? callback
        : function (this: unknown, ...args: unknown[]) {
            rec.open.delete(id);
            immediates.delete(handle);
            return (callback as AnyFunction).apply(this, args);
          };
    const handle = setImmediateReal.call(this, run, ...rest);
    if (id !== null) immediates.set(handle, id);
    return handle;
  };
  const wrappedClearImmediate = function (this: unknown, handle: unknown) {
    const id = immediates.get(handle);
    if (id !== undefined) {
      rec.open.delete(id);
      immediates.delete(handle);
    }
    return clearImmediateReal.call(this, handle);
  };
  Reflect.set(globalThis, "setImmediate", Object.assign(wrappedSetImmediate, setImmediateReal));
  Reflect.set(globalThis, "clearImmediate", wrappedClearImmediate);
}

/** Installs the trap once per process. Only tests/hostTrap.preload.ts calls this. */
export function installHostTrap(): HostTrap {
  const existing: unknown = Reflect.get(globalThis, TRAP_KEY);
  if (existing !== undefined) return existing as HostTrap;
  const setupRan = Object.keys(require.cache).some((key) => key.includes("tests/setup"));
  const rec = createTrap(!setupRan);
  const fs = process.getBuiltinModule("fs") as typeof NodeFs;
  wrapModule(rec, fs, "fs.", false);
  // On Bun 1.4.3 fs.promises and require("fs/promises") are one object.
  wrapModule(rec, fs.promises, "fsp.", true);
  const fsPromises = process.getBuiltinModule("fs/promises") as object;
  if (fsPromises !== fs.promises) wrapModule(rec, fsPromises, "fsp.", true);
  wrapModule(rec, process.getBuiltinModule("child_process") as object, "cp.", false);
  wrapModule(rec, process.getBuiltinModule("net") as object, "net.", false);
  wrapModule(rec, process.getBuiltinModule("os") as object, "os.", false);
  wrapBun(rec);
  wrapTimers(rec);
  Reflect.set(globalThis, TRAP_KEY, rec.trap);
  return rec.trap;
}

/** The installed trap. Throws at once when the proof runs outside `make test-host-proof`. */
export function hostTrapOrThrow(): HostTrap {
  const trap: unknown = Reflect.get(globalThis, TRAP_KEY);
  if (trap === undefined) throw new Error("hostTrap is absent: run make test-host-proof");
  return trap as HostTrap;
}
