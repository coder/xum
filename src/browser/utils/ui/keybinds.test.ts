import { afterEach, describe, it, expect, test } from "bun:test";
import { isMac, matchesKeybind, isKeybindDeprecated, KEYBINDS } from "./keybinds";
import type { Keybind } from "@/common/types/keybind";

// Many tests below swap in a stub `window` ({ api: { platform } }) without restoring it.
// Bun shares globals across test files in a process, so the stub leaked into later files:
// mermaid's module init saw `document` defined but a window without addEventListener,
// threw, and every later importer of MarkdownComponents hit a TDZ ReferenceError.
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.navigator = originalNavigator;
});

// Helper to create a minimal keyboard event
function createEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    key: "a",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("COPY_MARKDOWN keybind", () => {
  test("accepts M without modifiers and rejects modified keys", () => {
    expect(matchesKeybind(createEvent({ key: "m" }), KEYBINDS.COPY_MARKDOWN)).toBe(true);
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
      expect(
        matchesKeybind(createEvent({ key: "M", [modifier]: true }), KEYBINDS.COPY_MARKDOWN)
      ).toBe(false);
    }
  });
});

describe("isMac", () => {
  it("falls back to navigator.platform when Electron API is missing", () => {
    const originalWindow = globalThis.window;
    const originalNavigator = globalThis.navigator;

    // Simulate browser mode on macOS (no Electron preload API)
    globalThis.window = {} as unknown as Window & typeof globalThis;
    globalThis.navigator = {
      platform: "MacIntel",
      userAgent: "Mozilla/5.0",
    } as unknown as Navigator;

    expect(isMac()).toBe(true);

    // Ctrl-style keybinds should match Cmd (Meta) on macOS
    const event = createEvent({ key: "P", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE)).toBe(true);

    globalThis.window = originalWindow;
    globalThis.navigator = originalNavigator;
  });
});

describe("CYCLE_MODEL keybind (Ctrl+/)", () => {
  it("matches Ctrl+/ on Linux/Windows", () => {
    // Mock non-Mac platform
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "/", ctrlKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("matches Cmd+/ on macOS", () => {
    // Mock Mac platform
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "/", metaKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("matches Ctrl+/ on macOS (either behavior)", () => {
    // Mock Mac platform
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "/", ctrlKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("does not match just /", () => {
    const event = createEvent({ key: "/" });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(false);
  });

  it("does not match Ctrl+? (shifted /)", () => {
    const event = createEvent({ key: "?", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(false);
  });
});

describe("CYCLE_AGENT keybind (Ctrl/Cmd+.)", () => {
  it("matches Cmd+. on macOS via the Period key code", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: ".", code: "Period", metaKey: true });
    expect(matchesKeybind(event, KEYBINDS.CYCLE_AGENT)).toBe(true);
  });

  it("matches Cmd+Shift+Period on layouts where Period requires Shift", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: ">", code: "Period", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.CYCLE_AGENT)).toBe(true);
  });
});

describe("thinking adjustment keybinds (Ctrl/Cmd+Shift+[ and ])", () => {
  it("INCREASE_THINKING matches Ctrl+Shift+] via the BracketRight code", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    // Shift turns "]" into "}", so matching must key off event.code, not event.key.
    const event = createEvent({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.INCREASE_THINKING)).toBe(true);
  });

  it("DECREASE_THINKING matches Cmd+Shift+[ via the BracketLeft code on macOS", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.DECREASE_THINKING)).toBe(true);
  });

  it("requires Shift (plain Ctrl+] does not increase)", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "]", code: "BracketRight", ctrlKey: true });
    expect(matchesKeybind(event, KEYBINDS.INCREASE_THINKING)).toBe(false);
  });

  it("does not collide with NAVIGATE_BACK/FORWARD (which omit Shift)", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    // Ctrl+[ (history back) must not trigger a thinking decrease...
    const back = createEvent({ key: "[", code: "BracketLeft", ctrlKey: true });
    expect(matchesKeybind(back, KEYBINDS.NAVIGATE_BACK)).toBe(true);
    expect(matchesKeybind(back, KEYBINDS.DECREASE_THINKING)).toBe(false);
    // ...and Ctrl+Shift+[ (thinking decrease) must not trigger history back.
    const decrease = createEvent({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(decrease, KEYBINDS.DECREASE_THINKING)).toBe(true);
    expect(matchesKeybind(decrease, KEYBINDS.NAVIGATE_BACK)).toBe(false);
  });
});

describe("isKeybindDeprecated", () => {
  it("flags the legacy TOGGLE_THINKING cycle but not the directional keybinds", () => {
    expect(isKeybindDeprecated(KEYBINDS.TOGGLE_THINKING)).toBe(true);
    expect(isKeybindDeprecated(KEYBINDS.INCREASE_THINKING)).toBe(false);
    expect(isKeybindDeprecated(KEYBINDS.DECREASE_THINKING)).toBe(false);
  });
});

test("removed auto agent toggle keybind", () => {
  const removedKey = ["TOGGLE", "AUTO", "AGENT"].join("_");
  expect(KEYBINDS).not.toHaveProperty(removedKey);
});

