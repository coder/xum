import assert from "node:assert/strict";

import type { APIClient } from "@/browser/contexts/API";

type Namespace = keyof APIClient;
type Method<N extends Namespace> = keyof APIClient[N] & string;
type Procedure<N extends Namespace, M extends Method<N>> = APIClient[N][M] extends (
  input: infer I,
  ...rest: infer R
) => Promise<infer O>
  ? (input: I, ...rest: R) => Promise<O>
  : never;
type Input<N extends Namespace, M extends Method<N>> = Parameters<Procedure<N, M>>[0];

export interface ApiCallTracker {
  /** Wrap the client the app renders with; the tracker sees only calls through the wrapper. */
  wrap: (client: APIClient) => APIClient;
  /** Resolves when every matching call the app has made so far has settled (asserts one exists). */
  settled: () => Promise<void>;
  /** Resolves when the next matching call the app makes, after this call, has settled. */
  nextSettled: () => Promise<void>;
}

/**
 * Track the app's calls to one API method so a test can await them (#6143).
 *
 * Polling the DOM for data that a backend call loads races that call: waitFor's 1 s default
 * expired while the call was still in flight under CI load. Awaiting the call itself is the
 * ready signal, so only the React commit after it is left to waitFor.
 */
export function trackApiCalls<N extends Namespace, M extends Method<N>>(
  namespace: N,
  method: M,
  matches: (input: Input<N, M>) => boolean = () => true
): ApiCallTracker {
  const calls: Promise<void>[] = [];
  const waiters: (() => void)[] = [];
  let wrapped = false;
  return {
    wrap: (client) => {
      // Two wrapped clients would split the calls between trackers the test cannot tell apart.
      assert(!wrapped, "an ApiCallTracker wraps one client");
      wrapped = true;
      const target = client[namespace];
      const real = Reflect.get(target, method) as (...args: unknown[]) => Promise<unknown>;
      assert.equal(typeof real, "function", `${namespace}.${method} is not an API procedure`);
      const tracked = (...args: unknown[]): Promise<unknown> => {
        const call = real.apply(target, args);
        if (matches(args[0] as Input<N, M>)) {
          // Settled, not resolved: a failed call still ends the wait; the app shows its fallback.
          const done = call.then(
            () => undefined,
            () => undefined
          );
          calls.push(done);
          for (const waiter of waiters.splice(0)) void done.then(waiter);
        }
        return call;
      };
      const wrappedNamespace = new Proxy(target, {
        get: (obj, prop, receiver) =>
          prop === method ? tracked : (Reflect.get(obj, prop, receiver) as unknown),
      });
      return new Proxy(client, {
        get: (obj, prop, receiver) =>
          prop === namespace ? wrappedNamespace : (Reflect.get(obj, prop, receiver) as unknown),
      });
    },
    settled: async () => {
      assert(calls.length > 0, `the app has not called ${namespace}.${method} yet`);
      // A call that starts while earlier ones settle (a refetch) is awaited too.
      let awaited = 0;
      while (awaited < calls.length) {
        const batch = calls.slice(awaited);
        awaited = calls.length;
        await Promise.all(batch);
      }
    },
    nextSettled: () => {
      assert(wrapped, "wrap the app's client before waiting for its calls");
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
