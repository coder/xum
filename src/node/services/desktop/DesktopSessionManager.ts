import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  DesktopActionResult,
  DesktopActionType,
  DesktopCapability,
  DesktopPrereqStatus,
  DesktopScreenshotResult,
} from "@/common/types/desktop";
import { parseRuntimeModeAndHost } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { log } from "@/node/services/log";
import assert from "node:assert/strict";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  PortableDesktopBinaryNotFoundError,
  PortableDesktopSession,
} from "./PortableDesktopSession";

export class DesktopSessionManager {
  private readonly sessions = new Map<string, PortableDesktopSession>();
  private readonly startupPromises = new Map<string, Promise<PortableDesktopSession>>();

  constructor(
    private readonly deps: {
      config: Config;
      experimentsService: ExperimentsService;
      workspaceService: WorkspaceService;
    }
  ) {}

  private parseWorkspaceRuntime(metadata: FrontendWorkspaceMetadata) {
    const runtimeConfig = metadata.runtimeConfig;

    switch (runtimeConfig.type) {
      case "local":
        return parseRuntimeModeAndHost("srcBaseDir" in runtimeConfig ? "worktree" : "local");
      case "worktree":
        return parseRuntimeModeAndHost("worktree");
      case "ssh":
        return parseRuntimeModeAndHost(`ssh ${runtimeConfig.host}`);
      case "docker":
        return parseRuntimeModeAndHost(`docker ${runtimeConfig.image}`);
      case "devcontainer":
        return parseRuntimeModeAndHost(
          runtimeConfig.configPath.length > 0
            ? `devcontainer ${runtimeConfig.configPath}`
            : "devcontainer"
        );
    }
  }

  getPrereqStatus(): DesktopPrereqStatus {
    assert(
      this.deps.config.rootDir.length > 0,
      "DesktopSessionManager requires a non-empty rootDir"
    );

    if (!["linux", "darwin", "win32"].includes(process.platform)) {
      return { available: false, reason: "unsupported_platform" };
    }

    try {
      if (!PortableDesktopSession.checkAvailability(this.deps.config.rootDir)) {
        return { available: false, reason: "binary_not_found" };
      }

      return { available: true };
    } catch (error) {
      log.error("PortableDesktop prerequisite check failed during availability check", {
        error,
      });
      if (error instanceof PortableDesktopBinaryNotFoundError) {
        return { available: false, reason: "binary_not_found" };
      }
      return { available: false, reason: "startup_failed" };
    }
  }

  async getCapability(workspaceId: string): Promise<DesktopCapability> {
    if (!this.deps.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)) {
      return { available: false, reason: "disabled" };
    }

    const workspaceInfo = await this.deps.workspaceService.getInfo(workspaceId);
    if (!workspaceInfo) {
      log.error("PortableDesktop capability check failed because workspace metadata was missing", {
        workspaceId,
      });
      return { available: false, reason: "startup_failed" };
    }

    const parsedRuntime = this.parseWorkspaceRuntime(workspaceInfo);
    if (
      parsedRuntime?.mode === "ssh" ||
      parsedRuntime?.mode === "docker" ||
      parsedRuntime?.mode === "devcontainer"
    ) {
      return { available: false, reason: "unsupported_runtime" };
    }

    const prereqStatus = this.getPrereqStatus();
    if (!prereqStatus.available) {
      return prereqStatus;
    }

