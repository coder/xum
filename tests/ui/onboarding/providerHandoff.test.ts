/**
 * SplashScreenProvider and the static first-run view (T3 #5971, C step 2): every queue in which the
 * wizard is not first removes #xum-pre, and a viewed wizard sets the early script's paint cache.
 */
import "../dom";
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const mockApi = {
  splashScreens: {
    getViewedSplashScreens: jest.fn<Promise<string[]>, []>(),
    markSplashScreenViewed: jest.fn(() => Promise.resolve()),
  },
};
let mockApiReady = true;
let mockOtherSplashFirst = false;

jest.mock("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: mockApiReady ? mockApi : null }),
}));
jest.mock("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({ registerOnClose: () => () => undefined }),
}));
jest.mock("@/browser/features/SplashScreens/index", () => {
  const actual = jest.requireActual<typeof import("@/browser/features/SplashScreens/index")>(
    "@/browser/features/SplashScreens/index"
  );
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  const splash = (id: string, priority: number) => ({
    id,
    priority,
    component: (props: { onDismiss: () => void }) =>
      createElement("button", { onClick: props.onDismiss }, `splash ${id}`),
  });
  return {
    ...actual,
    // Test mode turns splash screens off (index.ts), and this suite needs them on.
    DISABLE_SPLASH_SCREENS: false,
    get SPLASH_REGISTRY() {
      const wizard = splash(actual.ONBOARDING_WIZARD_SPLASH_ID, 5);
      return mockOtherSplashFirst ? [wizard, splash("other", 6)] : [wizard];
    },
  };
});

import { SplashScreenProvider } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { ONBOARDING_WIZARD_SPLASH_ID } from "@/browser/features/SplashScreens/index";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { ONBOARDING_VIEWED_KEY } from "@/common/constants/storage";

const firstRunView = () => document.getElementById("xum-pre");
const viewedCached = () => readPersistedState(ONBOARDING_VIEWED_KEY, false);

async function renderProvider() {
  const view = render(React.createElement(SplashScreenProvider, null, "app"));
  await act(async () => await Promise.resolve());
  return view;
}

beforeEach(() => {
  const view = document.createElement("div");
  view.id = "xum-pre";
  document.body.append(view);
  localStorage.clear();
  mockApiReady = true;
  mockOtherSplashFirst = false;
  mockApi.splashScreens.getViewedSplashScreens.mockResolvedValue([]);
  jest.spyOn(console, "error").mockImplementation(() => undefined); // the failed-read row logs
});

afterEach(() => {
  jest.restoreAllMocks();
  cleanup();
  document.body.innerHTML = "";
});

test("keeps the static view while the wizard is first in the queue", async () => {
  await renderProvider();
  expect(firstRunView()).not.toBeNull();
  expect(viewedCached()).toBe(false);
});

test.each([
  [
    "the wizard was viewed",
    () =>
      mockApi.splashScreens.getViewedSplashScreens.mockResolvedValue([ONBOARDING_WIZARD_SPLASH_ID]),
  ],
  [
    "the viewed list cannot be read",
    () => mockApi.splashScreens.getViewedSplashScreens.mockRejectedValue(new Error("read failed")),
  ],
  ["another splash comes first", () => (mockOtherSplashFirst = true)],
  ["there is no API", () => (mockApiReady = false)],
])("removes the static view when %s", async (_name, arrange) => {
  arrange();
  await renderProvider();
  expect(firstRunView()).toBeNull();
});

test("caches a viewed wizard for the early script, on load and on dismiss", async () => {
  mockApi.splashScreens.getViewedSplashScreens.mockResolvedValue([ONBOARDING_WIZARD_SPLASH_ID]);
  await renderProvider();
  expect(viewedCached()).toBe(true);
  cleanup();

  localStorage.clear();
  mockApi.splashScreens.getViewedSplashScreens.mockResolvedValue([]);
  const view = await renderProvider();
  expect(viewedCached()).toBe(false);
  fireEvent.click(view.getByText(`splash ${ONBOARDING_WIZARD_SPLASH_ID}`));
  await act(async () => await Promise.resolve());
  expect(viewedCached()).toBe(true);
});

// Catches the cache write moving out of markViewed's try (for example to after
// `if (!(await markViewed(...))) return;` in dismiss): markViewed also returns true when the save
// failed for a reason other than a lost connection, and only a saved view may set the cache.
test.each([
  ["fails with an error other than a lost connection", false],
  ["succeeds", true],
])("on dismiss, a save that %s sets the paint cache: %s", async (_name, saved) => {
  mockApi.splashScreens.markSplashScreenViewed.mockClear();
  if (!saved) {
    mockApi.splashScreens.markSplashScreenViewed.mockRejectedValueOnce(new Error("save failed"));
  }
  const view = await renderProvider();
  fireEvent.click(view.getByText(`splash ${ONBOARDING_WIZARD_SPLASH_ID}`));
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  expect(mockApi.splashScreens.markSplashScreenViewed).toHaveBeenCalled();
  expect(viewedCached()).toBe(saved);
});
