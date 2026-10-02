import { describe, expect, test } from "bun:test";
import {
  acceptArtifactFrameMessage,
  ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND,
  buildArtifactBridgeScript,
  createBridgeRateLimiter,
} from "./artifactBridge";

// Identity is all the acceptance check uses, so plain objects stand in for windows.
const frame: Window = Object.create(null) as Window;
const other: Window = Object.create(null) as Window;
const keyMessage = { xumArtifact: 1, type: "key", key: "Escape", shiftKey: false };

describe("acceptArtifactFrameMessage", () => {
  test("accepts a valid key message from the frame window", () => {
    expect(
      acceptArtifactFrameMessage({ source: frame, data: keyMessage }, frame, () => true)
    ).toEqual({ xumArtifact: 1, type: "key", key: "Escape", shiftKey: false });
  });

  test("rejects other sources, a missing frame, and invalid payloads", () => {
    const allow = () => true;
    expect(
      acceptArtifactFrameMessage({ source: other, data: keyMessage }, frame, allow)
    ).toBeNull();
    expect(acceptArtifactFrameMessage({ source: null, data: keyMessage }, frame, allow)).toBeNull();
    expect(acceptArtifactFrameMessage({ source: frame, data: keyMessage }, null, allow)).toBeNull();
    for (const data of [
      { ...keyMessage, xumArtifact: 2 },
      { ...keyMessage, key: "Enter" },
      { ...keyMessage, extra: "token" },
      { xumArtifact: 1, type: "theme", theme: "dark" },
      { xumArtifact: 1, type: "send", payload: {} },
      "Escape",
      null,
    ]) {
      expect(acceptArtifactFrameMessage({ source: frame, data }, frame, allow)).toBeNull();
    }
  });

  test("drops messages over the rate limit, valid or not", () => {
    let now = 0;
    const allow = createBridgeRateLimiter(ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND, 1000, () => now);
    const results = Array.from({ length: ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND + 5 }, (_, i) =>
      acceptArtifactFrameMessage(
        { source: frame, data: i === 0 ? "junk" : keyMessage },
        frame,
        allow
      )
    );
    expect(results.filter((r) => r !== null)).toHaveLength(
      ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND - 1
    );
    now = 1000;
    expect(
      acceptArtifactFrameMessage({ source: frame, data: keyMessage }, frame, allow)
    ).not.toBeNull();
  });
});

/** Run the bridge script against a minimal window; returns its keydown handler and posts. */
function runBridgeScript() {
  const listeners = new Map<string, (event: unknown) => void>();
  const posted: unknown[] = [];
  const fakeWindow = {
    parent: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
  };
  // The script mirrors the theme onto the root element (data-xum-theme).
  const fakeDocument = {
    documentElement: { setAttribute: () => undefined },
    addEventListener: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
  const run = new Function(
    "window",
    "document",
    "CustomEvent",
    buildArtifactBridgeScript("dark")
  ) as (window: unknown, document: unknown, customEvent: unknown) => void;
  run(fakeWindow, fakeDocument, class {});
  const keydown = (key: string, target: unknown, shiftKey = false) =>
    listeners.get("keydown")?.({
      key,
      target,
      shiftKey,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    });
  return { keydown, posted };
}

describe("bridge script keys", () => {
  const input = { nodeType: 1, tagName: "INPUT", isContentEditable: false };
  const div = { nodeType: 1, tagName: "DIV", isContentEditable: false };

  test("Escape is posted even while an editable element has focus", () => {
    const bridge = runBridgeScript();
    bridge.keydown("Escape", input);
    expect(bridge.posted).toEqual([
      { xumArtifact: 1, type: "key", key: "Escape", shiftKey: false },
    ]);
  });

  test("Shift+F is posted outside editable elements only", () => {
    const bridge = runBridgeScript();
    bridge.keydown("F", input, true);
    expect(bridge.posted).toEqual([]);
    bridge.keydown("F", div, true);
    expect(bridge.posted).toEqual([{ xumArtifact: 1, type: "key", key: "F", shiftKey: true }]);
  });
});

describe("buildArtifactBridgeScript", () => {
  test("interpolates the theme as a JSON string literal and parses as JavaScript", () => {
    const script = buildArtifactBridgeScript("light");
    expect(script).toContain('var theme = "light";');
    // Bun's transpiler throws on a syntax error, which is all this needs to prove.
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(script)).not.toThrow();
  });

  test("mirrors the app theme into data-xum-theme for script-free artifacts", () => {
    const attributes = new Map<string, string>();
    type FakeMessageListener = (event: { source: unknown; data: unknown }) => void;
    const listeners: FakeMessageListener[] = [];
    const parent = {};
    const fakeWindow = {
      parent,
      addEventListener: (type: string, listener: FakeMessageListener) => {
        if (type === "message") listeners.push(listener);
      },
      dispatchEvent: () => true,
    };
    const fakeDocument = {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
    };
    class FakeCustomEvent {
      constructor(
        readonly type: string,
        readonly init: unknown
      ) {}
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
    const run = new Function(
      "window",
      "document",
      "CustomEvent",
      buildArtifactBridgeScript("light")
    ) as (window: unknown, document: unknown, customEvent: unknown) => void;
    run(fakeWindow, fakeDocument, FakeCustomEvent);
    expect(attributes.get("data-xum-theme")).toBe("light");

    const send = (data: unknown, source: unknown = parent) =>
      listeners.forEach((listener) => listener({ source, data }));
    send({ xumArtifact: 1, type: "theme", theme: "dark" }, {});
    expect(attributes.get("data-xum-theme")).toBe("light");
    send({ xumArtifact: 1, type: "theme", theme: "dark" });
    expect(attributes.get("data-xum-theme")).toBe("dark");
  });
});

describe("bridge script WebRTC removal", () => {
  test("deletes every RTC global before artifact scripts run", () => {
    // CSP cannot govern WebRTC: connect-src 'none' leaves RTCPeerConnection's STUN/TURN traffic
    // open (Chromium ignores `webrtc 'block'`), so the first script removes the constructors.
    const fakeWindow: Record<string, unknown> = {
      parent: { postMessage: () => undefined },
      addEventListener: () => undefined,
      RTCPeerConnection: class {},
      webkitRTCPeerConnection: class {},
      RTCIceTransport: class {},
      RTCDataChannel: class {},
      fetch: () => undefined,
    };
    // A fake document too: later bridge versions mirror the theme onto the root element.
    const fakeDocument = { documentElement: { setAttribute: () => undefined } };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
    const run = new Function(
      "window",
      "document",
      "CustomEvent",
      buildArtifactBridgeScript("dark")
    ) as (window: unknown, document: unknown, customEvent: unknown) => void;
    run(fakeWindow, fakeDocument, class {});
    expect(Object.keys(fakeWindow).filter((name) => name.includes("RTC"))).toEqual([]);
    expect(typeof fakeWindow.fetch).toBe("function");
  });
});
