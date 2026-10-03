import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

type CaptureSkipReason = "size-cap" | "not-a-regular-file" | "missing" | "unreadable";

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

const REPORT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
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

// A URL token in a stack frame, with an optional `:line:col` suffix.
const STACK_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s()]+/g;
const LINE_COL_SUFFIX = /(?::\d+){1,2}$/;

/** The stack with every URL sanitized, or null when a URL cannot be parsed. */
function sanitizeStack(stack: string): string | null {
  let failed = false;
  const sanitized = stack.replace(STACK_URL_PATTERN, (token) => {
    const suffix = LINE_COL_SUFFIX.exec(token)?.[0] ?? "";
    const url = sanitizeUrl(token.slice(0, token.length - suffix.length));
    if (url === null) {
      failed = true;
      return "";
    }
    return url + suffix;
  });
  return failed ? null : sanitized.slice(0, PERF_REPORT_MAX_HANG_STACK_CHARS);
}

/**
 * Builds a new record from known fields only. A field that cannot be sanitized is
 * left out; an unknown collection error collapses to "error" (it may quote page data).
 */
function sanitizeHangRecord(record: PerfReportHangRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { at: record.at };
  if (typeof record.durationUntilResponsive === "number") {
    out.durationUntilResponsive = record.durationUntilResponsive;
  }
  const url = sanitizeUrl(record.url);
  if (url !== null) out.url = url;
  if (typeof record.stack === "string") {
    const stack = sanitizeStack(record.stack);
    if (stack !== null) out.stack = stack;
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
environment variables.

Files
-----
snapshot.json      The flight recorder snapshot: backend event-loop delay, event
                   loop utilization, GC and heap samples; renderer long animation
                   frames and slow input events; slow oRPC calls and WebSocket
                   flow-control waits ("rpc"); and recorder trips.
trace.json         The same timeline (plus CPU profile captures) as Chrome
                   trace-event JSON. Open it in https://ui.perfetto.dev or the
                   Chrome DevTools Performance panel ("Load profile").
                   Clock: ts/dur are microseconds on Xum's perf epoch (perf epoch
                   milliseconds * 1000), the same axis as snapshot.json and the
                   capture metadata (which use milliseconds).
captures/          The newest CPU profile captures (*.cpuprofile, open them in the
                   Chrome DevTools Performance panel) and their metadata (*.json).
                   manifest.json lists the captures included and the ones left out
                   and why. A capture triggered by a trip shows the activity AFTER
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
 * never reads session tapes, sessions, chat history or environment variables.
 */
export class PerfReportService {
  private readonly options: PerfReportServiceOptions;
  private readonly now: () => number;
  private readonly createId: () => string;
  private desktopHooks: PerfReportDesktopHooks | null = null;
  private inFlight = false;

  constructor(options: PerfReportServiceOptions) {
    this.options = options;
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
    const snapshot = this.options.recorder.getSnapshot();
    const status = this.options.recorder.getStatus();
    const hooks = this.desktopHooks;
    // Re-parsed here so a metadata object can never carry fields beyond the schema.
    const candidates = (await this.options.captures.listCaptures()).captures
      .slice(0, PERF_REPORT_MAX_CAPTURES)
      .map((capture) => PerfCaptureMetadataSchema.parse(capture));

    const fixedFiles = new Map<string, string>([
      ["snapshot.json", JSON.stringify(snapshot, null, 2)],
      ["trace.json", JSON.stringify(buildPerfTrace({ snapshot, captures: candidates }))],
      ["environment.json", JSON.stringify(this.environment(status, hooks !== null), null, 2)],
      ["README.txt", README],
    ]);
    if (hooks !== null) {
      fixedFiles.set(
        "hangs.json",
        JSON.stringify(hooks.getHangRecords().map(sanitizeHangRecord), null, 2)
      );
      fixedFiles.set("app-metrics.json", JSON.stringify(hooks.getAppMetrics() ?? null, null, 2));
    }
    let fixedBytes = Buffer.byteLength(
      renderManifest(
        [],
        candidates.map((metadata) => ({ metadata, reason: "size-cap" }))
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
    const skipped: SkippedCapture[] = [];
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
   * must be a regular file with a single link.
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

    let source: fs.FileHandle;
    try {
      // O_NOFOLLOW is undefined on Windows; there the isFile() check below still applies.
      source = await fs.open(
        path.join(this.options.capturesDir, profileName),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return { reason: "missing" };
      // ELOOP: the profile is a symlink.
      if (isErrnoWithCode(error, "ELOOP")) return { reason: "not-a-regular-file" };
      return { reason: "unreadable" };
    }
    const profilePath = path.join(outDir, profileName);
    let wrote = false;
    try {
      const stat = await source.stat();
      // A hard link could alias any file of this user; captures are written by rename.
      if (!stat.isFile() || stat.nlink > 1) return { reason: "not-a-regular-file" };
      if (metadataBytes + stat.size > budget) return { reason: "size-cap" };
      wrote = true;
      const copied = await copyBytes(source, profilePath, stat.size);
      await writeFileAtomic(metadataPath, metadataText, { mode: 0o600 });
      return { metadata, bytes: metadataBytes + copied, files: [metadataPath, profilePath] };
    } catch (error) {
      if (wrote) {
        await fs.rm(profilePath, { force: true });
        await fs.rm(metadataPath, { force: true });
      }
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

/** Copies at most `maxBytes` from `source` into a new private file; returns bytes written. */
async function copyBytes(
  source: fs.FileHandle,
  destPath: string,
  maxBytes: number
): Promise<number> {
  const dest = await fs.open(destPath, "wx", 0o600);
  try {
    const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(1, maxBytes)));
    let copied = 0;
    while (copied < maxBytes) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes - copied),
        copied
      );
      if (bytesRead === 0) break;
      await dest.write(buffer, 0, bytesRead);
      copied += bytesRead;
    }
    await dest.sync();
    return copied;
  } finally {
    await dest.close();
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
