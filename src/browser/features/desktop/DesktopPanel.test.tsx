import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// Keep the fake transport and its events in one realm even after other UI tests install a DOM.
import { GlobalWindow, EventTarget, Event, CustomEvent } from "happy-dom";
import type { APIClient } from "@/browser/contexts/API";

const getBootstrap = mock<APIClient["desktop"]["getBootstrap"]>();
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: { desktop: { getBootstrap } } }),
}));

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = [];
  disconnected = false;
  constructor(
    _container: HTMLElement,
    readonly url: string
  ) {
    super();
    FakeRfb.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("connect")));
  }
  disconnect() {
    this.disconnected = true;
  }
}
void mock.module("@novnc/novnc/lib/rfb", () => ({ default: FakeRfb }));

import { DesktopPanel } from "./DesktopPanel";

type Bootstrap = Awaited<ReturnType<APIClient["desktop"]["getBootstrap"]>>;
const ownCapability = { available: true as const, width: 1280, height: 720, sessionId: "session" };
const sharedBootstrap: Bootstrap = {
  capability: {
    ...ownCapability,
    sharedDesktop: { ownerWorkspaceId: "owner", ownerName: "Original desktop" },
  },
  bridgePath: "/desktop/ws/caller",
  token: "caller-token",
};

async function connectedViewer() {
  await waitFor(() => expect(FakeRfb.instances.length).toBeGreaterThan(0));
  return FakeRfb.instances.at(-1)!;
}

describe("DesktopPanel binding", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = window.document;
    FakeRfb.instances = [];
    getBootstrap.mockReset();
    getBootstrap.mockResolvedValue(sharedBootstrap);
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows bootstrap binding while connecting with the caller's bridge and token", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const viewer = await connectedViewer();
    expect(getBootstrap).toHaveBeenCalledWith({ workspaceId: "caller" });
    expect(getBootstrap).not.toHaveBeenCalledWith({ workspaceId: "owner" });
    expect(viewer.url).toBe("ws://localhost/desktop/ws/caller?token=caller-token");
    expect(view.getByText(/Original desktop/)).toBeTruthy();
  });

  test("does not show a shared target for an independent desktop", async () => {
    getBootstrap.mockResolvedValue({ ...sharedBootstrap, capability: ownCapability });
    const view = render(<DesktopPanel workspaceId="isolated" />);
    await connectedViewer();
    expect(view.queryByText(/Original desktop/)).toBeNull();
  });

  test("clears the binding after security failure and keeps it cleared when retry bootstrap fails", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const viewer = await connectedViewer();
    act(() => {
      viewer.dispatchEvent(
        new CustomEvent("securityfailure", { detail: { status: 1, reason: "expired token" } })
      );
    });
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(viewer.disconnected).toBe(true);
    getBootstrap.mockRejectedValueOnce(new Error("binding removed"));
    act(() => view.getByRole("button", { name: "Retry" }).click());
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(2));
    expect(view.queryByText(/Original desktop/)).toBeNull();
  });

  test("clears disconnected target metadata before a reconnect gets a new bootstrap", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const viewer = await connectedViewer();
    act(() => {
      viewer.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } }));
    });
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(viewer.disconnected).toBe(true);
  });

  test("disposes the previous binding and bootstraps the newly selected workspace", async () => {
    const view = render(<DesktopPanel workspaceId="caller" />);
    const previousViewer = await connectedViewer();
    getBootstrap.mockResolvedValue({
      capability: ownCapability,
      bridgePath: "/desktop/ws/isolated",
      token: "isolated-token",
    });
    view.rerender(<DesktopPanel workspaceId="isolated" />);
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(previousViewer.disconnected).toBe(true);
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(2));
    expect(getBootstrap).toHaveBeenLastCalledWith({ workspaceId: "isolated" });
    expect(FakeRfb.instances[1].url).toBe(
      "ws://localhost/desktop/ws/isolated?token=isolated-token"
    );
    expect(view.queryByText(/Original desktop/)).toBeNull();
  });

  test("ignores a late bootstrap from the workspace that was switched away from", async () => {
    const pending = Promise.withResolvers<Bootstrap>();
    getBootstrap.mockReturnValueOnce(pending.promise);
    const view = render(<DesktopPanel workspaceId="caller" />);
    getBootstrap.mockResolvedValue({ ...sharedBootstrap, capability: ownCapability });
    view.rerender(<DesktopPanel workspaceId="isolated" />);
    await connectedViewer();
    await act(async () => {
      pending.resolve(sharedBootstrap);
      await pending.promise;
    });
    expect(FakeRfb.instances).toHaveLength(1);
    expect(view.queryByText(/Original desktop/)).toBeNull();
    expect(getBootstrap).toHaveBeenLastCalledWith({ workspaceId: "isolated" });
  });
});
