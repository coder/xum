import type { Context } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIClient, UseAPIResult } from "@/browser/contexts/API";
import { requireTestModule, type RecursivePartial } from "@/browser/testUtils";
import type * as DesktopModule from "./useDesktopConnection";
import DesktopRfbFixture from "./desktopRfb.test-fixture";

// Bun's module mocks are process-wide. As in useAIViewKeybinds.test, load an isolated
// hook/API pair instead of letting the RFB test double leak into other suites.
const directory = dirname(fileURLToPath(import.meta.url));
const suffix = randomUUID();
const hookPath = join(directory, `useDesktopConnection.real.${suffix}.ts`);
const apiPath = join(directory, `API.real.${suffix}.tsx`);
let useDesktopConnection: typeof DesktopModule.useDesktopConnection;
let APIContext: Context<UseAPIResult | null>;

beforeAll(async () => {
  const source = await readFile(join(directory, "useDesktopConnection.ts"), "utf8");
  const isolatedSource = source
    .replaceAll("@novnc/novnc/lib/rfb", "./desktopRfb.test-fixture")
    .replace('from "@/browser/contexts/API"', `from "./API.real.${suffix}.tsx"`);
  expect(isolatedSource).not.toBe(source);
  await writeFile(hookPath, isolatedSource);
  await writeFile(apiPath, await readFile(join(directory, "../../contexts/API.tsx"), "utf8"));
  ({ useDesktopConnection } = requireTestModule<typeof DesktopModule>(hookPath));
  ({ APIContext } = requireTestModule<{ APIContext: Context<UseAPIResult | null> }>(apiPath));
});

afterAll(async () => {
  await Promise.all([rm(hookPath, { force: true }), rm(apiPath, { force: true })]);
});

