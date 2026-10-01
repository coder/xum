import * as fsPromises from "fs/promises";
import * as path from "path";
import { assert } from "@/common/utils/assert";

/**
 * Warn (never block) when agent commands or file writes create new entries directly in the
 * shared folders where agents used to leave clutter. A study of past transcripts found about
 * 2,000 such entries (~206 GB) in ~, ~/.cache and ~/.xum-tmp on one host, most of them
 * owned by long-gone workspaces. Blocking was rejected on purpose: users sometimes want an
 * agent to write there, so the write succeeds and the model (never the user) gets a note
 * pointing at $XUM_SCRATCH_DIR instead; see HomeClutterReminderSource.
 *
 * Only direct children are watched: writes inside existing folders (e.g. tool caches) are normal.
 */
export interface ClutterWatchRoot {
  dir: string;
  /** Names Xum itself creates in this root; never reported. */
  isXumOwnedName?: (name: string) => boolean;
}

// StreamManager creates ~/.xum-tmp/<stream token> (up to 8 hex chars) for every stream, in
// every workspace, so a parallel workspace's stream start must not show up as clutter here.
const STREAM_TEMP_DIR_NAME = /^[0-9a-f]{1,8}$/;

export function getClutterWatchRoots(homeDir: string): ClutterWatchRoot[] {
  assert(path.isAbsolute(homeDir), "homeDir must be an absolute path");
  return [
    { dir: homeDir },
    { dir: path.join(homeDir, ".cache") },
    { dir: path.join(homeDir, ".local", "state") },
    { dir: path.join(homeDir, ".xum-tmp"), isXumOwnedName: (n) => STREAM_TEMP_DIR_NAME.test(n) },
  ];
}

/**
 * Direct entry names per root dir. A root that does not exist maps to an empty set; a root
 * that could not be read (EACCES, EIO, ...) has no key, meaning "unknown", so a transient error
 * never makes every existing child look new once the root is readable again.
 */
export type ClutterSnapshot = ReadonlyMap<string, ReadonlySet<string>>;

export type ReadDir = (dir: string) => Promise<string[]>;

const defaultReadDir: ReadDir = (dir) => fsPromises.readdir(dir);

function isMissingDirError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function snapshotClutterRoots(
  roots: readonly ClutterWatchRoot[],
  readDir: ReadDir = defaultReadDir
): Promise<ClutterSnapshot> {
  const entries = await Promise.all(
    roots.map(async (root): Promise<[string, Set<string>] | null> => {
      try {
        return [root.dir, new Set(await readDir(root.dir))];
      } catch (error) {
        return isMissingDirError(error) ? [root.dir, new Set()] : null;
      }
    })
  );
  return new Map(entries.filter((entry) => entry != null));
}

/** Absolute paths that exist in `after` but not in `before`, sorted. Unknown roots are skipped. */
export function diffClutterSnapshots(
  roots: readonly ClutterWatchRoot[],
  before: ClutterSnapshot,
  after: ClutterSnapshot
): string[] {
  const added: string[] = [];
  for (const root of roots) {
    const beforeNames = before.get(root.dir);
    const afterNames = after.get(root.dir);
    if (beforeNames == null || afterNames == null) continue;
    for (const name of afterNames) {
      if (beforeNames.has(name) || root.isXumOwnedName?.(name) === true) continue;
      added.push(path.join(root.dir, name));
    }
  }
  return added.sort();
}

/**
 * One scanner per home dir, shared by every turn and provider attempt. readdir cannot be
 * cancelled, so on a stalled filesystem (network/FUSE home) callers must not start more reads:
 * at most one scan is in flight, and a scan that outlives its callers' timeouts still publishes
 * its result. Unreadable roots keep their last known listing.
 */
export class ClutterScanner {
  readonly roots: readonly ClutterWatchRoot[];
  private readonly readDir: ReadDir;
  private inFlight: { scan: Promise<ClutterSnapshot>; startedAt: number } | null = null;
  private last: ClutterSnapshot | null = null;

  constructor(roots: readonly ClutterWatchRoot[], readDir: ReadDir = defaultReadDir) {
    this.roots = roots;
    this.readDir = readDir;
  }

  /** The in-flight scan, or a new one when none is running. */
  scan(now = Date.now()): Promise<ClutterSnapshot> {
    if (this.inFlight != null) return this.inFlight.scan;
    const scan = snapshotClutterRoots(this.roots, this.readDir)
      .then((fresh) => {
        const merged = new Map(fresh);
        for (const [dir, names] of this.last ?? []) {
          if (!merged.has(dir)) merged.set(dir, names);
        }
        this.last = merged;
        return merged as ClutterSnapshot;
      })
      .finally(() => {
        if (this.inFlight?.scan === scan) this.inFlight = null;
      });
    this.inFlight = { scan, startedAt: now };
    return scan;
  }

  /** How long the current scan has been running (0 when idle). */
  busyForMs(now = Date.now()): number {
    return this.inFlight == null ? 0 : now - this.inFlight.startedAt;
  }
}

const sharedScanners = new Map<string, ClutterScanner>();

export function getSharedClutterScanner(homeDir: string): ClutterScanner {
  const key = path.resolve(homeDir);
  let scanner = sharedScanners.get(key);
  if (scanner == null) {
    scanner = new ClutterScanner(getClutterWatchRoots(key));
    sharedScanners.set(key, scanner);
  }
  return scanner;
}

const MAX_LISTED_ENTRIES = 5;
const MAX_DISPLAY_NAME_CHARS = 80;
// Entry names are attacker-influenced (any process can create one) and land in a trusted-looking
// model notification, so anything that could close the code span, start markup or break lines
// is replaced before display.
const UNSAFE_DISPLAY_CHARS = /[^A-Za-z0-9._+@=,:~/\\ -]/g;

function toSafeDisplay(text: string): string {
  const safe = text.replace(UNSAFE_DISPLAY_CHARS, "?");
  return safe.length > MAX_DISPLAY_NAME_CHARS ? `${safe.slice(0, MAX_DISPLAY_NAME_CHARS)}…` : safe;
}

export function formatClutterNote(entries: readonly string[], homeDir: string): string {
  assert(entries.length > 0, "formatClutterNote requires at least one entry");
  const display = (entry: string) =>
    toSafeDisplay(entry.startsWith(homeDir + path.sep) ? "~" + entry.slice(homeDir.length) : entry);
  const listed = entries.slice(0, MAX_LISTED_ENTRIES).map((entry) => `\`${display(entry)}\``);
  const more =
    entries.length > MAX_LISTED_ENTRIES ? ` (+${entries.length - MAX_LISTED_ENTRIES} more)` : "";
  // Several workspaces share the home dir, so the diff cannot prove who created an entry;
  // say "appeared" rather than "you created".
  const noun = entries.length === 1 ? "entry" : "entries";
  return `New ${noun} ${listed.join(", ")}${more} appeared outside the workspace during this turn. Put helper scripts, logs and other temporary files in $XUM_SCRATCH_DIR (deleted with the workspace); keep a location only if the user asked for it.`;
}
