// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { ArtifactsPanel } from "./ArtifactsPanel";
import type { ArtifactInteractionHandlers } from "./artifactInteractions";
import { useArtifactInteractions, type ArtifactInteractionTarget } from "./useArtifactInteractions";
import { CONFIRM_ARM_DELAY_MS } from "./confirmArming";

const HTML: ArtifactReadResult = {
  status: "ok",
  path: "form.html",
  kind: "html",
  size: 20,
  modifiedMs: 1,
  encoding: "utf8",
  content: "<button>Ship</button>",
};

let sends: Array<{ path: string; text: string; data?: unknown; version: number | null }> = [];
let savedStates: unknown[] = [];
interface SetStateResult {
  success: true;
  data: { version: number };
}
let setStateImpl: (state: unknown) => Promise<SetStateResult> = (state) => {
  savedStates.push(state);
  return Promise.resolve({ success: true as const, data: { version: 0 } });
};
let persistedState: unknown = { step: 1 };
/** When set, getState waits for this promise (state still loading). */
let stateGate: Promise<void> | null = null;
/** When set, sendInteraction resolves only after this promise (send in flight). */
let sendGate: Promise<void> | null = null;

function Wrapper(props: { children: ReactNode }) {
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      list: () =>
        Promise.resolve({
          success: true as const,
          data: {
            available: true as const,
            dir: "/scratch/artifacts",
            entries: [{ path: HTML.path, kind: HTML.kind, size: HTML.size, modifiedMs: 1 }],
            truncated: false,
          },
        }),
      read: () => Promise.resolve({ success: true as const, data: HTML }),
      listVersions: (input: { path: string }) =>
        Promise.resolve({
          success: true as const,
          data: { artifactId: "id", path: input.path, pin: null, versions: [] },
        }),
      listPinned: () =>
        Promise.resolve({ success: true as const, data: { available: true as const, files: [] } }),
      capabilities: () => Promise.resolve({ agentBrowserAvailable: true }),
      listShelf: () =>
        Promise.resolve({
          success: true as const,
          data: { project: { available: true as const, entries: [] }, global: [] },
        }),
      getState: async () => {
        await stateGate;
        return { success: true as const, data: { version: 0, state: persistedState } };
      },
      setState: (input: { state: unknown }) => setStateImpl(input.state),
      sendInteraction: (input: {
        path: string;
        text: string;
        data?: unknown;
        version: number | null;
      }) => {
        sends.push(input);
        return (sendGate ?? Promise.resolve()).then(() => ({
          success: true as const,
          data: { id: "i1" },
        }));
      },
    },
  };
  return (
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={createTestApiClient(api)}>{props.children}</APIProvider>
    </ThemeProvider>
  );
}

let hookHandlers: ArtifactInteractionHandlers | undefined;
/** Renders the hook's strip and exposes its handlers, as the panel's viewer would use them. */
function InteractionsHarness(props: { target: ArtifactInteractionTarget }) {
  const { handlers, strip } = useArtifactInteractions("ws-i", props.target);
  hookHandlers = handlers;
  return <>{strip}</>;
}

/** A `message` event with an arbitrary source (the runtime's MessageEvent only takes ports). */
function messageEvent(data: unknown, source: unknown): Event {
  const event = new window.Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: source });
  return event;
}

/** Deliver a bridge message as if the artifact frame posted it. */
function postFromFrame(frame: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(messageEvent(data, frame.contentWindow));
  });
}

