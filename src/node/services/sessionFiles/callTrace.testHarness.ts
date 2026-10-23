/**
 * An ordered trace of the fs calls that the history layer makes (phase 2, PR 2).
 *
 * The golden test compares bytes on disk. It cannot see a removed fsync, a rename before its
 * fsync, a changed file mode or a changed order of writes. This trace records each call in the
 * order the code makes it, so historyFiles.trace.test.ts catches those changes when later PRs move
 * the calls behind SessionFiles.
 *
 * Bun keeps three fs objects apart, and a spy on one does not reach the others: the node:fs
 * namespace (named imports such as renameSync are live bindings of it), the node:fs/promises
 * namespace, and the CommonJS fs object (writeFileAtomic.ts) with its own .promises object
 * (compactionCancellation.ts, continuousCompactionJournal.ts, utils/fs.ts). The trace spies on all
 * four. A row holds the call name without its object, so a module that moves from one object to
 * another keeps its trace.
 */
import { spyOn } from "bun:test";
import fsCjs from "fs";
import * as fsNs from "node:fs";
import * as fspNs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";

export interface TraceRow {
  /** The call name, for example "renameSync", "open" or "handle.sync". */
  api: string;
  /** The path (or the file of an fd), relative to the session folder or as "<root>/...". */
  file: string;
  /** The target of a rename, copy or link. */
  to?: string;
  /** open flags as passed; numeric flags as their O_* names. */
  flags?: string;
  /** The mode, in octal, from a mode argument or an options object. */
  mode?: string;
  /** Other primitive options, for example recursive or force. Encodings are left out. */
  options?: Record<string, string | number | boolean>;
}

export interface CallTrace {
  rows: TraceRow[];
  stop(): void;
}

type AnyFunction = (...args: unknown[]) => unknown;

const TWO_PATHS = new Set(["rename", "copyFile", "link", "symlink", "cp"]);
const DATA_AT_ONE = new Set(["writeFile", "appendFile"]);
// Positions and lengths follow from the data, which the golden test already compares.
const DATA_IO = new Set(["read", "write", "readv", "writev"]);
const MODE_AT_ONE = new Set(["chmod", "fchmod", "lchmod", "mkdir"]);
const HANDLE_METHODS = [
  "appendFile",
  "chmod",
  "chown",
  "close",
  "datasync",
  "read",
  "readFile",
  "readv",
  "stat",
  "sync",
  "truncate",
  "utimes",
  "write",
  "writeFile",
  "writev",
] as const;

const octal = (mode: number) => `0o${mode.toString(8)}`;

/** Numeric open flags differ per platform, so a number becomes its O_* names. */
function flagNames(flags: string | number): string {
  if (typeof flags === "string") return flags;
  const constants = fsCjs.constants as unknown as Record<string, number>;
  const access = ["O_RDONLY", "O_WRONLY", "O_RDWR"].find((name) => constants[name] === (flags & 3));
  const bits = Object.keys(constants).filter((name) => {
    const bit = constants[name];
    return name.startsWith("O_") && bit > 3 && (flags & bit) === bit;
  });
  return [access ?? String(flags & 3), ...bits.sort()].join("|");
}
const baseName = (api: string) => api.replace(/Sync$/, "");

/**
 * Temp names hold random parts (writeFileAtomic.ts tempPathFor, the .continuous-, .follow-up- and
 * .publication- stages, historyAppendProvenance.ts's .<uuid>.tmp, fileLock.ts's .tmp-<pid>-<hex>
 * and .stale-<hex>). The tokens keep the kind of temp file, so a changed name still shows.
 */
function normalizeName(name: string): string {
  return name
    .replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\.tmp-\d+-[0-9a-f]{16}$/, ".tmp-<pid>-<hex>")
    .replace(/\.stale-[0-9a-f]{8}$/, ".stale-<hex>")
    .replace(/\.[0-9a-f]{12}$/, ".<12 hex>");
}

/**
 * Start recording the fs calls on paths under root (the temp root of createTestHistoryService).
 * Calls on other paths, and on fds opened outside root, stay out of the trace. Session-folder paths
 * are relative ("." is the folder). The lock files outside it keep their name, because the hash in
 * it comes from the fixed workspace id and an older build looks for the same name.
 */
