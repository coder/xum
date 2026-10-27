import { describe, expect, spyOn, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import * as vm from "node:vm";
import {
  ARTIFACT_ANNOTATION_QUOTE_MAX_CHARS,
  ARTIFACT_JSON_MAX_BYTES,
  ARTIFACT_SEND_TEXT_MAX_CHARS,
} from "@/common/constants/artifactInteractions";
import {
  acceptArtifactFrameMessage,
  ARTIFACT_BACKDROP_COLOR_MAX_CHARS,
  ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND,
  ARTIFACT_STATE_POST_INTERVAL_MS,
  ARTIFACT_WORKSPACE_ID_MAX_CHARS,
  buildArtifactBridgeScript,
  createBridgeRateLimiter,
} from "./artifactBridge";
import {
  ARTIFACT_THEME_VARIABLE_VALUE_MAX_CHARS,
  ARTIFACT_THEME_VARIABLES_MAX_COUNT,
} from "./appStyleVariables";
import { KEYBINDS } from "@/browser/utils/ui/keybinds";
import { mcpAppPreambleScript } from "./mcpAppCsp";

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

/**
 * Run the bridge script against a minimal window; returns its keydown handler and posts.
 * `querySelectorAll`: the page's document.querySelectorAll (default: finds nothing).
 * `forwardsViewSwitch`: the frame is the main pane's status page.
 */
function runBridgeScript(
  options: { querySelectorAll?: (selector: string) => unknown[]; forwardsViewSwitch?: boolean } = {}
) {
  // Every listener, in registration order: keys use capture listeners and bubble ones.
  const listeners: Array<{ type: string; capture: boolean; listener: (event: unknown) => void }> =
    [];
  const posted: unknown[] = [];
  // window.setTimeout callbacks, run once a key press has gone through every listener.
  const timers: Array<() => void> = [];
  // preventDefault calls by the bridge's own listeners.
  let prevented = 0;
  const fakeWindow: { xum?: { openWorkspace: (id: unknown) => void } } & Record<string, unknown> = {
    parent: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: (type: string, listener: (event: unknown) => void, capture?: unknown) => {
      listeners.push({ type, capture: capture === true, listener });
    },
    setTimeout: (callback: () => void) => timers.push(callback),
  };
  // The script mirrors the theme onto the root element (data-xum-theme).
  const fakeDocument = {
    documentElement: { setAttribute: () => undefined },
    addEventListener: () => undefined,
    querySelectorAll: options.querySelectorAll ?? (() => []),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
  const run = new Function(
    "window",
    "document",
    "CustomEvent",
    buildArtifactBridgeScript("dark", null, null, false, options.forwardsViewSwitch)
  ) as (window: unknown, document: unknown, customEvent: unknown) => void;
  run(fakeWindow, fakeDocument, class {});
  /**
   * One key press as the browser dispatches it to the window: the capture listeners, the page's
   * own handlers, the bubble listeners, the key's default action, then the timers.
   * `defaultPrevented`: a handler the artifact registered after the bridge's listeners kept the key.
   */
  const keydown = (
    key: string,
    target: unknown,
    shiftKey = false,
    extra: {
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
      /** The physical key, KeyboardEvent.code. */
      code?: string;
      /** AltGr is down: getModifierState("AltGraph"). */
      altGraph?: boolean;
      repeat?: boolean;
      defaultPrevented?: boolean;
      composedPath?: unknown[];
      /** False for a key the page's own script dispatched. */
      isTrusted?: boolean;
      /** The page's keydown handlers on the target or the document. */
      pageHandler?: () => void;
      /** Runs unless the key was prevented, like Escape's close request. */
      defaultAction?: () => void;
      /** Leaves the press's timers queued, so the next press arrives before they run. */
      holdTimers?: boolean;
    } = {}
  ) => {
    const event = {
      key,
      target,
      shiftKey,
      isTrusted: extra.isTrusted ?? true,
      ctrlKey: extra.ctrlKey ?? false,
      repeat: extra.repeat ?? false,
      metaKey: extra.metaKey ?? false,
      altKey: extra.altKey ?? false,
      code: extra.code ?? "",
      getModifierState: (modifier: string) => modifier === "AltGraph" && extra.altGraph === true,
      defaultPrevented: false,
      preventDefault: () => {
        prevented += 1;
      },
      ...(extra.composedPath ? { composedPath: () => extra.composedPath } : {}),
    };
    const dispatch = (capture: boolean) => {
      for (const entry of listeners) {
        if (entry.type === "keydown" && entry.capture === capture) entry.listener(event);
      }
    };
    dispatch(true);
    extra.pageHandler?.();
    dispatch(false);
    event.defaultPrevented = extra.defaultPrevented ?? false;
    if (!event.defaultPrevented) extra.defaultAction?.();
    if (extra.holdTimers !== true) for (const timer of timers.splice(0)) timer();
  };
  /**
   * A non-bubbling event at an element in the page, such as a dialog's cancel event: window sees
   * it only in the capture phase.
   */
  const fire = (type: string) => {
    for (const entry of listeners) {
      if (entry.type === type && entry.capture) entry.listener({ type });
    }
  };
  return { keydown, fire, posted, xum: fakeWindow.xum, prevented: () => prevented };
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

  test("the plain annotate key is posted unless typed, chorded, or kept by the artifact", () => {
    // The keybind's own key: a keybind the shim cannot forward fails here, not at startup.
    const key = KEYBINDS.TOGGLE_ARTIFACT_ANNOTATE.key.toLowerCase();
    const bridge = runBridgeScript();
    // Ctrl+C below is also the Vim interrupt key, posted as its own message.
    const keys = () =>
      bridge.posted.filter((message) => (message as { type?: unknown }).type === "key");
    bridge.keydown(key, input);
    bridge.keydown(key.toUpperCase(), div, true);
    bridge.keydown(key, div, false, { ctrlKey: true });
    bridge.keydown(key, div, false, { repeat: true });
    bridge.keydown(key, div, false, { defaultPrevented: true });
    // Typed in an input inside a web component: window sees the (non-editable) shadow host.
    bridge.keydown(key, div, false, { composedPath: [input, div] });
    expect(keys()).toEqual([]);
    bridge.keydown(key, div);
    // Caps Lock gives the upper case without Shift.
    bridge.keydown(key.toUpperCase(), div);
    const c = { xumArtifact: 1, type: "key", key: "C", shiftKey: false };
    expect(keys()).toEqual([c, c]);
  });

  test("the right-sidebar chord is posted with Ctrl, even from an input, and claimed", () => {
    // The keybind's own key: a keybind the shim cannot forward fails here, not at startup.
    const key = KEYBINDS.TOGGLE_RIGHT_SIDEBAR.key;
    const bridge = runBridgeScript();
    bridge.keydown(key, div, false, { ctrlKey: true });
    bridge.keydown(key, div, true);
    bridge.keydown(key, div, true, { ctrlKey: true, altKey: true });
    bridge.keydown(key, div, true, { ctrlKey: true, repeat: true });
    // Off macOS the keybind takes Ctrl only, so the Meta form stays the artifact's.
    bridge.keydown(key, div, true, { metaKey: true });
    bridge.keydown(key, div, true, { ctrlKey: true, metaKey: true });
    expect(bridge.posted).toEqual([]);
    expect(bridge.prevented()).toBe(0);
    bridge.keydown(key, input, true, { ctrlKey: true });
    bridge.keydown(key.toLowerCase(), div, true, { ctrlKey: true });
    const posted = {
      xumArtifact: 1,
      type: "sidebarKey",
      chord: "sidebar",
      ctrlKey: true,
      metaKey: false,
    };
    expect(bridge.posted).toEqual([posted, posted]);
    // Claimed in the frame, as the host claims it (Chrome binds the chord to its bookmarks bar).
    expect(bridge.prevented()).toBe(2);
  });

  test("the Artifacts tab chord is posted by name, and other Ctrl+Shift keys stay the artifact's", () => {
    // The keybinds' own keys, so a keybind the shim cannot forward fails here.
    const key = KEYBINDS.OPEN_ARTIFACTS_TAB.key;
    const bridge = runBridgeScript();
    // Keys of no forwarded chord, including names every object inherits.
    for (const other of ["A", "constructor", "toString", "__proto__"]) {
      bridge.keydown(other, div, true, { ctrlKey: true });
    }
    expect(bridge.posted).toEqual([]);
    expect(bridge.prevented()).toBe(0);
    bridge.keydown(key, div, true, { ctrlKey: true });
    expect(bridge.posted).toEqual([
      { xumArtifact: 1, type: "sidebarKey", chord: "artifacts", ctrlKey: true, metaKey: false },
    ]);
    expect(bridge.prevented()).toBe(1);
  });

  test("only the main pane's status page claims the view switch and transcript peek chords", () => {
    const key = KEYBINDS.TOGGLE_AGENT_INTERFACE_VIEW.key;
    const peek = KEYBINDS.TOGGLE_STATUS_TRANSCRIPT_PEEK;
    const pressPeek = (bridge: ReturnType<typeof runBridgeScript>) =>
      bridge.keydown(peek.key, div, true, { ctrlKey: true, altKey: true, code: peek.code });
    // Any other frame may show while no switch exists: the chords stay the artifact's.
    const elsewhere = runBridgeScript();
    elsewhere.keydown(key, div, true, { ctrlKey: true });
    pressPeek(elsewhere);
    expect(elsewhere.posted).toEqual([]);
    expect(elsewhere.prevented()).toBe(0);

    // The status page shows only while the switch exists: it must work after a click in it.
    const statusPage = runBridgeScript({ forwardsViewSwitch: true });
    statusPage.keydown(key, div, true, { ctrlKey: true });
    pressPeek(statusPage);
    const posted = { xumArtifact: 1, type: "sidebarKey", ctrlKey: true, metaKey: false };
    expect(statusPage.posted).toEqual([
      { ...posted, chord: "agentInterface" },
      { ...posted, chord: "peek" },
    ]);
    expect(statusPage.prevented()).toBe(2);
  });

  test("the peek chord matches the physical key, and AltGr and Start here stay the page's", () => {
    const peek = KEYBINDS.TOGGLE_STATUS_TRANSCRIPT_PEEK;
    const statusPage = runBridgeScript({ forwardsViewSwitch: true });
    const chord = { ctrlKey: true, altKey: true, code: peek.code };
    // Shift+AltGr+P types Ö on US-International: AltGr reads as Ctrl+Alt.
    statusPage.keydown("Ö", input, true, { ...chord, altGraph: true });
    // Without Alt it is the command palette's chord, which no frame forwards.
    statusPage.keydown(peek.key, div, true, { ctrlKey: true, code: peek.code });
    // Start here would open its confirmation under the user's typing in the page.
    const startHere = KEYBINDS.STATUS_START_HERE;
    statusPage.keydown(startHere.key, div, true, { ...chord, code: startHere.code });
    expect(statusPage.posted).toEqual([]);
    expect(statusPage.prevented()).toBe(0);
    // Whatever character the layout gives the key.
    statusPage.keydown("π", div, true, chord);
    expect(statusPage.posted).toEqual([
      { xumArtifact: 1, type: "sidebarKey", chord: "peek", ctrlKey: true, metaKey: false },
    ]);
  });

  test("on macOS the right-sidebar chord is Cmd, and Ctrl stays the artifact's", () => {
    // isMac() reads the Electron preload's platform first.
    const global = globalThis as { window?: unknown };
    const saved = global.window;
    global.window = { api: { platform: "darwin" } };
    try {
      const key = KEYBINDS.TOGGLE_RIGHT_SIDEBAR.key;
      const bridge = runBridgeScript();
      bridge.keydown(key, div, true, { ctrlKey: true });
      expect(bridge.posted).toEqual([]);
      expect(bridge.prevented()).toBe(0);
      bridge.keydown(key, div, true, { metaKey: true });
      // The Artifacts tab keybind also takes Ctrl on macOS: only its Cmd form is forwarded.
      const artifactsKey = KEYBINDS.OPEN_ARTIFACTS_TAB.key;
      bridge.keydown(artifactsKey, div, true, { ctrlKey: true });
      bridge.keydown(artifactsKey, div, true, { metaKey: true });
      expect(bridge.posted).toEqual([
        { xumArtifact: 1, type: "sidebarKey", chord: "sidebar", ctrlKey: false, metaKey: true },
        { xumArtifact: 1, type: "sidebarKey", chord: "artifacts", ctrlKey: false, metaKey: true },
      ]);
      expect(bridge.prevented()).toBe(2);
      // Option changes the key (Option+Shift+P types ∏): the peek chord matches the physical key.
      const statusPage = runBridgeScript({ forwardsViewSwitch: true });
      const peekCode = KEYBINDS.TOGGLE_STATUS_TRANSCRIPT_PEEK.code;
      statusPage.keydown("∏", div, true, { metaKey: true, altKey: true, code: peekCode });
      expect(statusPage.posted).toEqual([
        { xumArtifact: 1, type: "sidebarKey", chord: "peek", ctrlKey: false, metaKey: true },
      ]);
    } finally {
      global.window = saved;
    }
  });
});

describe("bridge script interrupt keys", () => {
  const input = { nodeType: 1, tagName: "INPUT", isContentEditable: false };
  const div = { nodeType: 1, tagName: "DIV", isContentEditable: false };
  const interrupts = (posted: unknown[]) =>
    posted.filter((message) => (message as { type?: unknown }).type === "interruptKey");

  test("the chat's interrupt keys are posted by name: Escape outside text fields, Ctrl+C anywhere", () => {
    // The keybinds' own keys: a keybind the shim cannot forward fails here.
    const escape = KEYBINDS.INTERRUPT_STREAM_NORMAL.key;
    const vimKey = KEYBINDS.INTERRUPT_STREAM_VIM.key;
    const bridge = runBridgeScript();
    bridge.keydown(escape, input);
    expect(interrupts(bridge.posted)).toEqual([]);
    bridge.keydown(escape, div);
    bridge.keydown(vimKey, input, false, { ctrlKey: true });
    // Caps Lock gives the upper case without Shift.
    bridge.keydown(vimKey.toUpperCase(), div, false, { ctrlKey: true });
    expect(interrupts(bridge.posted)).toEqual([
      { xumArtifact: 1, type: "interruptKey", keybind: "normal" },
      { xumArtifact: 1, type: "interruptKey", keybind: "vim" },
      { xumArtifact: 1, type: "interruptKey", keybind: "vim" },
    ]);
  });

  test("a key the artifact kept, dispatched itself, repeated or chorded is not posted", () => {
    const escape = KEYBINDS.INTERRUPT_STREAM_NORMAL.key;
    const vimKey = KEYBINDS.INTERRUPT_STREAM_VIM.key;
    const bridge = runBridgeScript();
    bridge.keydown(escape, div, false, { defaultPrevented: true });
    bridge.keydown(escape, div, false, { isTrusted: false });
    bridge.keydown(escape, div, false, { repeat: true });
    bridge.keydown(escape, div, true);
    bridge.keydown(escape, div, false, { ctrlKey: true });
    bridge.keydown(vimKey, div);
    bridge.keydown(vimKey, div, false, { ctrlKey: true, metaKey: true });
    bridge.keydown(vimKey, div, false, { ctrlKey: true, altKey: true });
    // Typed in an input inside a web component: window sees the (non-editable) shadow host.
    bridge.keydown(escape, div, false, { composedPath: [input, div] });
    expect(interrupts(bridge.posted)).toEqual([]);
  });

  /**
   * One of the page's dialogs or popovers. The page's querySelectorAll finds it while it is open
   * and in the document, by its kind, as the browser's selectors would (happy-dom matches no
   * :popover-open).
   */
  const pageLayer = (kind: "dialog" | "popover") => {
    const layer = {
      open: true,
      isConnected: true,
      matches: (selector: string): boolean =>
        layer.open && selector.includes(kind === "dialog" ? "dialog" : "popover-open"),
    };
    return layer;
  };
  const findLayers =
    (...layers: Array<ReturnType<typeof pageLayer>>) =>
    (selector: string) =>
      layers.filter((layer) => layer.isConnected && layer.matches(selector));

  test("Escape that closes one of the page's dialogs or popovers stays the page's", () => {
    const escape = KEYBINDS.INTERRUPT_STREAM_NORMAL.key;
    const vimKey = KEYBINDS.INTERRUPT_STREAM_VIM.key;
    for (const kind of ["dialog", "popover"] as const) {
      // Escape closes the top one; the one it was opened from stays open.
      const layer = pageLayer(kind);
      const bridge = runBridgeScript({ querySelectorAll: findLayers(pageLayer(kind), layer) });
      // The browser's close request closes it ...
      bridge.keydown(escape, div, false, {
        defaultAction: () => {
          layer.open = false;
        },
      });
      // ... or the page's own handler does, before the bridge's bubble listener runs ...
      layer.open = true;
      bridge.keydown(escape, div, false, {
        pageHandler: () => {
          layer.open = false;
        },
      });
      // ... or the page's handler removes it ...
      layer.open = true;
      bridge.keydown(escape, div, false, {
        pageHandler: () => {
          layer.isConnected = false;
        },
      });
      // ... or closes it and dispatches a key of its own, which leaves the press's layers alone.
      layer.isConnected = true;
      bridge.keydown(escape, div, false, {
        pageHandler: () => {
          layer.open = false;
          bridge.keydown(escape, div, false, { isTrusted: false });
        },
      });
      expect(interrupts(bridge.posted)).toEqual([]);
      // Only Escape closes layers: Ctrl+C interrupts whatever the page does with it.
      layer.open = true;
      bridge.keydown(vimKey, div, false, {
        ctrlKey: true,
        pageHandler: () => {
          layer.open = false;
        },
      });
      expect(interrupts(bridge.posted)).toEqual([
        { xumArtifact: 1, type: "interruptKey", keybind: "vim" },
      ]);
    }
  });

  test("a second press before the first one's check keeps each press's own layers", () => {
    const escape = KEYBINDS.INTERRUPT_STREAM_NORMAL.key;
    const dialog = pageLayer("dialog");
    const bridge = runBridgeScript({ querySelectorAll: findLayers(dialog) });
    // The first Escape closes the dialog; the second, with nothing open, interrupts.
    bridge.keydown(escape, div, false, {
      holdTimers: true,
      defaultAction: () => {
        dialog.open = false;
      },
    });
    bridge.keydown(escape, div);
    expect(interrupts(bridge.posted)).toEqual([
      { xumArtifact: 1, type: "interruptKey", keybind: "normal" },
    ]);
  });

  test("Escape whose close request a dialog's page cancels stays the page's", () => {
    // The page cancels the cancel event and closes the dialog itself after an animation, so the
    // dialog is still open when the bridge checks.
    const bridge = runBridgeScript({ querySelectorAll: findLayers(pageLayer("dialog")) });
    bridge.keydown(KEYBINDS.INTERRUPT_STREAM_NORMAL.key, div, false, {
      defaultAction: () => bridge.fire("cancel"),
    });
    expect(interrupts(bridge.posted)).toEqual([]);
    // The next Escape gets no cancel event: the dialog ignored it, so it interrupts.
    bridge.keydown(KEYBINDS.INTERRUPT_STREAM_NORMAL.key, div);
    // Ctrl+C sends no close request: a cancel event during it does not keep it.
    bridge.keydown(KEYBINDS.INTERRUPT_STREAM_VIM.key, div, false, {
      ctrlKey: true,
      pageHandler: () => bridge.fire("cancel"),
    });
    expect(interrupts(bridge.posted)).toEqual([
      { xumArtifact: 1, type: "interruptKey", keybind: "normal" },
      { xumArtifact: 1, type: "interruptKey", keybind: "vim" },
    ]);
  });

  test("Escape that leaves the page's dialogs and popovers open interrupts", () => {
    // A manual popover, or a dialog that Escape does not close (closedby="none" gives it no
    // close request): the press did nothing in the page.
    const bridge = runBridgeScript({
      querySelectorAll: findLayers(pageLayer("dialog"), pageLayer("popover")),
    });
    bridge.keydown(KEYBINDS.INTERRUPT_STREAM_NORMAL.key, div);
    expect(interrupts(bridge.posted)).toEqual([
      { xumArtifact: 1, type: "interruptKey", keybind: "normal" },
    ]);
  });

  test("a browser without popovers still sees the dialog that Escape closes", () => {
    const escape = KEYBINDS.INTERRUPT_STREAM_NORMAL.key;
    const debug = spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const dialog = pageLayer("dialog");
      const find = findLayers(dialog);
      const bridge = runBridgeScript({
        querySelectorAll: (selector) => {
          if (selector.includes("popover")) throw new SyntaxError("unsupported selector");
          return find(selector);
        },
      });
      bridge.keydown(escape, div, false, {
        defaultAction: () => {
          dialog.open = false;
        },
      });
      expect(interrupts(bridge.posted)).toEqual([]);
      dialog.open = true;
      bridge.keydown(escape, div);
      expect(interrupts(bridge.posted)).toEqual([
        { xumArtifact: 1, type: "interruptKey", keybind: "normal" },
      ]);
    } finally {
      debug.mockRestore();
    }
  });
});

