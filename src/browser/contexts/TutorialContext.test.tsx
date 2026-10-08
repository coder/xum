import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useEffect } from "react";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import * as RealTutorialTooltipModule from "@/browser/components/TutorialTooltip/TutorialTooltip";
import * as RealSplashScreenProviderModule from "@/browser/features/SplashScreens/SplashScreenProvider";
import { restoreModulesAfterSuite } from "../../../tests/ui/moduleMocks";

// Restore the real modules after this suite so the stubs below cannot leak into later files.
restoreModulesAfterSuite([
  ["@/browser/components/TutorialTooltip/TutorialTooltip", { ...RealTutorialTooltipModule }],
  ["@/browser/features/SplashScreens/SplashScreenProvider", { ...RealSplashScreenProviderModule }],
]);
void mock.module("@/browser/components/TutorialTooltip/TutorialTooltip", () => ({
  TutorialTooltip: (props: {
    step: { title: string };
    onDismiss: () => void;
    onDisableTutorial: () => void;
  }) => (
    <div data-testid="tutorial-tooltip">
      {props.step.title}
      <button data-testid="tutorial-dismiss" onClick={props.onDismiss} />
      <button data-testid="tutorial-disable" onClick={props.onDisableTutorial} />
    </div>
  ),
}));

void mock.module("@/browser/features/SplashScreens/SplashScreenProvider", () => ({
  useIsSplashScreenActive: () => false,
}));

import { TutorialProvider, resolveTutorialSandboxOptIn, useTutorial } from "./TutorialContext";

function TutorialHarness() {
  const tutorial = useTutorial();

  return (
    <div>
      <button data-testid="start-creation" onClick={() => tutorial.startSequence("creation")}>
        Start creation
      </button>
      <span data-testid="tutorial-disabled">{String(tutorial.isTutorialDisabled())}</span>
    </div>
  );
}

describe("TutorialContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalNavigator: typeof globalThis.navigator;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalGetComputedStyle: typeof globalThis.getComputedStyle;
  let originalStorageEvent: unknown;
  let originalCustomEvent: unknown;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalNavigator = globalThis.navigator;
    originalLocalStorage = globalThis.localStorage;
    originalGetComputedStyle = globalThis.getComputedStyle;
    originalStorageEvent = (globalThis as Record<string, unknown>).StorageEvent;
    originalCustomEvent = (globalThis as Record<string, unknown>).CustomEvent;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.navigator = dom.navigator as unknown as Navigator;
    globalThis.localStorage = dom.localStorage;
    globalThis.getComputedStyle = dom.getComputedStyle.bind(
      dom
    ) as unknown as typeof getComputedStyle;

    const domGlobals = globalThis as Record<string, unknown>;
    domGlobals.StorageEvent = dom.StorageEvent;
    domGlobals.CustomEvent = dom.CustomEvent;

    window.localStorage.clear();
    getAppConfigStore().updateOptimistically({ userPreferences: {} });
    delete window.api;
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = undefined;
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
    mock.restore();
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = undefined;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.localStorage = originalLocalStorage;
    globalThis.navigator = originalNavigator;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;

    const domGlobals = globalThis as Record<string, unknown>;
    domGlobals.StorageEvent = originalStorageEvent;
    domGlobals.CustomEvent = originalCustomEvent;
  });

  test("resolveTutorialSandboxOptIn returns undefined when neither transport provides an override", () => {
    expect(
      resolveTutorialSandboxOptIn({
        preloadEnableTutorialsInSandbox: undefined,
        browserEnableTutorialsInSandbox: undefined,
      })
    ).toBeUndefined();
  });

  test("resolveTutorialSandboxOptIn prefers preload over the browser fallback", () => {
    expect(
      resolveTutorialSandboxOptIn({
        preloadEnableTutorialsInSandbox: false,
        browserEnableTutorialsInSandbox: true,
      })
    ).toBe(false);
    expect(
      resolveTutorialSandboxOptIn({
        preloadEnableTutorialsInSandbox: undefined,
        browserEnableTutorialsInSandbox: true,
      })
    ).toBe(true);
  });

  test("keeps normal tutorial behavior when no sandbox override is present", async () => {
    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("false");

    fireEvent.click(view.getByTestId("start-creation"));

    await waitFor(() => {
      expect(view.getByTestId("tutorial-tooltip")).toBeTruthy();
    });
  });

  test.each(["tutorial-dismiss", "tutorial-disable"])(
    "%s keeps the tutorial closed when the store refuses the save",
    (button) => {
      // No API client: the store refuses the write, as after a disconnect.
      function AutoStart() {
        const { startSequence } = useTutorial();
        useEffect(() => {
          startSequence("creation");
        }, [startSequence]);
        return null;
      }
      const view = render(
        <TutorialProvider>
          <AutoStart />
        </TutorialProvider>
      );
      expect(view.getByTestId("tutorial-tooltip")).toBeTruthy();

      fireEvent.click(view.getByTestId(button));
      expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
    }
  );

  test("starts no tutorial before the saved preferences load", async () => {
    getAppConfigStore().updateOptimistically({ userPreferences: undefined });
    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    fireEvent.click(view.getByTestId("start-creation"));
    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();

    act(() => getAppConfigStore().updateOptimistically({ userPreferences: {} }));
    fireEvent.click(view.getByTestId("start-creation"));
    await waitFor(() => {
      expect(view.getByTestId("tutorial-tooltip")).toBeTruthy();
    });
  });

  test("browser sandbox default blocks tutorials without persisting a forced disable", () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = false;
    const updateUserPreferences = spyOn(getAppConfigStore(), "updateUserPreferences");

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("true");
    fireEvent.click(view.getByTestId("start-creation"));

    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
    expect(updateUserPreferences).not.toHaveBeenCalled();
  });

  test("browser sandbox opt-in restores the tutorial flow", async () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = true;

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("false");
    fireEvent.click(view.getByTestId("start-creation"));

    await waitFor(() => {
      expect(view.getByTestId("tutorial-tooltip")).toBeTruthy();
    });
  });

  test("preload override takes precedence over the browser fallback", () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = true;
    window.api = {
      platform: "linux",
      versions: {},
      enableTutorialsInSandbox: false,
    };

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("true");
    fireEvent.click(view.getByTestId("start-creation"));
    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
  });

  test("persisted tutorial disables still win over sandbox opt-in", () => {
    globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__ = true;
    getAppConfigStore().updateOptimistically({
      userPreferences: { ui: { tutorialState: { disabled: true } } },
    });

    const view = render(
      <TutorialProvider>
        <TutorialHarness />
      </TutorialProvider>
    );

    expect(view.getByTestId("tutorial-disabled").textContent).toBe("true");
    fireEvent.click(view.getByTestId("start-creation"));
    expect(view.queryByTestId("tutorial-tooltip")).toBeNull();
  });
});