describe("artifact interactions in the Artifacts panel", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    // Desktop app (the preload bridge isDesktopMode checks): executable frames only mount there.
    window.api = {
      platform: "linux",
      versions: {},
      getIsRosetta: () => Promise.resolve(false),
    };
    sends = [];
    savedStates = [];
    setStateImpl = (state) => {
      savedStates.push(state);
      return Promise.resolve({ success: true as const, data: { version: 0 } });
    };
    persistedState = { step: 1 };
    stateGate = null;
    sendGate = null;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("xum.send only fills the confirm strip; the host Send click delivers it", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;

    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "First", data: { n: 1 } });
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Second" });
    // One strip per artifact; a shown strip is never replaced.
    const strip = await view.findByTestId("artifact-send-strip");
    expect(strip.textContent).toContain("First");
    expect(strip.textContent).not.toContain("Second");
    expect(sends).toEqual([]);

    // Send is disabled right after the strip appears, then arms.
    const sendButton = view.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });

    // Enter does nothing unless the Send button itself has focus.
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "Enter" });
    expect(sends).toEqual([]);

    // Bait-and-switch: a send posted between the user's pointerdown and click changes nothing.
    fireEvent.pointerDown(sendButton);
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Swapped" });
    expect(strip.textContent).not.toContain("Swapped");
    fireEvent.click(sendButton);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ path: "form.html", text: "First", version: null });
    await waitFor(() => expect(view.queryByTestId("artifact-send-strip")).toBeNull());

    // After Send the artifact can ask again.
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Third" });
    expect((await view.findByTestId("artifact-send-strip")).textContent).toContain("Third");
  });

  test("a frame that navigates away is dropped and gets no bridge until Reload", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const frameWindow = frame.contentWindow;
    fireEvent.load(frame);
    // The second load is a navigation (location.href, a clicked link).
    fireEvent.load(frame);
    expect(await view.findByText(/This artifact navigated away/)).toBeTruthy();
    expect(view.queryByTestId("artifact-frame")).toBeNull();
    // Whatever the old window posts now is ignored.
    act(() => {
      window.dispatchEvent(
        messageEvent({ xumArtifact: 1, type: "send", text: "From the remote page" }, frameWindow)
      );
    });
    expect(view.queryByTestId("artifact-send-strip")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    expect(await view.findByTestId("artifact-frame")).toBeTruthy();
  });

  test("in browser mode the frame mounts, but nothing it posts reaches the host", async () => {
    // Phones use browser mode. There a page the frame navigated to runs before the second load
    // event and keeps the same window, so the host never listens (executableFrames.ts).
    delete window.api;
    const addListener = spyOn(window, "addEventListener");
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    fireEvent.load(frame);
    // Before any second load, as a navigated page's scripts would.
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "From a navigated page" });
    postFromFrame(frame, { xumArtifact: 1, type: "setState", state: { stolen: true } });
    expect(addListener.mock.calls.filter(([type]) => type === "message")).toEqual([]);
    addListener.mockRestore();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(view.queryByTestId("artifact-send-strip")).toBeNull();
    expect(savedStates).toEqual([]);
  });

  test("frame pins (Annotate) are offered only in the desktop app", async () => {
    const desktop = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    await desktop.findByTestId("artifact-frame");
    expect(await desktop.findByRole("button", { name: "Annotate" })).toBeTruthy();
    cleanup();

    delete window.api;
    const browser = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    await browser.findByTestId("artifact-frame");
    expect(browser.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("Dismiss drops the pending send without delivering it", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Nope" });
    fireEvent.click(await view.findByRole("button", { name: "Dismiss" }));
    expect(view.queryByTestId("artifact-send-strip")).toBeNull();
    expect(sends).toEqual([]);
  });

  test("the strip's shortcuts send once armed and dismiss, from inside the panel", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    const panel = view.getByTestId("artifacts-panel");
    const sendKey = { key: "Enter", ctrlKey: true };
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Ship it" });
    await view.findByTestId("artifact-send-strip");
    // Like the button: nothing before the strip arms.
    fireEvent.keyDown(panel, sendKey);
    const sendButton = view.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    // An auto-repeat of a chord held since before arming does not send either.
    fireEvent.keyDown(panel, { ...sendKey, repeat: true });
    expect(sends).toEqual([]);
    fireEvent.keyDown(panel, sendKey);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "Ship it" });
    await waitFor(() => expect(view.queryByTestId("artifact-send-strip")).toBeNull());

    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Nope" });
    await view.findByTestId("artifact-send-strip");
    fireEvent.keyDown(panel, { key: "Backspace", ctrlKey: true });
    expect(view.queryByTestId("artifact-send-strip")).toBeNull();
    expect(sends).toHaveLength(1);
  });

  test("a send in flight cannot be dismissed", async () => {
    const gate = Promise.withResolvers<void>();
    sendGate = gate.promise;
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Ship it" });
    const sendButton = (await view.findByRole("button", { name: "Send" })) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.pointerDown(sendButton);
    fireEvent.click(sendButton);
    await waitFor(() => expect(sends).toHaveLength(1));
    const dismiss = view.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    expect(dismiss.disabled).toBe(true);
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "Backspace", ctrlKey: true });
    expect(view.queryByTestId("artifact-send-strip")).not.toBeNull();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(view.queryByTestId("artifact-send-strip")).toBeNull());
  });

  test("messages from another window and invalid payloads are ignored", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(messageEvent({ xumArtifact: 1, type: "send", text: "spoof" }, window));
    });
    postFromFrame(frame, { xumArtifact: 1, type: "send", text: "x".repeat(4001) });
    expect(view.queryByTestId("artifact-send-strip")).toBeNull();
  });

  test("persisted state is baked into the srcdoc, never posted into the frame", async () => {
    // The state arrives late; the frame could have navigated away by then.
    const gate = Promise.withResolvers<void>();
    const releaseState = gate.resolve;
    stateGate = gate.promise;
    persistedState = { note: "</script><script>parent.leak()</script>" };
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    // A frame shown before the state is known may already be a remote page by the time the
    // state arrives; record everything posted into it.
    const posted: unknown[] = [];
    const early = await view.findByTestId("artifact-frame", {}, { timeout: 500 }).catch(() => null);
    const frameWindow = (early as HTMLIFrameElement | null)?.contentWindow;
    if (frameWindow != null) {
      const original = frameWindow.postMessage.bind(frameWindow);
      frameWindow.postMessage = ((message: unknown, targetOrigin: string) => {
        posted.push(message);
        original(message, targetOrigin);
      }) as typeof frameWindow.postMessage;
    }
    act(() => releaseState());
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted.filter((m) => (m as { type?: unknown }).type === "state")).toEqual([]);

    // The state rides in the shim, and its "</script>" cannot open a second script.
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    const doc = new window.DOMParser().parseFromString(srcdoc, "text/html");
    const scripts = Array.from(doc.querySelectorAll("script"));
    expect(scripts).toHaveLength(1);
    const embedded = /var state = JSON\.parse\((.*)\);/.exec(scripts[0].textContent ?? "")?.[1];
    expect(JSON.parse(JSON.parse(embedded ?? '"null"') as string)).toEqual(persistedState);
  });

  test("setState from the frame is persisted for the displayed version", async () => {
    const view = render(<ArtifactsPanel workspaceId="ws-i" />, { wrapper: Wrapper });
    const frame = (await view.findByTestId("artifact-frame")) as HTMLIFrameElement;
    postFromFrame(frame, { xumArtifact: 1, type: "setState", state: { step: 2 } });
    await waitFor(() => expect(savedStates).toEqual([{ step: 2 }]));
  });

  test("Send delivers the version shown when the artifact asked, not the one selected later", async () => {
    const target = (version: number) => ({ path: HTML.path, version, latestVersion: 2 });
    const view = render(<InteractionsHarness target={target(1)} />, { wrapper: Wrapper });
    act(() => hookHandlers?.requestSend("Ship v1", undefined));
    await view.findByTestId("artifact-send-strip");
    view.rerender(<InteractionsHarness target={target(2)} />);
    // Send arms after a short delay (confirmArming.ts).
    const sendButton = view.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.click(sendButton);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "Ship v1", version: 1 });
  });

  test("a live view's send keeps the newest version from when the artifact asked", async () => {
    const live = (latestVersion: number) => ({ path: HTML.path, version: null, latestVersion });
    const view = render(<InteractionsHarness target={live(2)} />, { wrapper: Wrapper });
    act(() => hookHandlers?.requestSend("Ship it", undefined));
    await view.findByTestId("artifact-send-strip");
    // A snapshot lands while the strip is open.
    view.rerender(<InteractionsHarness target={live(3)} />);
    const sendButton = view.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.click(sendButton);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "Ship it", version: 2 });
  });

  test("Send needs a press that started after it armed (or keyboard activation)", async () => {
    const view = render(
      <InteractionsHarness target={{ path: HTML.path, version: 1, latestVersion: 1 }} />,
      { wrapper: Wrapper }
    );
    act(() => hookHandlers?.requestSend("Held", undefined));
    const sendButton = (await view.findByRole("button", { name: "Send" })) as HTMLButtonElement;
    // A press held from before the strip armed does not confirm it on release.
    fireEvent.pointerDown(sendButton);
    await waitFor(() => expect(sendButton.disabled).toBe(false), {
      timeout: CONFIRM_ARM_DELAY_MS + 1000,
    });
    fireEvent.click(sendButton, { detail: 1 });
    // Nor does a pointer click with no press seen on the armed button.
    fireEvent.click(sendButton, { detail: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toEqual([]);

    fireEvent.pointerDown(sendButton);
    fireEvent.click(sendButton, { detail: 1 });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "Held" });
  });

  test("concurrent setState writes run one at a time and the last state wins", async () => {
    // A server that persists each write when its request settles: overlapping requests that
    // settle out of order would leave an older state on disk.
    let persisted: unknown = null;
    let inFlight: Array<{ state: unknown; settle: () => void }> = [];
    let maxInFlight = 0;
    setStateImpl = (state) =>
      new Promise((resolve) => {
        const request = {
          state,
          settle: () => {
            persisted = state;
            resolve({ success: true as const, data: { version: 0 } });
          },
        };
        inFlight.push(request);
        maxInFlight = Math.max(maxInFlight, inFlight.length);
      });
    render(<InteractionsHarness target={{ path: HTML.path, version: 0, latestVersion: 0 }} />, {
      wrapper: Wrapper,
    });
    act(() => {
      hookHandlers?.setState?.({ step: 1 });
      hookHandlers?.setState?.({ step: 2 });
      hookHandlers?.setState?.({ step: 3 });
    });
    // Settle the newest request first, as a slow older write would.
    for (let round = 0; round < 10 && inFlight.length > 0; round++) {
      const batch = inFlight.reverse();
      inFlight = [];
      for (const request of batch) request.settle();
      await act(() => Promise.resolve());
    }
    expect(inFlight).toEqual([]);
    expect(persisted).toEqual({ step: 3 });
    expect(maxInFlight).toBe(1);
  });
});
