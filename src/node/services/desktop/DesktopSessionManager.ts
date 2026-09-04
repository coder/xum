import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  DesktopActionResult,
  DesktopActionType,
  DesktopCapability,
  DesktopPrereqStatus,
  DesktopScreenshotResult,
} from "@/common/types/desktop";
import type { Config } from "@/node/config";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { log } from "@/node/services/log";
import assert from "node:assert/strict";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { DesktopInputCoordinator, UnsupportedDesktopRuntimeError } from "./DesktopInputCoordinator";
import {
  PortableDesktopBinaryNotFoundError,
  PortableDesktopSession,
} from "./PortableDesktopSession";

export class DesktopSessionManager {
  private readonly sessions = new Map<string, PortableDesktopSession>();
  private readonly startupPromises = new Map<string, Promise<PortableDesktopSession>>();
  private readonly inputCoordinator: DesktopInputCoordinator;
  private readonly closeListeners = new Set<(workspaceId: string | null) => void>();
  private workspaceArchiveGuard: ((workspaceId: string) => boolean) | undefined;

  /**
   * Archive admission pairing (mirrors TerminalService.setWorkspaceArchiveGuard): the guard
   * reports workspaces an agent-driven archive is currently gating, and ensureStarted checks it
   * in the same synchronous block that reserves the startup promise — an archive gate armed
   * first refuses the startup; a reservation registered first is observed by that gate via
   * has().
   */
  setWorkspaceArchiveGuard(guard: (workspaceId: string) => boolean): void {
    this.workspaceArchiveGuard = guard;
  }

  constructor(
    private readonly deps: {
      config: Config;
      experimentsService: ExperimentsService;
      workspaceService: WorkspaceService;
      inputCoordinator?: DesktopInputCoordinator;
    }
  ) {
    this.inputCoordinator = deps.inputCoordinator ?? new DesktopInputCoordinator(deps.config);
  }

  resolveTarget(workspaceId: string) {
    const target = this.inputCoordinator.resolveTarget(workspaceId);
    for (const id of new Set([workspaceId, target.ownerWorkspaceId])) {
      if (this.workspaceArchiveGuard?.(id) === true) {
        throw new Error(
          `Workspace is being archived or removed: ${id}. Wait for cleanup to finish.`
        );
      }
    }
    return target;
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

  getCapability(workspaceId: string): Promise<DesktopCapability> {
    return Promise.resolve().then(() => {
      if (!this.deps.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)) {
        return { available: false, reason: "disabled" };
      }

      let target;
      try {
        target = this.resolveTarget(workspaceId);
      } catch (error) {
        log.debug("PortableDesktop target unavailable", { workspaceId, error });
        return {
          available: false,
          reason:
            error instanceof UnsupportedDesktopRuntimeError
              ? "unsupported_runtime"
              : "startup_failed",
        };
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
        sessionId: `desktop:${target.ownerWorkspaceId}`,
        ...(target.ownerWorkspaceId !== workspaceId ? { sharedDesktop: target } : {}),
      };
    });
  }

  async ensureStarted(workspaceId: string): Promise<PortableDesktopSession> {
    const target = this.resolveTarget(workspaceId);
    // Reserve the owner startup synchronously with both archive guards; has() stays owner-keyed.
    const session = await this.ensureOwnerStarted(target.ownerWorkspaceId);
    // A requester may disappear/archive while joining somebody else's startup. Reject that
    // request without closing the owner's desktop, which other requesters can still use.
    if (this.resolveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
      throw new Error(`Desktop target changed while starting for workspace ${workspaceId}`);
    }
    return session;
  }

  private async ensureOwnerStarted(workspaceId: string): Promise<PortableDesktopSession> {
    this.resolveTarget(workspaceId);
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
        // A user archive can persist while startup awaits; never publish a hidden session.
        try {
          const target = this.resolveTarget(workspaceId);
          if (target.ownerWorkspaceId !== workspaceId) {
            throw new Error(`Desktop owner changed while starting: ${workspaceId}`);
          }
        } catch (error) {
          await session.close();
          throw error;
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
    const target = this.resolveTarget(workspaceId);
    const session = await this.ensureStarted(workspaceId);
    if (this.resolveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
      throw new Error(`Desktop target changed before screenshot for workspace ${workspaceId}`);
    }
    return session.screenshot();
  }

  async action(
    workspaceId: string,
    actionType: DesktopActionType,
    params: Record<string, unknown>
  ): Promise<DesktopActionResult> {
    const target = this.resolveTarget(workspaceId);
    const session = await this.ensureStarted(workspaceId);
    return this.inputCoordinator.withInput(workspaceId, () => {
      if (this.resolveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
        throw new Error(`Desktop target changed before input for workspace ${workspaceId}`);
      }
      return session.action(actionType, params);
    });
  }

  /** Whether a live desktop session exists for this workspace. */
  has(workspaceId: string): boolean {
    // Pending startups count as live activity: a user-initiated start that has not resolved
    // yet exists only in startupPromises, and archive refusal gates must observe it instead of
    // letting close() cancel it mid-startup. A session whose process exited or crashed is NOT
    // live activity, though — stale map entries linger until the next ensureStarted()/close()
    // touches them and must not hold the archive refusal gate open indefinitely.
    return (
      (this.sessions.get(workspaceId)?.isAlive() ?? false) || this.startupPromises.has(workspaceId)
    );
  }

  /** A null workspace ID revokes all viewers, including pending bridge connections. */
  onWorkspaceClose(listener: (workspaceId: string | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(workspaceId: string): Promise<void> {
    // A shared borrower has no owned session, but cleanup must still revoke its viewers.
    for (const listener of this.closeListeners) listener(workspaceId);
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
    for (const listener of this.closeListeners) listener(null);
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
  getLiveSessionConnection(workspaceId: string): {
    ownerWorkspaceId: string;
    sessionId: string;
    vncPort: number;
  } | null {
    let ownerWorkspaceId: string;
    try {
      ownerWorkspaceId = this.resolveTarget(workspaceId).ownerWorkspaceId;
    } catch (error) {
      log.debug("Desktop bridge target unavailable", { workspaceId, error });
      return null;
    }
    const session = this.sessions.get(ownerWorkspaceId);
    if (!session?.isAlive()) {
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
      ownerWorkspaceId,
      sessionId: sessionInfo.sessionId ?? `desktop:${ownerWorkspaceId}`,
      vncPort: sessionInfo.vncPort,
    };
  }
}
