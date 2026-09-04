import { getErrorMessage } from "@/common/utils/errors";
import type { RestartBlocker, UpdateStatus } from "@/common/orpc/types";
import type { UpdateChannel } from "@/common/types/project";
import { log } from "@/node/services/log";
import { activateUpdate } from "./activation";
import {
  inferChannel,
  isExactVersion,
  type InstallLayout,
  type LayoutResult,
} from "./installLayout";
import { fetchDistTags } from "./registry";
import { stageUpdate } from "./staging";

export interface ServerUpdaterDeps {
  /** Refreshes lazily updated blocker sources; the snapshot that follows stays synchronous. */
  refreshBlockers?: () => Promise<void>;
  collectBlockers: () => RestartBlocker[];
  restart: () => Promise<void>;
  fetchDistTags?: typeof fetchDistTags;
  runInstall?: typeof stageUpdate;
  activate?: typeof activateUpdate;
}

export class ServerUpdater {
  private status: UpdateStatus;
  private channel: UpdateChannel;
  private readonly layout: InstallLayout | null;
  private readonly subscribers = new Set<(status: UpdateStatus) => void>();
  private availableVersion: string | null = null;
  private stagedEntry: string | null = null;
  private installing = false;
  private download: { abort: AbortController; settled: Promise<void> } | null = null;

  constructor(
    result: LayoutResult,
    channel: UpdateChannel | undefined,
    private readonly deps: ServerUpdaterDeps
  ) {
    this.layout = result.supported ? result.layout : null;
    this.channel = channel ?? inferChannel(this.layout?.version ?? "");
    this.status = result.supported
      ? { type: "idle" }
      : { type: "unsupported", reason: result.reason };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }
  getChannel(): UpdateChannel {
    return this.channel;
  }

  subscribe(callback: (status: UpdateStatus) => void): () => void {
    this.subscribers.add(callback);
    callback(this.status);
    return () => this.subscribers.delete(callback);
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    for (const callback of this.subscribers) {
      try {
        callback(status);
      } catch (error) {
        log.error("Server update subscriber failed", error);
      }
    }
  }

  setChannel(channel: UpdateChannel): void {
    if (!this.layout || channel === this.channel) return;
    if (this.installing || this.status.type === "checking" || this.status.type === "downloading")
      throw new Error("An update operation is in progress");
    this.channel = channel;
    this.availableVersion = null;
    this.stagedEntry = null;
    this.setStatus({ type: "idle" });
  }

  async checkForUpdates(options?: { source?: "auto" | "manual" }): Promise<void> {
    if (
      !this.layout ||
      this.installing ||
      this.status.type === "checking" ||
      this.status.type === "downloading" ||
      this.stagedEntry
    )
      return;
    const previous = this.status;
    this.setStatus({ type: "checking" });
    try {
      const tags = await (this.deps.fetchDistTags ?? fetchDistTags)(this.layout.registry);
      const version = tags[this.channel === "stable" ? "latest" : "next"];
      if (!isExactVersion(version))
        throw new Error("Registry has no valid version for the selected channel");
      this.availableVersion = version === this.layout.version ? null : version;
      this.setStatus(
        this.availableVersion ? { type: "available", info: { version } } : { type: "up-to-date" }
      );
    } catch (error) {
      this.setStatus(
        options?.source === "auto"
          ? previous
          : { type: "error", phase: "check", message: getErrorMessage(error) }
      );
    }
  }

  async downloadUpdate(): Promise<void> {
    if (
      !this.layout ||
      !this.availableVersion ||
      this.stagedEntry ||
      this.installing ||
      this.status.type === "checking" ||
      this.status.type === "downloading"
    )
      return;
    this.setStatus({ type: "downloading", percent: null });
    const abort = new AbortController();
    const download = {
      abort,
      settled: this.stage(this.layout, this.availableVersion, abort.signal),
    };
    this.download = download;
    await download.settled;
    if (this.download === download) this.download = null;
  }

  private async stage(layout: InstallLayout, version: string, signal: AbortSignal): Promise<void> {
    try {
      this.stagedEntry = await (this.deps.runInstall ?? stageUpdate)(
        layout,
        version,
        undefined,
        signal
      );
      this.setStatus({ type: "downloaded", info: { version } });
    } catch (error) {
      this.setStatus({ type: "error", phase: "download", message: getErrorMessage(error) });
    }
  }

  /** A detached package manager must not outlive the server and keep writing into the stage. */
  async beginShutdown(): Promise<void> {
    this.download?.abort.abort();
    await this.download?.settled;
  }

  async installUpdate(): Promise<void> {
    if (!this.layout || !this.stagedEntry || !this.availableVersion || this.installing) return;
    this.installing = true;
    try {
      await this.deps.refreshBlockers?.();
      const blockers = this.deps.collectBlockers();
      if (blockers.length) {
        this.installing = false;
        this.setStatus({
          type: "install-blocked",
          info: { version: this.availableVersion },
          blockers,
        });
        return;
      }
      // No await between the idle snapshot, atomic swap, and the CLI's shutdown latch.
      (this.deps.activate ?? activateUpdate)(this.layout, this.stagedEntry);
      await this.deps.restart();
    } catch (error) {
      this.installing = false;
      this.setStatus({ type: "error", phase: "install", message: getErrorMessage(error) });
    }
  }
}