describe("SEND_MESSAGE_AFTER_TURN keybind (Ctrl/Cmd+Enter)", () => {
  it("matches Ctrl+Enter", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter", ctrlKey: true, metaKey: false });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(true);
  });

  it("matches Cmd+Enter on macOS", () => {
    globalThis.window = { api: { platform: "darwin" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter", metaKey: true, ctrlKey: false });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(true);
  });

  it("does not match plain Enter", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter" });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(false);
  });

  it("SEND_MESSAGE does not match Ctrl+Enter", () => {
    globalThis.window = { api: { platform: "linux" } } as unknown as Window & typeof globalThis;
    const event = createEvent({ key: "Enter", ctrlKey: true });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE)).toBe(false);
  });
});

describe("matchesKeybind", () => {
  describe("FOCUS_REVIEW_SEARCH_QUICK keybind (/)", () => {
    it("matches Shift+/ when event.key is /", () => {
      const event = createEvent({ key: "/", shiftKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(true);
    });

    it("matches plain /", () => {
      const event = createEvent({ key: "/" });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(true);
    });

    it("does not match Ctrl+/", () => {
      const event = createEvent({ key: "/", ctrlKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(false);
    });

    it("does not match Cmd+/", () => {
      const event = createEvent({ key: "/", metaKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(false);
    });
  });

  it("should return false when event.key is undefined", () => {
    // This can happen with dead keys, modifier-only events, etc.
    const event = createEvent({ key: undefined as unknown as string });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should return false when event.key is empty string", () => {
    const event = createEvent({ key: "" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match simple key press", () => {
    const event = createEvent({ key: "a" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match case-insensitively", () => {
    const event = createEvent({ key: "A" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should not match different key", () => {
    const event = createEvent({ key: "b" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match Ctrl+key combination", () => {
    const event = createEvent({ key: "n", ctrlKey: true });
    const keybind: Keybind = { key: "n", ctrl: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should not match when Ctrl is required but not pressed", () => {
    const event = createEvent({ key: "n", ctrlKey: false });
    const keybind: Keybind = { key: "n", ctrl: true };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should not match when Ctrl is pressed but not required", () => {
    const event = createEvent({ key: "n", ctrlKey: true });
    const keybind: Keybind = { key: "n" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match Shift+key combination", () => {
    const event = createEvent({ key: "G", shiftKey: true });
    const keybind: Keybind = { key: "G", shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match Alt+key combination", () => {
    const event = createEvent({ key: "a", altKey: true });
    const keybind: Keybind = { key: "a", alt: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match Ctrl/Cmd+Shift+P for OPEN_COMMAND_PALETTE", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });

    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE)).toBe(true);
  });

  it("should match F4 for OPEN_COMMAND_PALETTE_ACTIONS", () => {
    const event = createEvent({ key: "F4" });

    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)).toBe(true);
  });

  it("should match complex multi-modifier combination", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });
    const keybind: Keybind = { key: "P", ctrl: true, shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });
});

describe("TOGGLE_NOTIFICATIONS keybind (Ctrl/Cmd+Shift+Comma)", () => {
  test("matches the physical comma key when Shift turns it into <", () => {
    const event = createEvent({ key: "<", code: "Comma", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.TOGGLE_NOTIFICATIONS)).toBe(true);
    // Ctrl/Cmd+Comma without Shift stays Open Settings.
    expect(
      matchesKeybind(
        createEvent({ key: ",", code: "Comma", ctrlKey: true }),
        KEYBINDS.TOGGLE_NOTIFICATIONS
      )
    ).toBe(false);
  });
});

describe("global keybind collisions", () => {
  // Bindings handled by window-level listeners that are live at the same time while a
  // workspace is open. Two of these matching the same keystroke makes the winner depend on
  // listener order (Ctrl/Cmd+Shift+N was once both "New scratch chat" and
  // "Toggle notifications"). Add new window-level bindings here. Scoped bindings are left out on purpose because they only fire
  // while their surface has focus and may reuse global keys: Review panel / immersive review,
  // Artifacts panel, background-process rows, composer-only send/edit keys, dialogs, image
  // lightbox, plan annotation, Settings → Backup, and vim interrupt.
  const GLOBAL_KEYBIND_NAMES = [
    "TOGGLE_AGENT",
    "CYCLE_AGENT",
    "RESUME_STREAM",
    "NEW_WORKSPACE",
    "NEW_SCRATCH_CHAT",
    "EDIT_WORKSPACE_TITLE",
    "GENERATE_WORKSPACE_TITLE",
    "ARCHIVE_WORKSPACE",
    "PIN_WORKSPACE",
    "MOVE_PINNED_UP",
    "MOVE_PINNED_DOWN",
    "JUMP_TO_BOTTOM",
    "LOAD_OLDER_MESSAGES",
    "NEXT_WORKSPACE",
    "PREV_WORKSPACE",
    "TOGGLE_SIDEBAR",
    "CYCLE_MODEL",
    "OPEN_TERMINAL",
    "OPEN_IN_EDITOR",
    "CONFIGURE_MCP",
    "CONFIGURE_HEARTBEAT",
    "CONFIGURE_UNRELATED_MESSAGING",
    "OPEN_COMMAND_PALETTE",
    "OPEN_COMMAND_PALETTE_ACTIONS",
    "TOGGLE_THINKING",
    "INCREASE_THINKING",
    "DECREASE_THINKING",
    "TOGGLE_FAST_MODE",
    "FOCUS_BACKGROUND_PROCESSES",
    "FOCUS_CHAT",
    "CLOSE_TAB",
    "OPEN_TIMELINE_DIALOG",
    "OPEN_ARTIFACTS_TAB",
    "SIDEBAR_TAB_1",
    "SIDEBAR_TAB_2",
    "SIDEBAR_TAB_3",
    "SIDEBAR_TAB_4",
    "SIDEBAR_TAB_5",
    "SIDEBAR_TAB_6",
    "SIDEBAR_TAB_7",
    "SIDEBAR_TAB_8",
    "SIDEBAR_TAB_9",
    "OPEN_SETTINGS",
    "OPEN_SERVER_WINDOW",
    "OPEN_ANALYTICS",
    "REPORT_SLOWNESS",
    "SAVE_SESSION_TAPES",
    "REVEAL_SESSION_TAPES",
    "TOGGLE_VOICE_INPUT",
    "NAVIGATE_BACK",
    "NAVIGATE_FORWARD",
    "TOGGLE_NOTIFICATIONS",
    "TOGGLE_DRIFT_MODE",
    "SHOW_WORKSPACE_DETAILS",
    "SHOW_LAST_PROMPT",
    "TOGGLE_POWER_MODE",
  ] as const satisfies ReadonlyArray<keyof typeof KEYBINDS>;

  const PUNCTUATION_CODES: Record<string, string> = {
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    "[": "BracketLeft",
    "]": "BracketRight",
    "=": "Equal",
    "-": "Minus",
    " ": "Space",
  };

  // Physical key for a binding, so a key-matched binding and a code-matched binding on the
  // same physical key are compared on equal terms.
  function codeFor(keybind: Keybind): string {
    if (keybind.code) return keybind.code;
    if (/^[a-z]$/i.test(keybind.key)) return `Key${keybind.key.toUpperCase()}`;
    if (/^[0-9]$/.test(keybind.key)) return `Digit${keybind.key}`;
    return PUNCTUATION_CODES[keybind.key] ?? keybind.key;
  }

  // Every keystroke (both key cases, all 16 modifier combinations) that `keybind` accepts on
  // the current platform. Comparing through matchesKeybind keeps macCtrlBehavior, allowShift
  // and code-vs-key matching in one place instead of re-deriving them here.
  function acceptedEvents(keybind: Keybind): KeyboardEvent[] {
    const events: KeyboardEvent[] = [];
    const keys = new Set([keybind.key, keybind.key.toLowerCase(), keybind.key.toUpperCase()]);
    for (const key of keys) {
      for (let mask = 0; mask < 16; mask++) {
        const event = createEvent({
          key,
          code: codeFor(keybind),
          ctrlKey: (mask & 1) !== 0,
          shiftKey: (mask & 2) !== 0,
          altKey: (mask & 4) !== 0,
          metaKey: (mask & 8) !== 0,
        });
        if (matchesKeybind(event, keybind)) events.push(event);
      }
    }
    return events;
  }

  function findCollisions(bindings: ReadonlyArray<readonly [string, Keybind]>): string[] {
    const collisions: string[] = [];
    for (let i = 0; i < bindings.length; i++) {
      const [nameA, a] = bindings[i];
      const events = acceptedEvents(a);
      expect(events.length).toBeGreaterThan(0);
      for (let j = i + 1; j < bindings.length; j++) {
        const [nameB, b] = bindings[j];
        if (events.some((event) => matchesKeybind(event, b))) {
          collisions.push(`${nameA} <-> ${nameB}`);
        }
      }
    }
    return collisions;
  }

  const platforms = [
    ["macOS", "darwin"],
    ["Linux/Windows", "linux"],
  ] as const;

  for (const [label, platform] of platforms) {
    test(`no two global bindings accept the same keystroke on ${label}`, () => {
      globalThis.window = { api: { platform } } as unknown as Window & typeof globalThis;
      expect(isMac()).toBe(platform === "darwin");

      const bindings = GLOBAL_KEYBIND_NAMES.map((name) => [name, KEYBINDS[name]] as const);
      expect(findCollisions(bindings)).toEqual([]);
    });

    test(`collision check catches keys that differ only by case on ${label}`, () => {
      globalThis.window = { api: { platform } } as unknown as Window & typeof globalThis;

      expect(
        findCollisions([
          ["lower", { key: "n", ctrl: true, shift: true }],
          ["upper", { key: "N", ctrl: true, shift: true }],
        ])
      ).toEqual(["lower <-> upper"]);
    });
  }
});
