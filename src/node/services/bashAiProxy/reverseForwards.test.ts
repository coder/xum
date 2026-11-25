import { describe, expect, test } from "bun:test";

import type { ReverseForward } from "@/node/runtime/transports";

import { ReverseForwardManager, type ForwardTarget } from "./reverseForwards";
import { candidatePorts } from "./stableIdentity";

const SEED = "/xum-root";
const HOST = "ssh-host";
const LOCAL_PORT = 1234;
// A clock the test moves: the manager waits and re-probes by this time, not by the wall clock.
const POLL_MS = 500;
const ADOPTED_TRUST_MS = 60_000;

/**
 * A host where `live` is the set of remote ports that reach the proxy. Opening a forward makes
 * its port live, unless `openedForwardsReach` is false (a forward that comes up but is not the
 * proxy). The probe answers like the proxy does, for a live port only.
 */
function fakeHost(options: { openedForwardsReach?: boolean } = {}) {
  const live = new Set<number>();
  const opened: number[] = [];
  const closedPorts: number[] = [];
  let probes = 0;
  const target: ForwardTarget = {
    hostKey: HOST,
    restoreAtStartup: true,
    openReverseForward: (remotePort): Promise<ReverseForward> => {
      opened.push(remotePort);
      if (options.openedForwardsReach !== false) live.add(remotePort);
      return Promise.resolve({
        closed: new Promise<void>(() => undefined),
        close: () => closedPorts.push(remotePort),
      } satisfies ReverseForward);
    },
    remoteHealth: (remotePort, nonce) => {
      probes++;
      return Promise.resolve(live.has(remotePort) ? `answer:${nonce}` : undefined);
    },
  };
  return { target, live, opened, closedPorts, probes: () => probes };
}

function managerFor(saved: number | undefined) {
  let clock = 0;
  const manager = new ReverseForwardManager({
    seed: SEED,
    expectedHealth: (nonce) => `answer:${nonce}`,
    savedRemotePort: () => saved,
    onEstablished: () => undefined,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  return { manager, advance: (ms: number) => (clock += ms) };
}

describe("ReverseForwardManager", () => {
  test("a saved remote port that is gone comes back before any hashed candidate", async () => {
    // Commands started before a restart hold the saved port in their env.
    const hashed = candidatePorts(`${SEED}\0${HOST}`, 4);
    const saved = hashed[0] + 1;
    expect(hashed).not.toContain(saved);
    const host = fakeHost();
    const { manager } = managerFor(saved);

    expect(await manager.ensure(host.target, LOCAL_PORT, Infinity)).toBe(saved);
    expect(host.opened).toEqual([saved]);
  });

  test("a forward counts as up only after the proxy answers through it", async () => {
    const host = fakeHost({ openedForwardsReach: false }); // up, but not the proxy
    const { manager } = managerFor(undefined);

    expect(await manager.ensure(host.target, LOCAL_PORT, Infinity)).toBeUndefined();
    expect(host.probes()).toBeGreaterThan(0);
    // Every forward that came up without the proxy behind it was closed again.
    expect(host.closedPorts).toEqual(host.opened);
  });

  test("an adopted forward is trusted for a minute, then probed again", async () => {
    const saved = 23456;
    const host = fakeHost();
    host.live.add(saved); // a forward that outlived a restart
    const { manager, advance } = managerFor(saved);

    expect(await manager.ensure(host.target, LOCAL_PORT, Infinity)).toBe(saved);
    const probesAtAdoption = host.probes();
    expect(host.opened).toEqual([]);

    advance(ADOPTED_TRUST_MS - POLL_MS);
    expect(await manager.ensure(host.target, LOCAL_PORT, Infinity)).toBe(saved);
    expect(host.probes()).toBe(probesAtAdoption); // not probed on every turn

    // The surviving forward is gone by the time its trust runs out: the next turn finds out.
    host.live.delete(saved);
    advance(2 * POLL_MS);
    expect(await manager.ensure(host.target, LOCAL_PORT, Infinity)).toBe(saved);
    expect(host.opened).toEqual([saved]); // opened again, not trusted blindly
  });
});
