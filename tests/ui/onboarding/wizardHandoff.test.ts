/**
 * The onboarding wizard and the static first-run view (T3 #5971, C step 2, plan section 5.6).
 * The server will put a static copy of the wizard's gateway step in #xum-pre before the app JS runs.
 * The live wizard takes over in one commit. Without #xum-pre, the wizard must render exactly as before.
 */
import "../dom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

let mockProviders: { config: Record<string, unknown> | null; loading: boolean };

jest.mock("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    ...mockProviders,
    refresh: jest.fn(),
    updateOptimistically: jest.fn(),
  }),
}));
jest.mock("@/browser/features/SplashScreens/SplashScreenProvider", () => ({
  ...jest.requireActual<typeof import("@/browser/features/SplashScreens/SplashScreenProvider")>(
    "@/browser/features/SplashScreens/SplashScreenProvider"
  ),
  useOnboardingPause: () => ({ paused: null, pause: jest.fn(), resume: jest.fn() }),
}));
jest.mock("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({ open: jest.fn(), registerOnClose: () => () => undefined }),
}));
jest.mock("@/browser/contexts/ProjectContext", () => ({
  useProjectContext: () => ({ addProject: jest.fn(), userProjects: new Map() }),
}));
// useLiveAPI is main's live-client hook (#6323): with no API it is null, like useAPI's api.
jest.mock("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null }),
  useLiveAPI: () => null,
}));
jest.mock("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({ navigateToProject: jest.fn() }),
}));
jest.mock("@/browser/hooks/useMuxGatewayAccountStatus", () => ({
  ...jest.requireActual<typeof import("@/browser/hooks/useMuxGatewayAccountStatus")>(
    "@/browser/hooks/useMuxGatewayAccountStatus"
  ),
  useMuxGatewayAccountStatus: () => ({
    data: null,
    error: null,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

import { OnboardingWizardSplash } from "@/browser/features/SplashScreens/OnboardingWizardSplash";

// Steps are found by their key (data-onboarding-step), so rewording the copy does not break these tests.
const LOADING_STEP = "loading";
const GATEWAY_STEP = "mux-gateway";

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const overlay = () => document.body.querySelector<HTMLElement>("[data-modal-dialog-overlay]");
const step = () => document.body.querySelector<HTMLElement>("[data-onboarding-step]");
const shows = (key: string) => step()?.dataset.onboardingStep === key;
const animatesIn = () =>
  step()?.className.includes("animate-in fade-in-0 slide-in-from-right-2") === true;

function renderWizard() {
  return render(React.createElement(OnboardingWizardSplash, { onDismiss: jest.fn() }));
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the onboarding wizard without a static first-run view", () => {
  test("shows its loading step, then the gateway step, with the dialog's entry animation", () => {
    mockProviders = { config: null, loading: true };
    const view = renderWizard();
    expect(shows(LOADING_STEP)).toBe(true);
    expect(dialog()?.className).toContain("data-[state=open]:zoom-in-95");
    expect(overlay()?.className).toContain("data-[state=open]:fade-in-0");
    expect(dialog()?.style.animation).toBe("");
    expect(overlay()?.style.animation).toBe("");

    mockProviders = { config: {}, loading: false };
    act(() => view.rerender(React.createElement(OnboardingWizardSplash, { onDismiss: jest.fn() })));
    expect(shows(LOADING_STEP)).toBe(false);
    expect(shows(GATEWAY_STEP)).toBe(true);
    expect(animatesIn()).toBe(true);
    expect(dialog()?.style.animation).toBe("");
  });

  test("animates each step it moves to", () => {
    mockProviders = { config: {}, loading: false };
    renderWizard();
    fireEvent.click(
      Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === "Next")!
    );
    expect(shows(GATEWAY_STEP)).toBe(false);
    expect(animatesIn()).toBe(true);
  });
});

describe("the onboarding wizard under the static first-run view (#xum-pre)", () => {
  const firstRunView = () => document.getElementById("xum-pre");
  const clickNext = () =>
    fireEvent.click(
      Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === "Next")!
    );

  beforeEach(() => {
    const view = document.createElement("div");
    view.id = "xum-pre";
    document.body.append(view);
  });

  test("never paints its loading step, and no commit shows the gateway step and the static view together", () => {
    // A Profiler's onRender runs in each commit of the wizard, after its layout effects and
    // before passive effects: the point where the browser would paint.
    const viewAtGatewayCommit: boolean[] = [];
    const onRender = () => {
      if (shows(GATEWAY_STEP)) viewAtGatewayCommit.push(firstRunView() != null);
    };
    const tree = () =>
      React.createElement(
        React.Profiler,
        { id: "wizard", onRender },
        React.createElement(OnboardingWizardSplash, { onDismiss: jest.fn() })
      );
    mockProviders = { config: null, loading: true };
    const view = render(tree());
    expect(dialog()).toBeNull();
    expect(firstRunView()).not.toBeNull();

    mockProviders = { config: {}, loading: false };
    act(() => view.rerender(tree()));
    expect(viewAtGatewayCommit.length).toBeGreaterThan(0);
    expect(viewAtGatewayCommit).not.toContain(true);
    expect(firstRunView()).toBeNull();
    // The static view showed this frame, so nothing animates in, until the user moves on.
    expect(dialog()?.style.animation).toBe("none");
    expect(overlay()?.style.animation).toBe("none");
    expect(animatesIn()).toBe(false);
    clickNext();
    expect(animatesIn()).toBe(true);
    // The dialog and overlay stay open, so dropping their override would replay their entry.
    expect(dialog()?.style.animation).toBe("none");
    expect(overlay()?.style.animation).toBe("none");
  });

  test("removes the static view when it opens past the gateway step", () => {
    mockProviders = { config: { anthropic: { isConfigured: true } }, loading: false };
    renderWizard();
    expect(shows(GATEWAY_STEP)).toBe(false);
    expect(firstRunView()).toBeNull();
  });
});