    // Capability checks are used for agent listing and tool gating, so they must not
    // start a long-lived desktop session just to report whether PortableDesktop exists.
    return {
      available: true,
      width: DESKTOP_DEFAULTS.WIDTH,
      height: DESKTOP_DEFAULTS.HEIGHT,
      sessionId: `desktop:${workspaceId}`,
    };
  }

  async ensureStarted(workspaceId: string): Promise<PortableDesktopSession> {
    // Archived workspaces must not accrue hidden live activity: archive stops desktop
    // sessions, so admitting a new one afterwards would leave one running in a workspace
    // the UI no longer surfaces. Unarchive first.
    const workspaceEntry = findWorkspaceEntry(this.deps.config.loadConfigOrDefault(), workspaceId);
    if (
      workspaceEntry != null &&
      isWorkspaceArchived(
        workspaceEntry.workspace.archivedAt,
        workspaceEntry.workspace.unarchivedAt
      )
    ) {
      throw new Error(
        `Workspace is archived: ${workspaceId}. Unarchive it before starting a desktop session.`
      );
    }

    const existingSession = this.sessions.get(workspaceId);
    if (existingSession?.isAlive()) {
      return existingSession;
    }

    const existingStartup = this.startupPromises.get(workspaceId);
    if (existingStartup) {
      return existingStartup;
    }

    if (existingSession) {
      this.sessions.delete(workspaceId);
    }

    const session = new PortableDesktopSession({
      workspaceId,
      rootDir: this.deps.config.rootDir,
      width: DESKTOP_DEFAULTS.WIDTH,
      height: DESKTOP_DEFAULTS.HEIGHT,
    });

    let startupPromise: Promise<PortableDesktopSession> | null = null;
    const isCurrentStartupPromise = (): boolean =>
      startupPromise !== null && this.startupPromises.get(workspaceId) === startupPromise;

    startupPromise = (async (): Promise<PortableDesktopSession> => {
      try {
        await session.start();
        if (!isCurrentStartupPromise()) {
          await session.close();
          throw new Error(`PortableDesktop startup for workspace ${workspaceId} was superseded`);
        }
        this.sessions.set(workspaceId, session);
        return session;
      } catch (error) {
        this.sessions.delete(workspaceId);
        if (isCurrentStartupPromise()) {
          this.startupPromises.delete(workspaceId);
        }
        throw error;
      } finally {
        if (isCurrentStartupPromise()) {
          this.startupPromises.delete(workspaceId);
        }
      }
    })();

    this.startupPromises.set(workspaceId, startupPromise);
    return startupPromise;
  }

  async screenshot(workspaceId: string): Promise<DesktopScreenshotResult> {
    const session = await this.ensureStarted(workspaceId);
    return session.screenshot();
  }

  async action(
    workspaceId: string,
    actionType: DesktopActionType,
    params: Record<string, unknown>
  ): Promise<DesktopActionResult> {
    const session = await this.ensureStarted(workspaceId);
    return session.action(actionType, params);
  }

  /** Whether a live desktop session exists for this workspace. */
  has(workspaceId: string): boolean {
    // Pending startups count as live activity: a user-initiated start that has not resolved
    // yet exists only in startupPromises, and archive refusal gates must observe it instead of
    // letting close() cancel it mid-startup.
    return this.sessions.has(workspaceId) || this.startupPromises.has(workspaceId);
  }

  async close(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId);
    const startupPromise = this.startupPromises.get(workspaceId);

    try {
      this.sessions.delete(workspaceId);
      this.startupPromises.delete(workspaceId);

      const closeOperations: Array<Promise<unknown>> = [];
      if (session) {
        closeOperations.push(session.close());
      }
      if (startupPromise) {
        closeOperations.push(
          startupPromise.then((startedSession) => startedSession.close()).catch(() => undefined)
        );
      }
      await Promise.allSettled(closeOperations);
    } finally {
      this.sessions.delete(workspaceId);
      this.startupPromises.delete(workspaceId);
    }
  }

  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    const startupPromises = Array.from(this.startupPromises.values());

    this.sessions.clear();
    this.startupPromises.clear();

    await Promise.allSettled([
      ...sessions.map(async (session) => session.close()),
      ...startupPromises.map(async (startupPromise) => {
        await startupPromise.then((session) => session.close()).catch(() => undefined);
      }),
    ]);
  }

  /**
   * Returns VNC connection info for an already-started session.
   * Returns null if no live session exists for the workspace.
   * Used by DesktopBridgeServer to resolve token→VNC-port mappings.
   */
  getLiveSessionConnection(workspaceId: string): { sessionId: string; vncPort: number } | null {
    const session = this.sessions.get(workspaceId);
    if (!session) {
      return null;
    }

    const sessionInfo = session.getSessionInfo();
    if (!sessionInfo.vncPort || sessionInfo.vncPort <= 0) {
      log.warn("PortableDesktop session exists but VNC port is invalid", {
        workspaceId,
        vncPort: sessionInfo.vncPort,
      });
      return null;
    }

    return {
      sessionId: sessionInfo.sessionId ?? `desktop:${workspaceId}`,
      vncPort: sessionInfo.vncPort,
    };
  }
}
