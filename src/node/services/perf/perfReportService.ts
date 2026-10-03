import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import assert from "@/common/utils/assert";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import {
  PERF_CAPTURE_ID_PATTERN,
  PerfCaptureMetadataSchema,
  type PerfCaptureMetadata,
} from "@/common/orpc/schemas/perfCaptures";
import type {
  FlightRecorderSnapshot,
  FlightRecorderStatus,
} from "@/common/orpc/schemas/perfFlightRecorder";
import { getErrorMessage } from "@/common/utils/errors";
import { perfEpochNowMs } from "@/common/utils/perf/clock";
import {
  PERF_REPORT_MAX_CAPTURES,
  PERF_REPORT_MAX_HANG_STACK_CHARS,
  PERF_REPORT_MAX_TOTAL_BYTES,
  PERF_REPORT_STALE_PARTIAL_MS,
} from "@/constants/perfReports";
import { log } from "@/node/services/log";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { VERSION } from "@/version";
import { buildPerfTrace } from "./perfTrace";

/** The fields of a desktop hang record (src/desktop/perf/hangStacks.ts) a report reads. */
export interface PerfReportHangRecord {
  /** Wall-clock epoch ms. */
  at: number;
  durationUntilResponsive?: number;
  stack?: string;
  stackError?: string;
  url: string;
}

/** Desktop-only capabilities; `xum server` has none. */
export interface PerfReportDesktopHooks {
  getHangRecords(): readonly PerfReportHangRecord[];
  /** Electron `app.getAppMetrics()`. */
  getAppMetrics(): unknown;
  /** Shows the bundle in the system file manager. */
  revealPath(dirPath: string): void | Promise<void>;
}

export interface PerfReportServiceOptions {
  /** `<xum home>/perf/reports`. */
  reportsDir: string;
  /** Only its basename is written to the bundle. */
  xumHome: string;
  /** `<xum home>/perf/captures`; profiles are copied from here by validated capture ID. */
  capturesDir: string;
  recorder: {
    getSnapshot(): FlightRecorderSnapshot;
    getStatus(): FlightRecorderStatus;
  };
  captures: { listCaptures(): Promise<{ captures: PerfCaptureMetadata[] }> };
  isExperimentEnabled(experimentId: ExperimentId): boolean;
  /** Perf epoch ms. */
  now?: () => number;
  createId?: () => string;
}

export interface PerfReportResult {
  dir: string;
  revealed: boolean;
  includedCaptures: number;
  skippedCaptures: number;
  totalBytes: number;
}

/** Why a report request was refused. The router maps each refusal to an error code. */
export type PerfReportRefusal = "experiment-off" | "in-progress";

export class PerfReportRefusedError extends Error {
  constructor(
    readonly refusal: PerfReportRefusal,
    message: string
  ) {
    super(message);
    this.name = "PerfReportRefusedError";
  }
}

type CaptureSkipReason =
  | "count-cap"
  | "size-cap"
  | "not-a-regular-file"
  | "missing"
  | "unreadable"
  | "unscrubbable";

interface IncludedCapture {
  metadata: PerfCaptureMetadata;
  /** Bytes of the metadata copy plus the profile copy. */
  bytes: number;
  files: string[];
}

interface SkippedCapture {
  metadata: PerfCaptureMetadata;
  reason: CaptureSkipReason;
}

/**
 * How the user's home directory can be spelled inside a V8 .cpuprofile (JSON text):
 * script URLs such as `file:///home/<user>/...` and plain paths. Longest first. Empty
 * when the home is a filesystem root: scrubbing "/" would mangle every path.
 */
function homePathSpellings(home: string): string[] {
  if (!path.isAbsolute(home) || path.parse(home).root === home) return [];
  const spellings = new Set([
    // As is: raw paths in snapshot strings and hang stacks (C:\Users\<user> on Windows).
    home,
    // As a JSON string: Windows backslashes are escaped.
    JSON.stringify(home).slice(1, -1),
    // A Windows path inside a file URL.
    home.split(path.sep).join("/"),
    // A percent-encoded file URL path.
    pathToFileURL(home).pathname,
  ]);
  return [...spellings].sort((a, b) => b.length - a.length);
}

