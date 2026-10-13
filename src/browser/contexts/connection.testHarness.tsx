import { act } from "@testing-library/react";
import type { ClientContext, ClientLink } from "@orpc/client";
import { useState, type ReactNode } from "react";
import { APIContext, type APIClient, type UseAPIResult } from "@/browser/contexts/API";
import { ConnectionLink } from "@/browser/contexts/connectionLink";
import type { TestApiOverrides } from "@/browser/testUtils";
import { createClient } from "@/common/orpc/client";

/**
 * How the API context looks while Xum reconnects.
 * - `null-gap` (the provider today): `api` goes from a client to `null`, then to a new client.
 * - `kept-gap` (the provider after the switch): `api` stays the last client with status
 *   "reconnecting"; its calls reject with ConnectionLostError. Then a new client arrives.
 *
 * Code that passes in both modes is safe today and cannot break when the provider switches.
 */
export type GapMode = "null-gap" | "kept-gap";
export const GAP_MODES: readonly GapMode[] = ["null-gap", "kept-gap"];

type Procedure = (input: unknown, options: unknown) => unknown;

/** An inner link that runs each call on the matching function of a test override object. */
function overridesLink(overrides: TestApiOverrides<APIClient>): ClientLink<ClientContext> {
  return {
    // A then() so a missing override or a throwing one rejects, as a real call does.
    call: (path, input, options) =>
      Promise.resolve().then(() => {
        let node: unknown = overrides;
        for (const key of path) node = (node as Record<string, unknown> | undefined)?.[key];
        if (typeof node !== "function") {
          throw new Error(`No test override for ${path.join(".")}`);
        }
        return (node as Procedure)(input, { signal: options.signal, context: options.context });
      }),
  };
}

const noop = () => undefined;

function connected(api: APIClient): UseAPIResult {
  return { status: "connected", api, error: null, authenticate: noop, retry: noop };
}

/**
 * A connection the test drops and restores. Each connect builds a real oRPC client over one
 * ConnectionLink, as the provider will, from fresh overrides (`makeOverrides()`), so a test can
 * make the next server answer differently.
 *
 * The drop keeps the real order of each mode. Today the provider's state change renders first
 * (React handles a socket `close` event as discrete) and the transport rejects the streams after.
 * After the switch, the provider detaches the link first, so calls reject before React renders.
 */
export function createConnectionHarness(
  mode: GapMode,
  makeOverrides: () => TestApiOverrides<APIClient>
) {
  const link = new ConnectionLink();
  let client: APIClient | null = null;
  let publish: ((value: UseAPIResult) => void) | null = null;
  // The value a Wrapper mounted now starts with (a panel reopened after a tab switch).
  let latest: UseAPIResult;
  let attempt = 0;

  const connect = (): UseAPIResult => {
    link.attach(overridesLink(makeOverrides()));
    client = createClient(link);
    return connected(client);
  };
  latest = connect();

  const setValue = (value: UseAPIResult) => {
    latest = value;
    if (publish != null) act(() => publish?.(value));
  };

  function Wrapper(props: { children: ReactNode }) {
    const [value, setValue] = useState<UseAPIResult>(() => latest);
    publish = setValue;
    return <APIContext.Provider value={value}>{props.children}</APIContext.Provider>;
  }

  return {
    mode,
    Wrapper,
    /** The client of the current (or last) connection. */
    get client(): APIClient | null {
      return client;
    },
    /** Lose the connection. In-flight calls and streams reject with ConnectionLostError. */
    async drop(): Promise<void> {
      attempt += 1;
      const reconnecting = (api: APIClient | null): UseAPIResult => ({
        status: "reconnecting",
        api,
        error: null,
        attempt,
        authenticate: noop,
        retry: noop,
      });
      if (mode === "null-gap") {
        setValue(reconnecting(null));
        link.detach();
      } else {
        link.detach();
        await act(async () => {
          // Let the rejections reach their handlers before React sees the drop. A macrotask runs
          // only after every queued microtask, however long each rejection chain is.
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        setValue(reconnecting(client));
      }
    },
    /** Connect again: a new client object, as after a real reconnect. */
    reconnect(): void {
      setValue(connect());
    },
  };
}

export type ConnectionHarness = ReturnType<typeof createConnectionHarness>;
