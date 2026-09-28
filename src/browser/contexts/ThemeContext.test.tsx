import { GlobalWindow } from "happy-dom";

// Setup basic DOM environment for testing-library
const dom = new GlobalWindow();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocation = globalThis.location;
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).location = new URL("https://example.com/");
(global as any).console = console;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { ThemeProvider, type ThemeMode, type ThemePreference, useTheme } from "./ThemeContext";
import { UI_THEME_KEY } from "@/common/constants/storage";

// Unit shards run many files in one Bun process, so later files would inherit this window.
afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.location = originalLocation;
});

let prefersLight = false;
const mediaQueryListeners = new Set<(event: MediaQueryListEvent) => void>();

const mediaQueryList: MediaQueryList = {
  get matches() {
    return prefersLight;
  },
  media: "(prefers-color-scheme: light)",
  onchange: null,
  addListener: (listener: (event: MediaQueryListEvent) => void) => {
    mediaQueryListeners.add(listener);
  },
  removeListener: (listener: (event: MediaQueryListEvent) => void) => {
    mediaQueryListeners.delete(listener);
  },
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | AddEventListenerOptions
  ) => {
    if (type !== "change") {
      return;
    }

    if (typeof listener === "function") {
      mediaQueryListeners.add(listener as (event: MediaQueryListEvent) => void);
    }
  },
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    _options?: boolean | EventListenerOptions
  ) => {
    if (type !== "change") {
      return;
    }

    if (typeof listener === "function") {
      mediaQueryListeners.delete(listener as (event: MediaQueryListEvent) => void);
    }
  },
  dispatchEvent: (_event: Event) => true,
};

function setSystemTheme(theme: "light" | "dark") {
  prefersLight = theme === "light";

  const event = new dom.window.MediaQueryListEvent("change", {
    matches: prefersLight,
    media: mediaQueryList.media,
  }) as unknown as MediaQueryListEvent;

  for (const listener of mediaQueryListeners) {
    listener(event);
  }

  mediaQueryList.onchange?.call(mediaQueryList, event);
}

const mockMatchMedia = mock(() => mediaQueryList);

const TestComponent = () => {
  const { theme, themePreference, toggleTheme, setTheme } = useTheme();

  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <span data-testid="theme-preference">{themePreference}</span>
      <button onClick={toggleTheme} data-testid="toggle-btn">
        Toggle
      </button>
      <button onClick={() => setTheme("auto")} data-testid="set-auto-btn">
        Auto
      </button>
      <button onClick={() => setTheme("flexoki-dark")} data-testid="set-flexoki-dark-btn">
        Flexoki Dark
      </button>
    </div>
  );
};

describe("ThemeContext", () => {
  beforeEach(() => {
    prefersLight = false;
    mediaQueryListeners.clear();
    mockMatchMedia.mockClear();

    window.matchMedia = mockMatchMedia;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  test("defaults to auto preference and resolves theme from system", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(getByTestId("theme-preference").textContent).toBe("auto");
    expect(getByTestId("theme-value").textContent).toBe("dark");
  });

  test("normalizes invalid stored preferences to auto", () => {
    window.localStorage.setItem(UI_THEME_KEY, JSON.stringify("totally-invalid"));

    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(getByTestId("theme-preference").textContent).toBe("auto");
    expect(JSON.parse(window.localStorage.getItem(UI_THEME_KEY)!)).toBe("auto");
  });

  test("follows OS theme changes while preference is auto", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(getByTestId("theme-preference").textContent).toBe("auto");
    expect(getByTestId("theme-value").textContent).toBe("dark");

    act(() => {
      setSystemTheme("light");
    });

    expect(getByTestId("theme-value").textContent).toBe("light");

    act(() => {
      setSystemTheme("dark");
    });

    expect(getByTestId("theme-value").textContent).toBe("dark");
  });

  test("stops following OS changes when a manual theme is selected", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    fireEvent.click(getByTestId("set-flexoki-dark-btn"));
    expect(getByTestId("theme-preference").textContent).toBe("flexoki-dark");
    expect(getByTestId("theme-value").textContent).toBe("flexoki-dark");

    act(() => {
      setSystemTheme("light");
    });

    expect(getByTestId("theme-value").textContent).toBe("flexoki-dark");
  });

  test("switching from manual to auto resolves using the current system theme immediately", () => {
    const renderLog: Array<{ theme: ThemeMode; themePreference: ThemePreference }> = [];

    const ThemeProbe = () => {
      const { theme, themePreference } = useTheme();
      renderLog.push({ theme, themePreference });
      return null;
    };

    const { getByTestId } = render(
      <ThemeProvider>
        <ThemeProbe />
        <TestComponent />
      </ThemeProvider>
    );

    fireEvent.click(getByTestId("set-flexoki-dark-btn"));

    act(() => {
      setSystemTheme("light");
    });

    expect(getByTestId("theme-value").textContent).toBe("flexoki-dark");

    const renderLogStartIndex = renderLog.length;
    fireEvent.click(getByTestId("set-auto-btn"));

    const autoRendersAfterSwitch = renderLog
      .slice(renderLogStartIndex)
      .filter((entry) => entry.themePreference === "auto");

    expect(autoRendersAfterSwitch.length).toBeGreaterThan(0);
    expect(autoRendersAfterSwitch[0]?.theme).toBe("light");
    expect(getByTestId("theme-preference").textContent).toBe("auto");
    expect(getByTestId("theme-value").textContent).toBe("light");
  });

  test("cycle toggle uses manual themes only", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(getByTestId("theme-preference").textContent).toBe("auto");

    fireEvent.click(getByTestId("toggle-btn"));

    // Auto resolves to dark by default in this test, so the next manual theme is flexoki-light.
    expect(getByTestId("theme-preference").textContent).toBe("flexoki-light");
    expect(getByTestId("theme-value").textContent).toBe("flexoki-light");
  });

  test("respects forcedTheme prop", () => {
    const { getByTestId, rerender } = render(
      <ThemeProvider forcedTheme="light">
        <TestComponent />
      </ThemeProvider>
    );
    expect(getByTestId("theme-value").textContent).toBe("light");

    rerender(
      <ThemeProvider forcedTheme="dark">
        <TestComponent />
      </ThemeProvider>
    );
    expect(getByTestId("theme-value").textContent).toBe("dark");
  });
});