// What may follow the home directory in a path: a separator (`\\` is the escaped JSON
// form of `\`), a closing quote, bracket, line/column colon, comma or whitespace.
// `<home>2/...` or `<home>-backup` name other folders and are left alone.
const HOME_END = String.raw`(?=[/\\"'),:\s])`;

/**
 * Writes each home spelling as "~". `atEnd` says the text ends here; a streamed chunk
 * passes false so a spelling at its very end waits for the next character.
 */
function scrubHome(text: string, spellings: readonly string[], atEnd = true): string {
  let out = text;
  for (const spelling of spellings) {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?:${HOME_END}${atEnd ? "|$" : ""})`, "g"), "~");
  }
  return out;
}

const REPORT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PARTIAL_DIR_PATTERN = /^\.[A-Za-z0-9-]{1,64}\.partial$/;
const COPY_CHUNK_BYTES = 1024 * 1024;
const MANIFEST_FILE = path.join("captures", "manifest.json");

/** Sortable and readable: `20261003T013338383Z-1a2b3c4d`. */
function defaultCreateId(): string {
  return `${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${randomBytes(4).toString("hex")}`;
}

/** Scheme, host and path only: drops credentials, query and fragment. Null when unparsable. */
function sanitizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

// A URL token in a stack frame or JSON string, with an optional `:line:col` suffix. The
// scheme length is bounded so a long run of letters cannot make the scan quadratic.
const STACK_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s()"]+/g;
const LINE_COL_SUFFIX = /(?::\d+){1,2}$/;

/**
 * The text with every URL sanitized and the home directory written as "~", or null when
 * a URL cannot be parsed.
 */
function sanitizeUrlsIn(text: string, homeSpellings: readonly string[]): string | null {
  let failed = false;
  const sanitized = text.replace(STACK_URL_PATTERN, (token) => {
    const suffix = LINE_COL_SUFFIX.exec(token)?.[0] ?? "";
    const url = sanitizeUrl(token.slice(0, token.length - suffix.length));
    if (url === null) {
      failed = true;
      return "";
    }
    return url + suffix;
  });
  return failed ? null : scrubHome(sanitized, homeSpellings);
}

/**
 * One conservative policy for a field that holds a script URL (LoAF `sourceURL`, a script
 * invoker, a CPU profile `callFrame.url`): a hierarchical URL keeps scheme, host and path;
 * `node:` builtins keep their name; any other URL keeps only its scheme, because an opaque
 * URL (`data:`, `javascript:`) is the script text itself. A plain path is kept (the home
 * scrub runs after this); anything else is dropped. Losing attribution beats exporting a
 * secret.
 */
function sanitizeScriptUrl(raw: string): string {
  // CommonJS frames name absolute paths. Checked first: `new URL()` reads a Windows drive
  // path (C:\\...) as an opaque `c:` URL.
  const isPath = (raw.startsWith("/") && !raw.startsWith("//")) || /^[A-Za-z]:[\\/]/.test(raw);
  // A file name rarely holds "?" or "#"; a URL-like suffix there is dropped like a query.
  if (isPath) return raw.replace(/[?#].*$/s, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Native frames have an empty or bare name.
    return /[:?#@]/.test(raw) ? "" : raw;
  }
  if (url.protocol === "node:") return `node:${url.pathname}`;
  if (url.host !== "" || url.protocol === "file:") return sanitizeUrl(raw) ?? "";
  return url.protocol;
}

/** LoAF invokers name the script URL only for script invoker types; others are labels. */
const SCRIPT_INVOKER_TYPES = new Set(["classic-script", "module-script"]);

/**
 * A copy of the snapshot whose free-text fields cannot name the home directory or carry
 * URL credentials, queries or fragments. LoAF script attribution holds script URLs (e.g.
 * `file:///home/<user>/...` in a dev build), and both snapshot.json and trace.json read it.
 */
function sanitizeSnapshot(
  snapshot: FlightRecorderSnapshot,
  homeSpellings: readonly string[]
): FlightRecorderSnapshot {
  const clean = (text: string) => sanitizeUrlsIn(text, homeSpellings) ?? "";
  return {
    ...snapshot,
    ...(snapshot.failure !== undefined
      ? { failure: scrubHome(snapshot.failure, homeSpellings) }
      : {}),
    renderer: {
      ...snapshot.renderer,
      loaf: snapshot.renderer.loaf.map((entry) => ({
        ...entry,
        scripts: entry.scripts.map((script) => ({
          ...script,
          sourceURL: scrubHome(sanitizeScriptUrl(script.sourceURL), homeSpellings),
          invoker: SCRIPT_INVOKER_TYPES.has(script.invokerType)
            ? scrubHome(sanitizeScriptUrl(script.invoker), homeSpellings)
            : clean(script.invoker),
        })),
      })),
    },
  };
}

// A frame location in a JS stack: any scheme-like token (`https://...`, `data:...`,
// `C:\\...`) up to whitespace or a parenthesis, with an optional `:line:col` suffix.
const STACK_LOCATION_PATTERN = /[A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s()]+/g;

/** A JS stack whose frame locations follow sanitizeScriptUrl, with the home as "~". */
function sanitizeStack(stack: string, homeSpellings: readonly string[]): string {
  const sanitized = stack.replace(STACK_LOCATION_PATTERN, (token) => {
    const suffix = LINE_COL_SUFFIX.exec(token)?.[0] ?? "";
    return sanitizeScriptUrl(token.slice(0, token.length - suffix.length)) + suffix;
  });
  return scrubHome(sanitized, homeSpellings);
}

/**
 * Builds a new record from known fields only. A field that cannot be sanitized is
 * left out; an unknown collection error collapses to "error" (it may quote page data).
 */
function sanitizeHangRecord(
  record: PerfReportHangRecord,
  homeSpellings: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = { at: record.at };
  if (typeof record.durationUntilResponsive === "number") {
    out.durationUntilResponsive = record.durationUntilResponsive;
  }
  const url = sanitizeUrl(record.url);
  if (url !== null) out.url = scrubHome(url, homeSpellings);
  if (typeof record.stack === "string") {
    out.stack = sanitizeStack(record.stack, homeSpellings).slice(
      0,
      PERF_REPORT_MAX_HANG_STACK_CHARS
    );
  }
  if (record.stackError !== undefined) {
    out.stackError =
      record.stackError === "timeout" || record.stackError === "unavailable"
        ? record.stackError
        : "error";
  }
  return out;
}

const README = `Xum slowness report
===================

This folder was written by "Report slowness" (experiment: Performance flight
recorder). It stays on this computer: Xum uploads nothing. Share it with a
developer if you choose to.

It contains no chat content, prompts, tool payloads, session tapes or
environment variables. In the CPU profiles, your home folder is written as "~"
and script URLs keep only scheme, host and path (other URLs only their scheme).

Files
-----
snapshot.json      The flight recorder snapshot: backend event-loop delay, event
                   loop utilization, GC and heap samples; renderer long animation
                   frames and slow input events; slow oRPC calls and WebSocket
                   flow-control waits ("rpc"); and recorder trips.
trace.json         The same timeline (plus CPU profile captures) as Chrome
                   trace-event JSON. Open it in https://ui.perfetto.dev or the
                   Chrome DevTools Performance panel ("Load profile").
                   Clock: ts/dur are whole microseconds on Xum's perf epoch (perf
                   epoch milliseconds * 1000, rounded), the same axis as
                   snapshot.json and the capture metadata (which use milliseconds).
                   Overlapping slices of one row are spread over extra numbered
                   rows, such as "Renderer <id> input events (2)".
captures/          The newest CPU profile captures (*.cpuprofile, open them in the
                   Chrome DevTools Performance panel) and their metadata (*.json):
                   at most ${PERF_REPORT_MAX_CAPTURES}, and the whole folder stays under ${PERF_REPORT_MAX_TOTAL_BYTES / (1024 * 1024)} MiB.
                   manifest.json lists the captures included and the ones left out
                   and why ("count-cap": over the ${PERF_REPORT_MAX_CAPTURES}-capture limit; "size-cap": over
                   the size limit). A capture triggered by a trip shows the activity AFTER
                   its trigger, not the stall itself.
environment.json   Xum version, platform, runtime versions, enabled experiments
                   and the recorder status.
hangs.json         Desktop app only: recent renderer hangs with JS stacks. Times
                   ("at") are wall-clock epoch milliseconds, not the perf epoch,
                   so hangs are not in trace.json. URLs keep scheme, host and path.
app-metrics.json   Desktop app only: Electron process metrics at report time.
`;

/**
 * "Report slowness" (experiment perfFlightRecorder, F4): writes one private, size-bounded
 * bundle directory under `<xum home>/perf/reports/<id>/`.
 *
 * Privacy: it reads only the recorder, `listCaptures()` results plus
 * `<capturesDir>/<validated id>.cpuprofile`, the desktop hooks and process metadata. It
 * never reads session tapes, sessions, chat history or environment variables. It looks
 * up the home directory (os.homedir()) only to remove it from copied profiles.
 */
export class PerfReportService {
  private readonly options: PerfReportServiceOptions;
  private readonly now: () => number;
  private readonly createId: () => string;
  private desktopHooks: PerfReportDesktopHooks | null = null;
  private inFlight = false;
  private readonly homeSpellings: string[];

  constructor(options: PerfReportServiceOptions) {
    this.options = options;
    let home = "";
    try {
      home = os.homedir();
    } catch {
      // No home directory: nothing to scrub.
    }
    this.homeSpellings = homePathSpellings(home);
    this.now = options.now ?? perfEpochNowMs;
    this.createId = options.createId ?? defaultCreateId;
  }

  /** Desktop registers hang records, app metrics and reveal; `xum server` has none. */
  setDesktopHooks(hooks: PerfReportDesktopHooks | null): void {
    this.desktopHooks = hooks;
  }

  /** Rejects with PerfReportRefusedError when the experiment is off or a report is running. */
  createReport(): Promise<PerfReportResult> {
    if (!this.options.isExperimentEnabled(EXPERIMENT_IDS.PERF_FLIGHT_RECORDER)) {
      return Promise.reject(
        new PerfReportRefusedError(
          "experiment-off",
          "Report slowness needs the Performance flight recorder experiment"
        )
      );
    }
    if (this.inFlight) {
      return Promise.reject(
        new PerfReportRefusedError("in-progress", "a slowness report is already being written")
      );
    }
    // Reserved synchronously, so a second call in the same tick is refused.
    this.inFlight = true;
    return this.build().finally(() => {
      this.inFlight = false;
    });
  }

  private async build(): Promise<PerfReportResult> {
    const id = this.createId();
    assert(REPORT_ID_PATTERN.test(id), `invalid perf report id: ${id}`);
    const { reportsDir } = this.options;
    await ensurePrivateDir(reportsDir);
    // Wall clock: compared with directory mtimes.
    await removeAbandonedPartials(reportsDir, Date.now());
    // Built under a hidden name and renamed when complete, so a half-written bundle
    // never appears under its final name.
    const partialDir = path.join(reportsDir, `.${id}.partial`);
    const finalDir = path.join(reportsDir, id);
    await fs.mkdir(partialDir, { mode: 0o700 });
    try {
      // mkdir honours the umask; the bundle must be private regardless.
      await fs.chmod(partialDir, 0o700);
      const result = await this.writeBundle(partialDir);
      await fs.rename(partialDir, finalDir);
      const revealed = await this.reveal(finalDir);
      return { dir: finalDir, revealed, ...result };
    } catch (error) {
      await fs.rm(partialDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async writeBundle(dir: string): Promise<Omit<PerfReportResult, "dir" | "revealed">> {
    const snapshot = sanitizeSnapshot(this.options.recorder.getSnapshot(), this.homeSpellings);
    const status = this.options.recorder.getStatus();
    const hooks = this.desktopHooks;
    // Re-parsed here so a metadata object can never carry fields beyond the schema.
    const listed = (await this.options.captures.listCaptures()).captures.map((capture) =>
      PerfCaptureMetadataSchema.parse(capture)
    );
    const candidates = listed.slice(0, PERF_REPORT_MAX_CAPTURES);
    // Older captures beyond the count limit are listed in the manifest, not dropped silently.
    const countCapped: SkippedCapture[] = listed
      .slice(PERF_REPORT_MAX_CAPTURES)
      .map((metadata) => ({ metadata, reason: "count-cap" }));

    const fixedFiles = new Map<string, string>([
      ["snapshot.json", JSON.stringify(snapshot, null, 2)],
      ["trace.json", JSON.stringify(buildPerfTrace({ snapshot, captures: candidates }))],
      ["environment.json", JSON.stringify(this.environment(status, hooks !== null), null, 2)],
      ["README.txt", README],
    ]);
    if (hooks !== null) {
      fixedFiles.set(
        "hangs.json",
        JSON.stringify(
          hooks.getHangRecords().map((record) => sanitizeHangRecord(record, this.homeSpellings)),
          null,
          2
        )
      );
      fixedFiles.set("app-metrics.json", JSON.stringify(hooks.getAppMetrics() ?? null, null, 2));
    }
    let fixedBytes = Buffer.byteLength(
      renderManifest(
        [],
        [
          ...candidates.map((metadata) => ({ metadata, reason: "size-cap" as const })),
          ...countCapped,
        ]
      )
    );
    for (const content of fixedFiles.values()) fixedBytes += Buffer.byteLength(content);
    if (fixedBytes > PERF_REPORT_MAX_TOTAL_BYTES) {
      throw new Error(
        `slowness report is too large: its required files take ${fixedBytes} bytes, over the ${PERF_REPORT_MAX_TOTAL_BYTES}-byte limit`
      );
    }

    for (const [name, content] of fixedFiles) {
      await writeFileAtomic(path.join(dir, name), content, { mode: 0o600 });
    }

    const capturesOut = path.join(dir, "captures");
    await fs.mkdir(capturesOut, { mode: 0o700 });
    await fs.chmod(capturesOut, 0o700);
    const included: IncludedCapture[] = [];
    const skipped: SkippedCapture[] = [...countCapped];
    let budget = PERF_REPORT_MAX_TOTAL_BYTES - fixedBytes;
    let capped = false;
    // Newest first: once one capture does not fit, every older one is left out too.
    for (const metadata of candidates) {
      if (capped) {
        skipped.push({ metadata, reason: "size-cap" });
        continue;
      }
      const outcome = await this.copyCapture(metadata, capturesOut, budget);
      if ("reason" in outcome) {
        if (outcome.reason === "size-cap") capped = true;
        skipped.push({ metadata, reason: outcome.reason });
        continue;
      }
      budget -= outcome.bytes;
      included.push(outcome);
    }

    // Verify what actually landed on disk; drop the oldest included capture until it fits.
    let totalBytes: number;
    for (;;) {
      await writeFileAtomic(path.join(dir, MANIFEST_FILE), renderManifest(included, skipped), {
        mode: 0o600,
      });
      totalBytes = await measureDir(dir);
      if (totalBytes <= PERF_REPORT_MAX_TOTAL_BYTES) break;
      const oldest = included.pop();
      if (oldest === undefined) {
        throw new Error(
          `slowness report is too large: ${totalBytes} bytes, over the ${PERF_REPORT_MAX_TOTAL_BYTES}-byte limit`
        );
      }
      for (const file of oldest.files) await fs.rm(file, { force: true });
      skipped.push({ metadata: oldest.metadata, reason: "size-cap" });
    }
    return { includedCaptures: included.length, skippedCaptures: skipped.length, totalBytes };
  }

  /**
   * Copies one capture's metadata and (when it has one) its profile. The source path is
   * derived only from the validated capture ID, opened without following a symlink, and
   * must be a regular file with a single link. Profile script URLs hold absolute paths
   * (file:///home/<user>/...), so the copy writes the home directory as "~".
   */
  private async copyCapture(
    metadata: PerfCaptureMetadata,
    outDir: string,
    budget: number
  ): Promise<IncludedCapture | { reason: CaptureSkipReason }> {
    assert(PERF_CAPTURE_ID_PATTERN.test(metadata.id), "perf capture id must be validated");
    const metadataText = JSON.stringify(metadata, null, 2);
    const metadataBytes = Buffer.byteLength(metadataText);
    const metadataPath = path.join(outDir, `${metadata.id}.json`);
    const profileName = `${metadata.id}.cpuprofile`;
    if (metadata.profileFile !== profileName) {
      if (metadataBytes > budget) return { reason: "size-cap" };
      await writeFileAtomic(metadataPath, metadataText, { mode: 0o600 });
      return { metadata, bytes: metadataBytes, files: [metadataPath] };
    }

    const sourcePath = path.join(this.options.capturesDir, profileName);
    // Checked before opening: Windows has no O_NOFOLLOW (open would follow a symlink), and
    // opening a FIFO blocks until a writer appears. A hard link could alias any file of
    // this user; captures are written by rename, so a real one has a single link.
    let checked: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      checked = await fs.lstat(sourcePath);
    } catch (error) {
      return { reason: isErrnoWithCode(error, "ENOENT") ? "missing" : "unreadable" };
    }
    if (!checked.isFile() || checked.nlink > 1) return { reason: "not-a-regular-file" };

    let source: fs.FileHandle;
    try {
      // Both flags are undefined on Windows; the identity check below still applies.
      source = await fs.open(
        sourcePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return { reason: "missing" };
      // ELOOP: the profile became a symlink after the check.
      if (isErrnoWithCode(error, "ELOOP")) return { reason: "not-a-regular-file" };
      return { reason: "unreadable" };
    }
    const profilePath = path.join(outDir, profileName);
    let wrote = false;
    try {
      const stat = await source.stat();
      // The opened file must be the one checked above, not one swapped in since.
      const sameFile = stat.dev === checked.dev && stat.ino === checked.ino;
      if (!sameFile || !stat.isFile() || stat.nlink > 1) return { reason: "not-a-regular-file" };
      if (metadataBytes + stat.size > budget) return { reason: "size-cap" };
      wrote = true;
      const copied = await copyScrubbed(source, profilePath, stat.size, this.homeSpellings);
      await writeFileAtomic(metadataPath, metadataText, { mode: 0o600 });
      return { metadata, bytes: metadataBytes + copied, files: [metadataPath, profilePath] };
    } catch (error) {
      if (wrote) {
        await fs.rm(profilePath, { force: true });
        await fs.rm(metadataPath, { force: true });
      }
      if (error instanceof UnscrubbableProfileError) return { reason: "unscrubbable" };
      log.warn("[perfReports] could not copy capture", {
        id: metadata.id,
        error: getErrorMessage(error),
      });
      return { reason: "unreadable" };
    } finally {
      await source.close();
    }
  }

  private environment(status: FlightRecorderStatus, desktop: boolean): Record<string, unknown> {
    const versions: Record<string, string> = {
      node: process.versions.node,
      v8: process.versions.v8,
    };
    // Set only inside Electron (the desktop app).
    const { electron, chrome } = process.versions;
    if (electron !== undefined) versions.electron = electron;
    if (chrome !== undefined) versions.chrome = chrome;
    return {
      version: 1,
      createdAtMs: this.now(),
      xumVersion: String(VERSION.git_describe),
      gitCommit: String(VERSION.git_commit),
      mode: desktop ? "desktop" : "server",
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      versions,
      enabledExperiments: Object.values(EXPERIMENT_IDS).filter((experimentId) =>
        this.options.isExperimentEnabled(experimentId)
      ),
      recorderStatus: status,
      // The basename only: a full path would name the user's home directory.
      xumHomeName: path.basename(this.options.xumHome),
    };
  }

  /** True when the desktop app showed the bundle; a failure is logged, never thrown. */
  private async reveal(dir: string): Promise<boolean> {
    const hooks = this.desktopHooks;
    if (hooks === null) return false;
    try {
      await hooks.revealPath(dir);
      return true;
    } catch (error) {
      log.warn("[perfReports] could not reveal the report", { error: getErrorMessage(error) });
      return false;
    }
  }
}

function renderManifest(included: IncludedCapture[], skipped: SkippedCapture[]): string {
  const newestFirst = <T extends { metadata: PerfCaptureMetadata }>(captures: T[]) =>
    [...captures].sort((a, b) => b.metadata.startedAtMs - a.metadata.startedAtMs);
  const describe = (metadata: PerfCaptureMetadata) => ({
    id: metadata.id,
    kind: metadata.kind,
    process: metadata.process,
    startedAtMs: metadata.startedAtMs,
  });
  return JSON.stringify(
    {
      version: 1,
      maxTotalBytes: PERF_REPORT_MAX_TOTAL_BYTES,
      included: newestFirst(included).map((capture) => ({
        ...describe(capture.metadata),
        label: capture.metadata.label,
        bytes: capture.bytes,
        files: capture.files.map((file) => path.basename(file)),
      })),
      skipped: newestFirst(skipped).map((capture) => ({
        ...describe(capture.metadata),
        reason: capture.reason,
      })),
    },
    null,
    2
  );
}

/**
 * CPU profile text (JSON) with every `callFrame.url` passed through sanitizeScriptUrl and
 * the home directory written as "~". The renderer's page URL can carry the `xum server`
 * auth token as `?token=`. V8 profiles hold URLs only in "url" fields.
 */
function scrubProfileText(text: string, spellings: readonly string[], atEnd: boolean): string {
  const urlsClean = text.replace(PROFILE_URL_FIELD, (_match, raw: string) => {
    let value = "";
    try {
      value = sanitizeScriptUrl(JSON.parse(`"${raw}"`) as string);
    } catch {
      // Not a valid JSON string: drop it.
    }
    return `"url":${JSON.stringify(value)}`;
  });
  return scrubHome(urlsClean, spellings, atEnd);
}

const PROFILE_URL_FIELD = /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const URL_KEY_BEFORE = /"url"\s*:\s*$/;

/**
 * While copying, text after the last safe cut waits for the next chunk. A profile whose
 * text has no safe cut for this long is skipped instead of being copied unsanitized.
 */
const MAX_HELD_PROFILE_CHARS = 16 * 1024 * 1024;

class UnscrubbableProfileError extends Error {}

/**
 * The end of the last JSON string value in `text` that is followed by `,`, `}` or `]`:
 * cutting there never splits a `"url": "..."` pair or a path. 0 when there is none.
 */
function lastSafeCut(text: string): number {
  for (let i = text.lastIndexOf('"', text.length - 2); i >= 0; i = text.lastIndexOf('"', i - 1)) {
    const next = text[i + 1];
    if (next !== "," && next !== "}" && next !== "]") continue;
    // The opening quote of a url value can be followed by these too (`"url":"]x"`).
    if (URL_KEY_BEFORE.test(text.slice(Math.max(0, i - 32), i))) continue;
    let backslashes = 0;
    while (text[i - 1 - backslashes] === "\\") backslashes++;
    if (backslashes % 2 === 0) return i + 1;
  }
  return 0;
}

/**
 * Copies at most `maxBytes` from `source` into a new private file through
 * scrubProfileText; returns bytes written. Sanitizing can change the length slightly, so
 * the caller measures the bundle after copying.
 */
async function copyScrubbed(
  source: fs.FileHandle,
  destPath: string,
  maxBytes: number,
  spellings: readonly string[]
): Promise<number> {
  const dest = await fs.open(destPath, "wx", 0o600);
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(1, maxBytes)));
    let read = 0;
    let written = 0;
    let pending = "";
    const write = async (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      // FileHandle.write may write less than asked.
      for (let offset = 0; offset < bytes.length; ) {
        const { bytesWritten } = await dest.write(bytes, offset);
        assert(bytesWritten > 0, "profile copy made no progress");
        offset += bytesWritten;
      }
      written += bytes.length;
    };
    while (read < maxBytes) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes - read),
        read
      );
      if (bytesRead === 0) break;
      read += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      // A cut right after a quote never splits a surrogate pair either.
      const cut = lastSafeCut(pending);
      if (pending.length - cut > MAX_HELD_PROFILE_CHARS) throw new UnscrubbableProfileError();
      await write(scrubProfileText(pending.slice(0, cut), spellings, false));
      pending = pending.slice(cut);
    }
    await write(scrubProfileText(pending + decoder.end(), spellings, true));
    await dest.sync();
    return written;
  } finally {
    await dest.close();
  }
}

/**
 * Removes `.<id>.partial` directories left by a report that never finished (the process
 * quit or crashed before the rename). Only old ones: another Xum process sharing this
 * home could be writing a recent one.
 */
async function removeAbandonedPartials(reportsDir: string, nowMs: number): Promise<void> {
  for (const entry of await fs.readdir(reportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PARTIAL_DIR_PATTERN.test(entry.name)) continue;
    const entryPath = path.join(reportsDir, entry.name);
    try {
      const { mtimeMs } = await fs.stat(entryPath);
      if (nowMs - mtimeMs < PERF_REPORT_STALE_PARTIAL_MS) continue;
      await fs.rm(entryPath, { recursive: true, force: true });
    } catch (error) {
      log.warn("[perfReports] could not remove an abandoned partial report", {
        error: getErrorMessage(error),
      });
    }
  }
}

/** Total bytes of the regular files under `dir`. */
async function measureDir(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await measureDir(entryPath);
    else if (entry.isFile()) total += (await fs.stat(entryPath)).size;
  }
  return total;
}
