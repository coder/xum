// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { ServerAuthSession, ApiServerStatus } from "@/common/orpc/types";
import { ServerAccessSection } from "./ServerAccessSection";

function session(id: string, label: string): ServerAuthSession {
  return { id, label, createdAtMs: 1, lastUsedAtMs: 1, isCurrent: false };
}

let harness: ConnectionHarness;
/** The sessions the next server lists, or a promise of them. */
let serverSessions: ServerAuthSession[] | Promise<ServerAuthSession[]>;

// The session list must stay on screen while offline and while the new client reloads it:
// "Loading sessions..." only replaces an empty list.
describe.each([...GAP_MODES])("ServerAccessSection across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverSessions = [session("s1", "Laptop")];
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const sessions = serverSessions;
      return { serverAuth: { listSessions: () => Promise.resolve(sessions) } };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the listed sessions until the reload answers", async () => {
    const view = render(
      <harness.Wrapper>
        <ServerAccessSection />
      </harness.Wrapper>
    );
    await view.findByText("Laptop");

    let answer: ((sessions: ServerAuthSession[]) => void) | null = null;
    serverSessions = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    expect(view.queryByText("Laptop")).not.toBeNull();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.queryByText("Laptop")).not.toBeNull();
    expect(view.queryByText("Loading sessions...")).toBeNull();

    act(() => answer?.([session("s2", "Phone")]));
    await view.findByText("Phone");
    await waitFor(() => expect(view.queryByText("Laptop") === null).toBe(true));
  });

  // A revoke offline cannot reach the server: the kept rows must not offer it.
  test("disables the session actions while offline", async () => {
    const view = render(
      <harness.Wrapper>
        <ServerAccessSection />
      </harness.Wrapper>
    );
    const revoke = (await view.findByRole("button", { name: "Revoke" })) as HTMLButtonElement;
    const refresh = view.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    expect(revoke.disabled).toBe(false);

    await harness.drop();
    expect(view.queryByText("Laptop")).not.toBeNull();
    expect(revoke.disabled).toBe(true);
    expect(refresh.disabled).toBe(true);

    harness.reconnect();
    await waitFor(() => expect(revoke.disabled).toBe(false));
  });
});

// A server cancel on a live socket is a plain AbortError. It is a real failure: no reconnect
// comes to reload, so swallowing it would leave the section stuck on stale or no sessions.
describe("ServerAccessSection on a server cancel", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("reports the cancel while connected", async () => {
    harness = createConnectionHarness(
      "kept-gap",
      (): TestApiOverrides<APIClient> => ({
        serverAuth: {
          listSessions: () => Promise.reject(new DOMException("Request cancelled", "AbortError")),
        },
      })
    );
    const view = render(
      <harness.Wrapper>
        <ServerAccessSection />
      </harness.Wrapper>
    );

    await view.findByText("Request cancelled");
    expect(view.queryByText("Loading sessions...")).toBeNull();
  });
});

const RUNNING_STATUS: ApiServerStatus = {
  running: true,
  baseUrl: "http://127.0.0.1:8462",
  bindHost: "0.0.0.0",
  port: 8462,
  networkBaseUrls: ["http://192.168.1.42:8462", "http://devbox.tail4e2c.ts.net:8462"],
  tailscaleBindHosts: [],
  token: "pair-token-value",
  configuredBindHost: "0.0.0.0",
  configuredPort: 8462,
  configuredServeWebUi: false,
};

// The pair panel mirrors the server status the way LAN / VPN access does: not running and
// no-token states are plain notices, and offline shows the connect prompt.
describe("ServerAccessSection pair device", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderWithServerStatus(status: ApiServerStatus) {
    harness = createConnectionHarness("kept-gap", (): TestApiOverrides<APIClient> => {
      const sessions = serverSessions;
      return {
        serverAuth: { listSessions: () => Promise.resolve(sessions) },
        server: { getApiServerStatus: () => Promise.resolve(status) },
      };
    });
    return render(
      <harness.Wrapper>
        <ServerAccessSection />
      </harness.Wrapper>
    );
  }

  test("defaults the QR address to a network address and hides the token until revealed", async () => {
    const view = renderWithServerStatus(RUNNING_STATUS);

    // The default address is the LAN one, not the loopback base URL, and the token is masked.
    const masked = await view.findByText(/token=\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022/);
    expect(masked.textContent).toContain("192.168.1.42");
    expect(view.queryByText("pair-token-value")).toBeNull();
    expect(view.queryByRole("img", { name: "Pairing QR code" })).toBeNull();

    await view.findByRole("button", { name: "Show pairing code" }).then((reveal) => {
      reveal.click();
    });

    // Revealed: the QR carries the URL-encoded link for the selected address.
    const qr = await view.findByRole("img", { name: "Pairing QR code" });
    expect(qr).not.toBeNull();
    await view.findByText("http://192.168.1.42:8462/?token=pair-token-value");
  });

  test("warns when only a loopback address is available", async () => {
    const view = renderWithServerStatus({
      ...RUNNING_STATUS,
      networkBaseUrls: [],
      bindHost: "127.0.0.1",
    });

    await view.findByText(/only listens on localhost/);
    await view.findByText(/Expose API server on LAN\/VPN/);
  });

  test("reports a not-running server without offering the QR", async () => {
    const view = renderWithServerStatus({
      ...RUNNING_STATUS,
      running: false,
      baseUrl: null,
      token: null,
    });

    await view.findByText("Server is not running.");
    expect(view.queryByText(/Pair device/)).not.toBeNull();
    expect(view.queryByRole("button", { name: "Show pairing code" })).toBeNull();
  });

  test("reports a server without a token", async () => {
    const view = renderWithServerStatus({ ...RUNNING_STATUS, token: null });

    await view.findByText(/runs without an auth token/);
    expect(view.queryByRole("button", { name: "Show pairing code" })).toBeNull();
  });
});
