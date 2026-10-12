import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import * as vm from "node:vm";
import {
  ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS,
  ARTIFACT_JSON_MAX_BYTES,
  ARTIFACT_SEND_TEXT_MAX_CHARS,
} from "@/common/constants/artifactInteractions";
import {
  acceptArtifactFrameMessage,
  ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND,
  ARTIFACT_STATE_POST_INTERVAL_MS,
  ARTIFACT_WORKSPACE_ID_MAX_CHARS,
  buildArtifactBridgeScript,
  createBridgeRateLimiter,
} from "./artifactBridge";
import { MCP_APP_PREAMBLE_SCRIPT } from "./mcpAppCsp";

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
  const fakeWindow: { xum?: { openWorkspace: (id: unknown) => void } } & Record<string, unknown> = {
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
  return { keydown, posted, xum: fakeWindow.xum };
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

describe("openWorkspace messages", () => {
  const accept = (data: unknown) =>
    acceptArtifactFrameMessage({ source: frame, data }, frame, () => true);
  const open = (workspaceId: unknown) => ({ xumArtifact: 1, type: "openWorkspace", workspaceId });

  test("accepts a workspace ID", () => {
    // Legacy IDs are `<project>-<dir>` basenames, which can hold spaces and other characters.
    for (const workspaceId of ["a1b2c3d4e5", "My Project-feature branch"]) {
      expect(accept(open(workspaceId))).toMatchObject({ type: "openWorkspace", workspaceId });
    }
  });

  test("refuses a missing, non-string, empty or oversize ID and extra fields", () => {
    for (const data of [
      { xumArtifact: 1, type: "openWorkspace" },
      open(42),
      open(["a1b2c3d4e5"]),
      open(""),
      open("a".repeat(ARTIFACT_WORKSPACE_ID_MAX_CHARS + 1)),
      { ...open("a1b2c3d4e5"), title: "Fix the bug" },
    ]) {
      expect(accept(data)).toBeNull();
    }
  });

  test("window.xum.openWorkspace posts the ID as a string and returns nothing", () => {
    const bridge = runBridgeScript();
    expect(bridge.xum?.openWorkspace("a1b2c3d4e5")).toBeUndefined();
    bridge.xum?.openWorkspace(42);
    expect(bridge.posted).toEqual([open("a1b2c3d4e5"), open("42")]);
  });
});

describe("send and setState messages", () => {
  const allow = () => true;
  const accept = (data: unknown, source: Window = frame) =>
    acceptArtifactFrameMessage({ source, data }, frame, allow);

  test("accepts text with optional JSON data, and state, under the caps", () => {
    expect(accept({ xumArtifact: 1, type: "send", text: "Ship it" })).toMatchObject({
      type: "send",
      text: "Ship it",
    });
    expect(
      accept({ xumArtifact: 1, type: "send", text: "x", data: { a: [1, "b", null] } })
    ).toMatchObject({ data: { a: [1, "b", null] } });
    expect(accept({ xumArtifact: 1, type: "setState", state: { step: 2 } })).toMatchObject({
      type: "setState",
      state: { step: 2 },
    });
  });

  test("refuses oversize text, oversize or non-JSON data, and other sources", () => {
    const big = "x".repeat(ARTIFACT_JSON_MAX_BYTES);
    for (const data of [
      { xumArtifact: 1, type: "send", text: "x".repeat(ARTIFACT_SEND_TEXT_MAX_CHARS + 1) },
      { xumArtifact: 1, type: "send", text: "" },
      { xumArtifact: 1, type: "send", text: "x", data: { big } },
      { xumArtifact: 1, type: "send", text: "x", data: new Map([["a", 1]]) },
      { xumArtifact: 1, type: "send", text: "x", data: { when: new Date(0) } },
      { xumArtifact: 1, type: "setState", state: { big } },
      { xumArtifact: 1, type: "setState" },
    ]) {
      expect(accept(data)).toBeNull();
    }
    expect(accept({ xumArtifact: 1, type: "send", text: "x" }, other)).toBeNull();
  });

  test("refuses a small graph of shared references without expanding it", () => {
    // Structured clone keeps aliases: each level holds the previous one twice, so the expanded
    // value doubles per level while the posted graph stays tiny. Getters count the visits.
    let visits = 0;
    let node: unknown = 0;
    for (let level = 0; level < 20; level++) {
      const child = node;
      node = {
        get a() {
          visits++;
          return child;
        },
        get b() {
          visits++;
          return child;
        },
      };
    }
    expect(accept({ xumArtifact: 1, type: "setState", state: node })).toBeNull();
    // Bounded by the JSON size cap, not by 2^20 expanded nodes.
    expect(visits).toBeLessThan(4 * ARTIFACT_JSON_MAX_BYTES);
    // The same shape with plain arrays, 40 levels deep, would be about 2^40 visits unbounded.
    let array: unknown[] = [];
    for (let level = 0; level < 40; level++) array = [array, array];
    expect(accept({ xumArtifact: 1, type: "send", text: "x", data: array })).toBeNull();
  });

  test("refuses a sparse array by its length without walking the holes", () => {
    // Structured clone keeps holes, so a tiny posted message can carry `length` 2^32 - 1;
    // walking every slot would freeze the renderer. A has-trap proxy counts slot lookups.
    let lookups = 0;
    const holes: unknown[] = [];
    holes.length = 10 * ARTIFACT_JSON_MAX_BYTES;
    const counted = new Proxy(holes, {
      has(target, key) {
        lookups++;
        return Reflect.has(target, key);
      },
    });
    expect(accept({ xumArtifact: 1, type: "send", text: "x", data: counted })).toBeNull();
    expect(lookups).toBeLessThan(ARTIFACT_JSON_MAX_BYTES);

    const huge: unknown[] = [];
    huge.length = 2 ** 32 - 1;
    expect(accept({ xumArtifact: 1, type: "setState", state: { huge } })).toBeNull();
    // A small sparse array is still JSON (holes serialize as null).
    const small: unknown[] = [];
    small[3] = 1;
    expect(accept({ xumArtifact: 1, type: "setState", state: small })).toMatchObject({
      state: small,
    });
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

describe("bridge setState", () => {
  test("coalesces a burst of saves and still posts the final state", async () => {
    const posts: unknown[] = [];
    // The shim defines `xum` on the window it is given.
    const fakeWindow: {
      parent: { postMessage: (message: unknown) => void };
      addEventListener: () => void;
      dispatchEvent: () => boolean;
      xum?: { setState: (state: unknown) => void };
    } = {
      parent: { postMessage: (message: unknown) => posts.push(message) },
      addEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    const fakeDocument = { documentElement: { setAttribute: () => undefined } };
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
    const xum = fakeWindow.xum!;

    // A drag that saves 100 times in one go stays far under the host's per-second limit.
    for (let i = 0; i <= 100; i++) xum.setState({ i });
    expect(posts.length).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, ARTIFACT_STATE_POST_INTERVAL_MS + 100));
    expect(posts.length).toBeLessThanOrEqual(2);
    expect(posts.at(-1)).toEqual({ xumArtifact: 1, type: "setState", state: { i: 100 } });
  });
});

describe("bridge annotate mode", () => {
  test("swallows the click before the artifact's own window listeners see it", async () => {
    // A real DOM window, so listener ordering and propagation follow the DOM spec.
    const win = new HappyWindow({ url: "http://localhost" });
    const posts: unknown[] = [];
    // Top-level window: `window.parent` is the window itself, so its postMessage is the host's.
    win.postMessage = ((message: unknown) => posts.push(message)) as typeof win.postMessage;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
    const run = new Function(
      "window",
      "document",
      "CustomEvent",
      buildArtifactBridgeScript("light")
    ) as (window: unknown, document: unknown, customEvent: unknown) => void;
    run(win, win.document, win.CustomEvent);
    // The artifact's own capture listener, registered after the shim.
    let artifactSawClick = false;
    win.addEventListener("click", () => (artifactSawClick = true), true);
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: { xumArtifact: 1, type: "annotate", enabled: true },
        source: win as never,
      })
    );
    win.document.body.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(artifactSawClick).toBe(false);
    expect(posts).toEqual([expect.objectContaining({ xumArtifact: 1, type: "annotate" })]);
    await win.happyDOM.close();
  });
});

describe("in-page links", () => {
  // A srcdoc frame resolves "#id" against the app's URL, so an unhandled click navigates the
  // frame to the app and the navigation guard closes the artifact. The handler cancels it and
  // jumps to the target itself. HTML artifacts and MCP App views both get it.
  test.each([
    ["HTML artifact bridge", buildArtifactBridgeScript("light")],
    ["MCP App preamble", MCP_APP_PREAMBLE_SCRIPT],
  ])("%s jumps to # targets inside the frame document", async (_name, script) => {
    const win = new HappyWindow({ url: "http://localhost/workspace/abc" });
    const doc = win.document;
    doc.body.innerHTML = `
      <a id="plain" href="#intro">Intro</a>
      <a id="encoded" href=" #caf%C3%A9 ">Cafe</a>
      <a id="stray-percent" href="#caf%C3%A9%">Stray percent</a>
      <a id="raw-name" href="#legacy%20name"><span id="inner">Legacy</span></a>
      <a id="decoded-name" href="#old%20name">Old</a>
      <a id="top-link" href="#">Top</a>
      <a id="missing" href="#nowhere">Missing</a>
      <a id="external" href="https://example.com/#intro">External</a>
      <a id="blank" href="#intro" target="_blank">New tab</a>
      <a id="download" href="#intro" download>Download</a>
      <a id="self" href="#intro" target="_SELF">Same frame</a>
      <a id="no-href">Not a link</a>
      <a id="own" href="#intro">Handled by the artifact</a>
      <svg><a id="svg"><text>SVG</text></a></svg>
      <h2 id="intro">Intro</h2><h2 id="café">Cafe</h2><h2 id="café%">Stray</h2>
      <input name="legacy%20name"><a name="legacy%20name">Raw</a><a name="old name">Decoded</a>`;
    doc
      .getElementById("svg")!
      .setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#intro");
    const scrolled: string[] = [];
    for (const element of Array.from(doc.querySelectorAll("h2, a, input"))) {
      element.scrollIntoView = () => scrolled.push(element.textContent);
    }
    win.scrollTo = (() => scrolled.push("top")) as typeof win.scrollTo;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
    const run = new Function("window", "document", "CustomEvent", script) as (
      window: unknown,
      document: unknown,
      customEvent: unknown
    ) => void;
    run(win, doc, win.CustomEvent);
    // The artifact's own handler, which takes over one link.
    doc.getElementById("own")!.addEventListener("click", (event) => event.preventDefault());
    // A window listener added after the shim's runs after it: record what the shim decided, then
    // stop Happy DOM from navigating.
    const seen: { prevented: boolean | null } = { prevented: null };
    win.addEventListener("click", (event) => {
      seen.prevented = event.defaultPrevented;
      event.preventDefault();
    });
    const click = (
      id: string,
      init: { ctrlKey?: boolean; button?: number } = {}
    ): { prevented: boolean | null; scrolled: string[]; focused: string | null } => {
      scrolled.length = 0;
      seen.prevented = null;
      doc.activeElement?.blur();
      doc
        .getElementById(id)!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      const active = doc.activeElement;
      const focused = active == null || active === doc.body ? null : active.textContent;
      return { prevented: seen.prevented, scrolled: [...scrolled], focused };
    };

    const jump = (text: string) => ({ prevented: true, scrolled: [text], focused: text });
    expect(click("plain")).toEqual(jump("Intro"));
    expect(click("encoded")).toEqual(jump("Cafe"));
    // A "%" without two hex digits stays as it is; the valid escape still decodes.
    expect(click("stray-percent")).toEqual(jump("Stray"));
    // The raw fragment is tried before the decoded one, and only <a name> counts as a name.
    expect(click("inner")).toEqual(jump("Raw"));
    expect(click("decoded-name")).toEqual(jump("Decoded"));
    expect(click("svg")).toEqual(jump("Intro"));
    expect(click("self")).toEqual(jump("Intro"));
    expect(click("top-link")).toEqual({ prevented: true, scrolled: ["top"], focused: null });
    // Keyboard activation of "#": focus stays on the link, as in a browser.
    const topLink = doc.getElementById("top-link");
    if (!(topLink instanceof win.HTMLElement)) throw new Error("top-link is not an HTML element");
    topLink.focus();
    topLink.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(doc.activeElement?.id).toBe("top-link");
    // No target: the navigation is still cancelled, and nothing moves (as in a browser).
    expect(click("missing")).toEqual({ prevented: true, scrolled: [], focused: null });
    // Left to the browser (and the navigation guards): other URLs, modified and non-left clicks.
    const untouched = { prevented: false, scrolled: [], focused: null };
    expect(click("external")).toEqual(untouched);
    expect(click("blank")).toEqual(untouched);
    expect(click("download")).toEqual(untouched);
    expect(click("no-href")).toEqual(untouched);
    expect(click("plain", { ctrlKey: true })).toEqual(untouched);
    expect(click("plain", { button: 1 })).toEqual(untouched);
    // The artifact's own preventDefault wins: the shim does not jump on top of it.
    expect(click("own")).toEqual({ prevented: true, scrolled: [], focused: null });
    await win.happyDOM.close();
  });
});

/** Minimal event target: the suite may run with Happy DOM's globals installed by other files. */
class FakeTarget {
  private readonly listeners = new Map<string, Array<(event: { detail?: unknown }) => void>>();
  addEventListener(
    type: string,
    listener: (event: { detail?: unknown }) => void,
    options?: unknown
  ) {
    const once = (options as { once?: boolean } | undefined)?.once === true;
    const wrapped = once
      ? (event: { detail?: unknown }) => {
          this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((l) => l !== wrapped)
          );
          listener(event);
        }
      : listener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  dispatchEvent(event: { type: string; detail?: unknown }) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

class FakeCustomEvent {
  constructor(
    readonly type: string,
    init?: { detail?: unknown }
  ) {
    this.detail = init?.detail;
  }
  readonly detail: unknown;
}

/**
 * Run the shim in a fresh realm with just the globals it touches at startup, then fire
 * DOMContentLoaded twice, let timers run, fire window load twice and let timers run again.
 * `listenOn` registers the `xumstatechange` listener from the artifact's own DOMContentLoaded
 * or window load handler (added after the shim's, as in a real srcdoc) instead of up front.
 * Values come back as JSON so the test realm compares plain data.
 */
async function runBridge(state: unknown, options: { listenOn?: "DOMContentLoaded" | "load" } = {}) {
  const win = new FakeTarget() as FakeTarget & Record<string, unknown>;
  const doc = new FakeTarget() as FakeTarget & Record<string, unknown>;
  doc.documentElement = { setAttribute: () => undefined };
  win.parent = { postMessage: () => undefined };
  const events: string[] = [];
  const listen = () =>
    win.addEventListener("xumstatechange", (event) => {
      events.push(JSON.stringify((event.detail as { state: unknown }).state));
    });
  const context = vm.createContext({
    window: win,
    document: doc,
    CustomEvent: FakeCustomEvent,
    setTimeout,
  });
  vm.runInContext(buildArtifactBridgeScript("dark", state), context);
  if (options.listenOn === "DOMContentLoaded") {
    doc.addEventListener("DOMContentLoaded", listen, { once: true });
  } else if (options.listenOn === "load") {
    win.addEventListener("load", listen, { once: true });
  } else {
    listen();
  }
  const beforeLoad = events.length;
  doc.dispatchEvent({ type: "DOMContentLoaded" });
  doc.dispatchEvent({ type: "DOMContentLoaded" });
  // Images and other resources can hold window load back well past DOMContentLoaded.
  await new Promise((resolve) => setTimeout(resolve, 10));
  win.dispatchEvent({ type: "load" });
  win.dispatchEvent({ type: "load" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const xumState = vm.runInContext(
    "JSON.stringify([window.xum.state, Object.keys(window.xum.state || {})])",
    context
  ) as string;
  return { xumState: JSON.parse(xumState) as [unknown, string[]], beforeLoad, events };
}

describe("baked-in state", () => {
  test("a __proto__ key stays an own property of the restored state", async () => {
    const state = JSON.parse('{"__proto__":{"a":1},"b":2}') as unknown;
    const { xumState } = await runBridge(state);
    expect(xumState[1]).toEqual(["__proto__", "b"]);
    expect(JSON.stringify(xumState[0])).toBe(JSON.stringify(state));
  });

  test("a restored state is announced once after load; none is not", async () => {
    const restored = await runBridge({ step: 3 });
    expect(restored.beforeLoad).toBe(0);
    expect(restored.events).toEqual([JSON.stringify({ step: 3 })]);
    expect((await runBridge(null)).events).toEqual([]);
  });

  test("a listener added from the artifact's own DOMContentLoaded handler still gets it", async () => {
    const restored = await runBridge({ step: 4 }, { listenOn: "DOMContentLoaded" });
    expect(restored.events).toEqual([JSON.stringify({ step: 4 })]);
  });

  test("a listener added from the artifact's own window load handler still gets it", async () => {
    const restored = await runBridge({ step: 5 }, { listenOn: "load" });
    expect(restored.events).toEqual([JSON.stringify({ step: 5 })]);
  });
});

describe("annotate messages", () => {
  const allow = () => true;
  const pin = { xumArtifact: 1, type: "annotate", x: 0.25, y: 1, selector: "#chart" } as const;

  test("accepts a pin with fractional coordinates and a capped quote", () => {
    expect(acceptArtifactFrameMessage({ source: frame, data: pin }, frame, allow)).toEqual(pin);
    const quoted = { ...pin, quote: "q".repeat(ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS), prefix: "a" };
    expect(acceptArtifactFrameMessage({ source: frame, data: quoted }, frame, allow)).toEqual(
      quoted
    );
  });

  test("rejects coordinates outside the frame, oversize text and unknown fields", () => {
    for (const data of [
      { ...pin, x: -0.1 },
      { ...pin, y: 1.5 },
      { ...pin, x: "0.5" },
      { ...pin, quote: "q".repeat(ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS + 1) },
      { ...pin, prefix: "p".repeat(65) },
      { ...pin, selector: "s".repeat(201) },
      { ...pin, comment: "injected" },
    ]) {
      expect(acceptArtifactFrameMessage({ source: frame, data }, frame, allow)).toBeNull();
    }
  });
});
