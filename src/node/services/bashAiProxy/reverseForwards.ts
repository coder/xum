/**
 * Reverse forwards that let bash commands on SSH and Coder hosts reach the bash AI proxy.
 *
 * One forward per SSH host (all workspaces on a host share it; the key names the workspace):
 * the host's 127.0.0.1:R connects to the proxy on the backend's 127.0.0.1. A forward counts as up
 * only after the proxy's health token comes back through it from the remote host, so a refused
 * forward, a busy port or a stranger's listener on R never gets the env vars.
 *
 * R is restart-stable like the listener port: the saved port first, then candidates hashed from
 * the Xum root and the host. A forward that outlived a restart (an ssh process left behind) and
 * still reaches a proxy of this root is adopted instead of replaced.
 */
import { log } from "@/node/services/log";
import type { ReverseForward } from "@/node/runtime/transports";

import { candidatePorts, newHealthNonce } from "./stableIdentity";

/** What the manager needs from an SSH runtime. */
export interface ForwardTarget {
  /** Stable per host, port and identity. */
  hostKey: string;
  /** False for Coder: connecting at startup can start a stopped (billed) workspace. */
  restoreAtStartup: boolean;
  openReverseForward(remotePort: number, localPort: number): Promise<ReverseForward>;
  /** Body of the proxy health endpoint for `nonce`, fetched on the host via 127.0.0.1:remotePort. */
  remoteHealth(remotePort: number, nonce: string): Promise<string | undefined>;
}

export interface ReverseForwardManagerOptions {
  /** Seeds the remote port candidates (the Xum root dir). */
  seed: string;
  /** The proxy's answer to a health challenge (stableIdentity.healthAnswer). */
  expectedHealth: (nonce: string) => string;
  savedRemotePort: (hostKey: string) => number | undefined;
  onEstablished: (hostKey: string, remotePort: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const REMOTE_PORT_CANDIDATES = 4;
/** How long a new forward gets to answer the health probe (Coder hosts connect slowly). */
const ESTABLISH_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 500;
/** A host that refused every candidate is not retried on every turn. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** An adopted forward (not ours) is probed again after this long. */
const REVERIFY_ADOPTED_MS = 60_000;

interface HostState {
  remotePort?: number;
  /** Set when this process owns the forward; undefined for an adopted one. */
  owned?: ReverseForward;
  ownedClosed?: boolean;
  verifiedAt?: number;
  failedAt?: number;
  establishing?: Promise<number | undefined>;
}

export class ReverseForwardManager {
  private readonly hosts = new Map<string, HostState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private closed = false;

  constructor(private readonly options: ReverseForwardManagerOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  }

  /**
   * The remote port that reaches the proxy on `localPort`, or undefined when the host has none
   * yet. Waits at most `waitMs`; a slower setup keeps going and serves the next call.
   */
  async ensure(
    target: ForwardTarget,
    localPort: number,
    waitMs: number
  ): Promise<number | undefined> {
    if (this.closed) return undefined;
    let state = this.hosts.get(target.hostKey);
    if (!state) {
      state = {};
      this.hosts.set(target.hostKey, state);
    }
    if (this.isUp(state)) return state.remotePort;
    if (state.failedAt !== undefined && this.now() - state.failedAt < RETRY_AFTER_FAILURE_MS) {
      return undefined;
    }
    // Only the call that starts a setup waits for it: later turns on the host must not each
    // stall for the wait while a slow setup is still running.
    if (state.establishing) return waitMs === Infinity ? state.establishing : undefined;
    const host = state;
    host.establishing = this.establish(target, localPort, host).finally(() => {
      host.establishing = undefined;
    });
    return waitMs === Infinity ? host.establishing : raceTimeout(host.establishing, waitMs);
  }

  /** Closes the forwards this process owns; later ensure() calls open them again. */
  closeOwned(): void {
    for (const [hostKey, state] of this.hosts) {
      if (state.establishing) continue; // it ends on its own; ensure() sees the result
      state.owned?.close();
      this.hosts.delete(hostKey);
    }
  }

  closeAll(): void {
    this.closed = true;
    for (const state of this.hosts.values()) state.owned?.close();
    this.hosts.clear();
  }

  private isUp(state: HostState): boolean {
    if (state.remotePort === undefined || state.verifiedAt === undefined) return false;
    if (state.owned) return state.ownedClosed !== true;
    return this.now() - state.verifiedAt < REVERIFY_ADOPTED_MS;
  }

  private async healthy(target: ForwardTarget, remotePort: number): Promise<boolean> {
    try {
      const nonce = newHealthNonce();
      const body = await target.remoteHealth(remotePort, nonce);
      return body?.includes(this.options.expectedHealth(nonce)) === true;
    } catch {
      return false;
    }
  }

  private async establish(
    target: ForwardTarget,
    localPort: number,
    state: HostState
  ): Promise<number | undefined> {
    const saved = this.options.savedRemotePort(target.hostKey);
    // Adopt a forward that still reaches this root's proxy (for example from before a restart).
    if (saved !== undefined && (await this.healthy(target, saved))) {
      return this.markUp(target, state, saved, undefined);
    }
    const seeded = candidatePorts(
      `${this.options.seed}\0${target.hostKey}`,
      REMOTE_PORT_CANDIDATES
    );
    const candidates = [...new Set([...(saved !== undefined ? [saved] : []), ...seeded])];
    for (const remotePort of candidates) {
      if (this.closed) return undefined;
      let forward: ReverseForward;
      try {
        forward = await target.openReverseForward(remotePort, localPort);
      } catch (error) {
        log.debug("[bash-ai-proxy] reverse forward refused", {
          host: target.hostKey,
          remotePort,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (await this.waitHealthy(target, remotePort, forward)) {
        return this.markUp(target, state, remotePort, forward);
      }
      forward.close();
    }
    state.failedAt = this.now();
    log.warn(
      "[bash-ai-proxy] no reverse forward to this SSH host; its bash AI calls stay uncounted",
      {
        host: target.hostKey,
      }
    );
    return undefined;
  }

  /** Polls the health probe until it passes, the forward ends, or the deadline passes. */
  private async waitHealthy(
    target: ForwardTarget,
    remotePort: number,
    forward: ReverseForward
  ): Promise<boolean> {
    let ended = false;
    void forward.closed.then(() => (ended = true));
    const deadline = this.now() + ESTABLISH_TIMEOUT_MS;
    while (!ended && !this.closed && this.now() < deadline) {
      if (await this.healthy(target, remotePort)) return !ended;
      await this.sleep(PROBE_INTERVAL_MS);
    }
    return false;
  }

  private markUp(
    target: ForwardTarget,
    state: HostState,
    remotePort: number,
    owned: ReverseForward | undefined
  ): number {
    if (this.closed) {
      owned?.close();
      return remotePort;
    }
    state.remotePort = remotePort;
    state.owned = owned;
    state.ownedClosed = false;
    state.verifiedAt = this.now();
    state.failedAt = undefined;
    if (owned) {
      void owned.closed.then(() => {
        // The next ensure() re-establishes it (the SSH connection dropped, the host restarted).
        if (state.owned === owned) state.ownedClosed = true;
      });
    }
    this.options.onEstablished(target.hostKey, remotePort);
    return remotePort;
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}
