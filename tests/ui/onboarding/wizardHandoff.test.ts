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
jest.mock("@/browser/contexts/API", () => ({ useAPI: () => ({ api: null }) }));
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

const LOADING_TEXT = "Checking your provider configuration…";
const GATEWAY_TEXT = "OSS contributors with GitHub accounts";

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
const overlay = () => document.body.querySelector<HTMLElement>("[data-modal-dialog-overlay]");
const stepBody = () => dialog()?.querySelector<HTMLElement>("[class*='slide-in-from']") ?? null;
const showsText = (text: string) => document.body.textContent?.includes(text) === true;

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
    expect(showsText(LOADING_TEXT)).toBe(true);
    expect(dialog()?.className).toContain("data-[state=open]:zoom-in-95");
    expect(overlay()?.className).toContain("data-[state=open]:fade-in-0");
    expect(dialog()?.style.animation).toBe("");
    expect(overlay()?.style.animation).toBe("");

    mockProviders = { config: {}, loading: false };
    act(() => view.rerender(React.createElement(OnboardingWizardSplash, { onDismiss: jest.fn() })));
    expect(showsText(LOADING_TEXT)).toBe(false);
    expect(showsText(GATEWAY_TEXT)).toBe(true);
    expect(stepBody()?.className).toContain("animate-in fade-in-0 slide-in-from-right-2");
    expect(dialog()?.style.animation).toBe("");
  });

  test("animates each step it moves to", () => {
    mockProviders = { config: {}, loading: false };
    renderWizard();
    fireEvent.click(
      Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === "Next")!
    );
    expect(showsText(GATEWAY_TEXT)).toBe(false);
    expect(stepBody()?.className).toContain("animate-in fade-in-0 slide-in-from-right-2");
  });
});