describe("interruptKey messages", () => {
  test("accepts a known keybind name only", () => {
    const accept = (data: unknown) =>
      acceptArtifactFrameMessage({ source: frame, data }, frame, () => true);
    for (const keybind of ["normal", "vim"] as const) {
      const message = { xumArtifact: 1, type: "interruptKey", keybind } as const;
      expect(accept(message)).toEqual(message);
    }
    for (const data of [
      { xumArtifact: 1, type: "interruptKey" },
      { xumArtifact: 1, type: "interruptKey", keybind: "stop" },
      { xumArtifact: 1, type: "interruptKey", keybind: "normal", ctrlKey: true },
    ]) {
      expect(accept(data)).toBeNull();
    }
  });
});

describe("sidebarKey messages", () => {
  test("accepts a known chord name and the two modifier flags only", () => {
    const accept = (data: unknown) =>
      acceptArtifactFrameMessage({ source: frame, data }, frame, () => true);
    const sidebarKey = {
      xumArtifact: 1,
      type: "sidebarKey",
      chord: "sidebar",
      ctrlKey: true,
      metaKey: false,
    } as const;
    expect(accept(sidebarKey)).toEqual(sidebarKey);
    for (const chord of ["artifacts", "agentInterface", "peek"] as const) {
      expect(accept({ ...sidebarKey, chord })).toEqual({ ...sidebarKey, chord });
    }
    for (const data of [
      { xumArtifact: 1, type: "sidebarKey", chord: "sidebar", ctrlKey: true },
      { xumArtifact: 1, type: "sidebarKey", ctrlKey: true, metaKey: false },
      { ...sidebarKey, chord: "palette" },
      { ...sidebarKey, metaKey: "yes" },
      { ...sidebarKey, key: "Delete" },
    ]) {
      expect(accept(data)).toBeNull();
    }
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

  test("applies the app palette as --xum-* properties, at load and on theme messages", () => {
    const attributes = new Map<string, string>();
    const properties = new Map<string, string>();
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
        style: { setProperty: (name: string, value: string) => properties.set(name, value) },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
    const run = new Function(
      "window",
      "document",
      "CustomEvent",
      buildArtifactBridgeScript("light", null, {
        themeName: "flexoki-light",
        variables: { "--xum-bg": "#fffcf0" },
      })
    ) as (window: unknown, document: unknown, customEvent: unknown) => void;
    run(fakeWindow, fakeDocument, class {});
    expect(attributes.get("data-xum-theme-name")).toBe("flexoki-light");
    expect(properties.get("--xum-bg")).toBe("#fffcf0");

    listeners.forEach((listener) =>
      listener({
        source: parent,
        data: {
          xumArtifact: 1,
          type: "theme",
          theme: "dark",
          themeName: "flexoki-dark",
          variables: {
            "--xum-bg": "#100f0f",
            // Not --xum-*: an artifact's own properties (or anything else) stay untouched.
            "--color-background": "red",
            background: "red",
            "--xum-fg": 7,
          },
        },
      })
    );
    expect(attributes.get("data-xum-theme-name")).toBe("flexoki-dark");
    expect(Object.fromEntries(properties)).toEqual({ "--xum-bg": "#100f0f" });

    // The frame bounds what a theme message may set: too many names set none, and an over-long
    // value is skipped.
    const sendVariables = (variables: Record<string, string>) =>
      listeners.forEach((listener) =>
        listener({
          source: parent,
          data: { xumArtifact: 1, type: "theme", theme: "dark", variables },
        })
      );
    sendVariables(
      Object.fromEntries(
        Array.from({ length: ARTIFACT_THEME_VARIABLES_MAX_COUNT + 1 }, (_, i) => [
          `--xum-v${i}`,
          "#000",
        ])
      )
    );
    sendVariables({
      "--xum-fg": "x".repeat(ARTIFACT_THEME_VARIABLE_VALUE_MAX_CHARS + 1),
      "--xum-muted": "#888",
    });
    expect(Object.fromEntries(properties)).toEqual({
      "--xum-bg": "#100f0f",
      "--xum-muted": "#888",
    });
  });

  test("gives only a page without styles of its own the theme's color scheme, kept live", () => {
    const runWith = (followColorScheme: boolean) => {
      type FakeMessageListener = (event: { source: unknown; data: unknown }) => void;
      const listeners: FakeMessageListener[] = [];
      const parent = {};
      const style: { colorScheme?: string } = {};
      const fakeWindow = {
        parent,
        addEventListener: (type: string, listener: FakeMessageListener) => {
          if (type === "message") listeners.push(listener);
        },
        dispatchEvent: () => true,
      };
      const fakeDocument = { documentElement: { setAttribute: () => undefined, style } };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
      const run = new Function(
        "window",
        "document",
        "CustomEvent",
        buildArtifactBridgeScript("dark", null, null, followColorScheme)
      ) as (window: unknown, document: unknown, customEvent: unknown) => void;
      run(fakeWindow, fakeDocument, class {});
      const atLoad = style.colorScheme;
      listeners.forEach((listener) =>
        listener({ source: parent, data: { xumArtifact: 1, type: "theme", theme: "light" } })
      );
      return [atLoad, style.colorScheme];
    };
    expect(runWith(true)).toEqual(["dark", "light"]);
    expect(runWith(false)).toEqual([undefined, undefined]);
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
    ["MCP App preamble", mcpAppPreambleScript("00")],
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

  // #6219: the browser's fragment steps that the shim skipped. A target inside a closed
  // <details> or a hidden="until-found" ancestor is revealed before the scroll. The fragment is
  // the parsed URL's, so its percent-encoded form is tried first, and it is percent-decoded as
  // UTF-8 with replacement characters. <area> links count like <a>.
  test.each([
    ["HTML artifact bridge", buildArtifactBridgeScript("light")],
    ["MCP App preamble", mcpAppPreambleScript("00")],
  ])("%s reveals hidden targets and parses the fragment like a browser", async (_name, script) => {
    const win = new HappyWindow({ url: "http://localhost/workspace/abc" });
    const doc = win.document;
    doc.body.innerHTML = `
      <a id="to-details" href="#in-details">Details</a>
      <a id="to-summary" href="#summary">Summary</a>
      <a id="to-found" href="#found">Found</a>
      <a id="space" href="#a b">Space</a>
      <a id="bad-utf8" href="#%E9t%C3%A9">Bad UTF-8</a>
      <map name="m"><area id="area" href="#intro" shape="rect" coords="0,0,1,1"></map>
      <h3 id="intro">Intro</h3>
      <details id="closed"><summary>Closed</summary><div><h3 id="in-details">Inside</h3></div></details>
      <details id="summary-only"><summary id="summary">Summary</summary><p>Body</p></details>
      <div id="until-found" hidden="until-found"><h3 id="found">Found it</h3></div>
      <a id="to-kept" href="#kept">Kept</a>
      <details id="outer-kept"><div id="keeps" hidden="until-found"><h3 id="kept">Kept</h3></div></details>
      <a id="to-slotted" href="#slotted">Slotted</a>
      <div id="host"><h3 id="slotted">In slot</h3></div>
      <h3 id="a%20b">Encoded</h3><h3 id="a b">Spaced</h3><h3 id="\uFFFDt\u00e9">Replaced</h3>`;
    const scrolled: string[] = [];
    for (const element of Array.from(doc.querySelectorAll("h3, summary"))) {
      element.scrollIntoView = () => scrolled.push(element.textContent);
    }
    // A shadow tree that renders the light-DOM target in a slot under a closed <details>.
    const shadow = doc.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<details id="shadow-details"><summary>S</summary><slot></slot></details>`;
    // Happy DOM has no assignedSlot; a browser reports the slot the node renders in.
    Object.defineProperty(doc.getElementById("slotted")!, "assignedSlot", {
      value: shadow.querySelector("slot"),
    });
    const beforematch: string[] = [];
    doc.body.addEventListener("beforematch", (event) => {
      if (event.target instanceof win.HTMLElement) beforematch.push(event.target.id);
      // An artifact that keeps this one hidden: plain hidden, so no reveal goes on.
      if (event.target instanceof win.HTMLElement && event.target.id === "keeps") {
        event.target.setAttribute("hidden", "");
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
    const run = new Function("window", "document", "CustomEvent", script) as (
      window: unknown,
      document: unknown,
      customEvent: unknown
    ) => void;
    run(win, doc, win.CustomEvent);
    win.addEventListener("click", (event) => event.preventDefault());
    const click = (id: string): string[] => {
      scrolled.length = 0;
      doc
        .getElementById(id)!
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      return [...scrolled];
    };

    expect(click("to-details")).toEqual(["Inside"]);
    expect(doc.getElementById("closed")!.hasAttribute("open")).toBe(true);
    // A summary shows while its <details> is closed, so nothing opens.
    expect(click("to-summary")).toEqual(["Summary"]);
    expect(doc.getElementById("summary-only")!.hasAttribute("open")).toBe(false);
    expect(click("to-found")).toEqual(["Found it"]);
    expect(doc.getElementById("until-found")!.hasAttribute("hidden")).toBe(false);
    expect(beforematch).toEqual(["until-found"]);
    // The handler kept it hidden: the reveal stops there, and no outer <details> opens.
    click("to-kept");
    expect(doc.getElementById("keeps")!.getAttribute("hidden")).toBe("");
    expect(doc.getElementById("outer-kept")!.hasAttribute("open")).toBe(false);
    // The flat tree: the slotted target's rendered <details> is in the shadow tree.
    expect(click("to-slotted")).toEqual(["In slot"]);
    expect(shadow.getElementById("shadow-details")!.hasAttribute("open")).toBe(true);
    // "#a b" parses to "a%20b", which HTML tries before the decoded "a b".
    expect(click("space")).toEqual(["Encoded"]);
    // %E9 alone is not UTF-8: it decodes to U+FFFD, as in a browser.
    expect(click("bad-utf8")).toEqual(["Replaced"]);
    expect(click("area")).toEqual(["Intro"]);
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

describe("backdrop messages", () => {
  const allow = () => true;
  const backdrop = { xumArtifact: 1, type: "backdrop", color: "rgb(16, 15, 15)" } as const;

  test("accepts a reported color or null, and nothing else", () => {
    expect(acceptArtifactFrameMessage({ source: frame, data: backdrop }, frame, allow)).toEqual(
      backdrop
    );
    const none = { ...backdrop, color: null };
    expect(acceptArtifactFrameMessage({ source: frame, data: none }, frame, allow)).toEqual(none);
    for (const data of [
      { ...backdrop, color: "#".repeat(ARTIFACT_BACKDROP_COLOR_MAX_CHARS + 1) },
      { ...backdrop, color: 0 },
      { ...backdrop, color: undefined },
      { ...backdrop, extra: "x" },
    ]) {
      expect(acceptArtifactFrameMessage({ source: frame, data }, frame, allow)).toBeNull();
    }
  });
});

describe("bridge backdrop", () => {
  /**
   * Run the shim in a real DOM window holding `html`, fire window load and let its timers run.
   * Returns the backdrop messages it posted and a way to send it a theme message.
   */
  async function runWithPage(html: string) {
    const win = new HappyWindow({ url: "http://localhost" });
    win.document.write(html);
    const posts: unknown[] = [];
    // Top-level window: `window.parent` is the window itself, so its postMessage is the host's.
    win.postMessage = ((message: { type?: unknown }) => {
      if (message.type === "backdrop") posts.push(message);
    }) as typeof win.postMessage;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the generated frame script
    const run = new Function(
      "window",
      "document",
      "CustomEvent",
      buildArtifactBridgeScript("dark", null, {
        themeName: "dark",
        variables: { "--xum-bg": "#100f0f" },
      })
    ) as (window: unknown, document: unknown, customEvent: unknown) => void;
    run(win, win.document, win.CustomEvent);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    win.dispatchEvent(new win.Event("load"));
    await settle();
    const sendTheme = async (bg: string) => {
      win.dispatchEvent(
        new win.MessageEvent("message", {
          data: { xumArtifact: 1, type: "theme", theme: "light", variables: { "--xum-bg": bg } },
          source: win as never,
        })
      );
      await settle();
    };
    return { win, posts, sendTheme, close: () => win.happyDOM.close() };
  }
  const posted = (color: string | null) => ({ xumArtifact: 1, type: "backdrop", color });

  test("reports the root background, else the body's, else null", async () => {
    for (const [html, color] of [
      ["<style>html { background: #123456 } body { background: red }</style>", "#123456"],
      ['<body style="background-color: red"><p>hi</p></body>', "red"],
      ['<style>html { background: rgba(0, 0, 0, 0) }</style><body style="background: red">', "red"],
      // A root image keeps the body's background off the canvas (CSS background propagation).
      [
        "<style>html { background-image: linear-gradient(transparent, blue) } body { background: red }</style>",
        null,
      ],
      ["<p>no background</p>", null],
    ] as const) {
      const page = await runWithPage(html);
      expect(page.posts).toEqual([posted(color)]);
      await page.close();
    }
  });

  test("follows a theme change, posting only when the color changed", async () => {
    const page = await runWithPage("<style>html { background: var(--xum-bg) }</style>");
    await page.sendTheme("#fffcf0");
    await page.sendTheme("#fffcf0");
    expect(page.posts).toEqual([posted("#100f0f"), posted("#fffcf0")]);
    await page.close();
  });

  test("reads the color again after a theme listener's deferred restyling", async () => {
    const page = await runWithPage("<style>html { background: var(--xum-bg) }</style>");
    const root = page.win.document.documentElement;
    // A theme listener that restyles in a microtask, after the shim's synchronous read.
    page.win.addEventListener("xumthemechange", () => {
      void Promise.resolve().then(() => root.style.setProperty("background", "#223344"));
    });
    await page.sendTheme("#fffcf0");
    expect(page.posts.at(-1)).toEqual(posted("#223344"));
    await page.close();
  });
});
