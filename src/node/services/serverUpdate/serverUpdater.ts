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
  private stagedBin: string | null = null;
  private installing = false;

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
    this.stagedBin = null;
    this.setStatus({ type: "idle" });
  }

  async checkForUpdates(options?: { source?: "auto" | "manual" }): Promise<void> {
    if (
      !this.layout ||
      this.installing ||
      this.status.type === "checking" ||
      this.status.type === "downloading" ||
      this.stagedBin
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
      this.stagedBin ||
      this.installing ||
      this.status.type === "checking" ||
      this.status.type === "downloading"
    )
      return;
    this.setStatus({ type: "downloading", percent: null });
    try {
      this.stagedBin = await (this.deps.runInstall ?? stageUpdate)(
        this.layout,
        this.availableVersion
      );
      this.setStatus({ type: "downloaded", info: { version: this.availableVersion } });
    } catch (error) {
      this.setStatus({ type: "error", phase: "download", message: getErrorMessage(error) });
    }
  }

  async installUpdate(): Promise<void> {
    if (!this.layout || !this.stagedBin || !this.availableVersion || this.installing) return;
    try {
      const blockers = this.deps.collectBlockers();
      if (blockers.length) {
        this.setStatus({
          type: "install-blocked",
          info: { version: this.availableVersion },
          blockers,
        });
        return;
      }
      // No await between the idle snapshot, atomic swap, and the CLI's shutdown latch.
      (this.deps.activate ?? activateUpdate)(this.layout, this.stagedBin);
      this.installing = true;
      await this.deps.restart();
    } catch (error) {
      this.setStatus({ type: "error", phase: "install", message: getErrorMessage(error) });
    }
  }
}