export function startCallTrace(root: string, sessionDir: string): CallTrace {
  const rows: TraceRow[] = [];
  const fds = new Map<number, string>();
  const spies: Array<{ mockRestore(): void }> = [];
  // A call that an fs function makes while it runs is part of that call, not a new row.
  let depth = 0;

  // writeFileAtomic resolves symlinks first, so a temp root behind a symlink (macOS) shows up
  // under its real path too.
  const realRoot = fsCjs.realpathSync(root);
  const token = (value: unknown): string | undefined => {
    const text = typeof value === "string" ? value : value instanceof URL ? value.pathname : null;
    if (text === null) return undefined;
    let absolute = path.resolve(text);
    if (absolute === realRoot || absolute.startsWith(realRoot + path.sep))
      absolute = root + absolute.slice(realRoot.length);
    if (absolute === sessionDir || absolute.startsWith(sessionDir + path.sep))
      return normalizeName(path.relative(sessionDir, absolute) || ".");
    if (absolute === root || absolute.startsWith(root + path.sep))
      return normalizeName(`<root>/${path.relative(root, absolute)}`);
    return undefined;
  };

  function describe(api: string, args: unknown[]): TraceRow | undefined {
    const name = baseName(api);
    const file = typeof args[0] === "number" ? fds.get(args[0]) : token(args[0]);
    if (file === undefined) return undefined;
    const row: TraceRow = { api, file };
    if (DATA_IO.has(name)) return row;
    args.slice(1).forEach((arg, index) => {
      const position = index + 1;
      if (
        arg === undefined ||
        typeof arg === "function" ||
        (position === 1 && DATA_AT_ONE.has(name))
      )
        return;
      if (position === 1 && TWO_PATHS.has(name)) row.to = token(arg) ?? "<outside root>";
      else if (name === "open" && position === 1) row.flags = flagNames(arg as string | number);
      else if (typeof arg === "number" && (name === "open" || MODE_AT_ONE.has(name)))
        row.mode = octal(arg);
      else if (arg !== null && typeof arg === "object" && !ArrayBuffer.isView(arg)) {
        for (const [key, value] of Object.entries(arg)) {
          if (key === "mode" && typeof value === "number") row.mode = octal(value);
          else if (key !== "encoding" && ["string", "number", "boolean"].includes(typeof value))
            (row.options ??= {})[key] = value as string | number | boolean;
        }
      }
      // Other positional values (chown's uid and gid) belong to the machine, not the code.
    });
    return row;
  }

  function wrapHandle(handle: FileHandle, file: string): FileHandle {
    fds.set(handle.fd, file);
    const methods = handle as unknown as Record<string, AnyFunction>;
    for (const method of HANDLE_METHODS) {
      const original = methods[method];
      // An own property shadows the prototype method; [Symbol.asyncDispose] calls this.close().
      methods[method] = (...args: unknown[]) => {
        if (depth === 0) {
          const row: TraceRow = { api: `handle.${method}`, file };
          if (method === "chmod" && typeof args[0] === "number") row.mode = octal(args[0]);
          rows.push(row);
        }
        if (method === "close") fds.delete(handle.fd);
        return call(original, handle, args);
      };
    }
    return handle;
  }

  function call(original: AnyFunction, self: unknown, args: unknown[]): unknown {
    depth++;
    try {
      return original.apply(self, args);
    } finally {
      depth--;
    }
  }

  function traced(api: string, original: AnyFunction, self: unknown, args: unknown[]): unknown {
    const row = depth === 0 ? describe(api, args) : undefined;
    if (row === undefined) return call(original, self, args);
    rows.push(row);
    const name = baseName(api);
    if (name === "close" && typeof args[0] === "number") fds.delete(args[0]);
    if (name !== "open") return call(original, self, args);
    const callback = args.at(-1);
    if (typeof callback === "function") {
      // The callback open: map its fd before the caller can use it.
      const mapped = (error: unknown, fd: number) => {
        if (error == null) fds.set(fd, row.file);
        (callback as AnyFunction)(error, fd);
      };
      return call(original, self, [...args.slice(0, -1), mapped]);
    }
    const result = call(original, self, args);
    if (typeof result === "number") fds.set(result, row.file);
    if (result instanceof Promise)
      return result.then((handle: FileHandle) => wrapHandle(handle, row.file));
    return result;
  }

  const targets = new Set<object>([fsNs, fspNs, fsCjs, fsCjs.promises]);
  for (const target of targets) {
    const functions = target as unknown as Record<string, AnyFunction>;
    for (const api of Object.keys(target)) {
      const original = functions[api];
      // Lower-case names are the calls; upper-case ones are classes such as Stats or Dirent.
      if (typeof original !== "function" || !/^[a-z]/.test(api)) continue;
      const spy = spyOn(functions, api).mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        return traced(api, original, this, args);
      });
      spies.push(spy);
    }
  }

  return {
    rows,
    stop() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
