/**
 * The server's static first-run view must match the live wizard's gateway step (T3 #5971, C step 2,
 * plan section 5.6, PR 2). The live wizard replaces the static copy in one commit, so any drift in
 * tags, classes or text shows as a jump at handoff. Catches, for example, a class changed on the
 * live step (OnboardingWizardSplash) without the same change in FIRST_RUN_VIEW_HTML.
 *
 * The test renders OnboardingWizardSplash directly: SplashScreenProvider shows no splash in test
 * mode (DISABLE_SPLASH_SCREENS, SplashScreens/index.ts).
 */
import "../dom";
import React from "react";
import { act, cleanup, render } from "@testing-library/react";

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
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import { FIRST_RUN_VIEW_HTML } from "@/node/orpc/firstRunView";

/** Every element in document order: tag, class attribute and its own text, whitespace-collapsed. */
function shape(root: Element): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return [root, ...Array.from(root.querySelectorAll("*"))].map((el) => {
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join("");
    return `<${el.tagName.toLowerCase()} class="${norm(el.getAttribute("class") ?? "")}">${norm(text)}`;
  });
}

/** Parses the constant the way the page will: from a <template>, cloned with content.cloneNode. */
function staticView(): HTMLElement {
  const doc = new DOMParser().parseFromString(
    `<template>${FIRST_RUN_VIEW_HTML}</template>`,
    "text/html"
  );
  const fragment = doc.querySelector("template")!.content.cloneNode(true) as DocumentFragment;
  expect(fragment.children).toHaveLength(1);
  return document.importNode(fragment.firstElementChild!, true) as HTMLElement;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

test("the static view is one inert element with the shared id and no main landmark", () => {
  const view = staticView();
  expect(view.id).toBe(FIRST_RUN_VIEW_ID);
  expect(view.hasAttribute("inert")).toBe(true);
  expect(view.querySelector("main")).toBeNull(); // the boot loader's <main> stays the only one
});

test("the static view matches the live gateway step's overlay and dialog", () => {
  const view = staticView();
  const expected = (selector: string) => shape(view.querySelector(selector)!);
  const staticOverlay = expected("[data-modal-dialog-overlay]");
  const staticDialog = expected("[role=dialog]");

  // Under the static view, the live wizard opens on the gateway step and removes it (PR 1).
  document.body.append(view);
  mockProviders = { config: null, loading: true };
  const wizard = () => React.createElement(OnboardingWizardSplash, { onDismiss: jest.fn() });
  const rendered = render(wizard());
  mockProviders = { config: {}, loading: false };
  act(() => rendered.rerender(wizard()));
  expect(document.getElementById(FIRST_RUN_VIEW_ID)).toBeNull();

  const live = (selector: string) => shape(document.body.querySelector(selector)!);
  expect(live("[data-modal-dialog-overlay]")).toEqual(staticOverlay);
  expect(live("[role=dialog]")).toEqual(staticDialog);
});