describe("useDesktopConnection control ownership", () => {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
  };
  const bootstrap = {
    capability: { available: true as const, width: 1280, height: 720, sessionId: "desktop-test" },
    bridgePath: "/desktop/ws",
    token: "test-token",
  };
  let getBootstrap = mock(() => Promise.resolve(bootstrap));

  beforeEach(() => {
    const dom = new GlobalWindow({ url: "http://localhost:3000" }) as unknown as Window &
      typeof globalThis;
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      KeyboardEvent: dom.KeyboardEvent,
      MouseEvent: dom.MouseEvent,
      Event: dom.Event,
    });
    DesktopRfbFixture.instances = [];
    getBootstrap = mock(() => Promise.resolve(bootstrap));
  });

  afterEach(() => {
    cleanup();
    Object.assign(globalThis, originals);
  });

  function mountConnection() {
    let desktop!: DesktopModule.UseDesktopConnectionResult;
    function Harness() {
      desktop = useDesktopConnection("workspace-1");
      return <div ref={desktop.containerRef} />;
    }
    const client: RecursivePartial<APIClient> = { desktop: { getBootstrap } };
    const view = render(
      <APIContext.Provider
        value={{
          status: "connected",
          api: client as APIClient,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <Harness />
      </APIContext.Provider>
    );
    return {
      ...view,
      get desktop() {
        return desktop;
      },
    };
  }

  async function connect(view: ReturnType<typeof mountConnection>) {
    act(() => view.desktop.connect());
    await waitFor(() => expect(view.desktop.state).toBe("connected"));
    const rfb = DesktopRfbFixture.instances.at(-1);
    if (!rfb) throw new Error("Desktop did not construct an RFB connection");
    return rfb;
  }

  function holdKeysAndDrag(rfb: DesktopRfbFixture) {
    for (const [key, code] of [
      ["Shift", "ShiftLeft"],
      ["Control", "ControlLeft"],
    ]) {
      rfb.canvas.dispatchEvent(new KeyboardEvent("keydown", { key, code }));
    }
    rfb.canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
  }

  test("starts view-only, blocks guest input, and changes scale live without reconnecting", async () => {
    const view = mountConnection();
    expect(view.desktop.controlling).toBe(false);
    expect(view.desktop.scaleToFit).toBe(true);
    const rfb = await connect(view);
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.resizeSession).toBe(false);
    holdKeysAndDrag(rfb);
    expect(rfb.input).toEqual([]);

    act(() => view.desktop.setScaleToFit(false));
    expect(rfb.scaleViewport).toBe(false);
    expect(view.desktop.scaleToFit).toBe(false);
    act(() => view.desktop.setScaleToFit(true));
    expect(rfb.scaleViewport).toBe(true);
    expect(getBootstrap).toHaveBeenCalledTimes(1);
    expect(DesktopRfbFixture.instances).toHaveLength(1);
    expect(rfb.disconnectCount).toBe(0);
  });

  test.each(["release", "blur", "hidden", "disconnect", "network", "unmount"])(
    "%s releases held keys and drag before noVNC becomes view-only",
    async (reason) => {
      const view = mountConnection();
      const rfb = await connect(view);
      act(() => view.desktop.setControlling(true));
      expect(view.desktop.controlling).toBe(true);
      expect(rfb.viewOnly).toBe(false);
      holdKeysAndDrag(rfb);
      act(() => {
        if (reason === "release") view.desktop.setControlling(false);
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        if (reason === "hidden") {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (reason === "disconnect") view.desktop.disconnect();
        if (reason === "network") {
          rfb.events.dispatchEvent(
            new window.CustomEvent("disconnect", { detail: { clean: false } })
          );
        }
        if (reason === "unmount") view.unmount();
      });
      expect(rfb.input.filter(({ type }) => type === "keyup" || type === "mouseup")).toEqual([
        { type: "keyup", code: "ShiftLeft", viewOnly: false },
        { type: "keyup", code: "ControlLeft", viewOnly: false },
        { type: "mouseup", button: 0, viewOnly: false },
      ]);
      expect(rfb.viewOnly).toBe(true);
      if (reason !== "unmount") expect(view.desktop.controlling).toBe(false);
      if (["disconnect", "network", "unmount"].includes(reason))
        expect(rfb.disconnectCount).toBe(1);
      else expect(rfb.disconnectCount).toBe(0);
    }
  );

  test("moving focus from a control button to the canvas retains control until the window blurs", async () => {
    const view = mountConnection();
    const rfb = await connect(view);
    const button = document.createElement("button");
    view.container.appendChild(button);
    button.focus();
    act(() => view.desktop.setControlling(true));
    holdKeysAndDrag(rfb);

    act(() => rfb.canvas.focus());
    expect(document.activeElement).toBe(rfb.canvas);
    expect(view.desktop.controlling).toBe(true);
    expect(rfb.viewOnly).toBe(false);
    expect(rfb.input.filter(({ type }) => type === "keyup" || type === "mouseup")).toEqual([]);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(view.desktop.controlling).toBe(false);
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.input.filter(({ type }) => type === "keyup" || type === "mouseup")).toHaveLength(3);
  });

  test("a replacement connection retains zoom but never inherits control", async () => {
    const view = mountConnection();
    const previous = await connect(view);
    act(() => {
      view.desktop.setControlling(true);
      view.desktop.setScaleToFit(false);
    });
    const replacement = await connect(view);
    expect(previous.disconnectCount).toBe(1);
    expect(replacement).not.toBe(previous);
    expect(replacement.scaleViewport).toBe(false);
    expect(replacement.resizeSession).toBe(false);
    expect(replacement.viewOnly).toBe(true);
    expect(view.desktop.controlling).toBe(false);
    expect(getBootstrap).toHaveBeenCalledTimes(2);
  });

  test("unmount prevents a pending bootstrap from creating a connection", async () => {
    let resolve!: (value: typeof bootstrap) => void;
    getBootstrap = mock(
      () =>
        new Promise<typeof bootstrap>((done) => {
          resolve = done;
        })
    );
    const view = mountConnection();
    act(() => view.desktop.connect());
    expect(view.desktop.state).toBe("checking");
    view.unmount();
    await act(async () => {
      resolve(bootstrap);
      await Promise.resolve();
    });
    window.dispatchEvent(new Event("blur"));
    expect(DesktopRfbFixture.instances).toHaveLength(0);
    expect(getBootstrap).toHaveBeenCalledTimes(1);
  });
});
