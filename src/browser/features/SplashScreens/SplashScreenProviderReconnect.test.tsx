// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import type { TestApiOverrides } from "@/browser/testUtils";
import * as RealSplashRegistry from "@/browser/features/SplashScreens/index";

// A one-line splash instead of the onboarding wizard (and splashes on, as in the app).
restoreModulesAfterSuite([["@/browser/features/SplashScreens/index", { ...RealSplashRegistry }]]);
void mock.module("@/browser/features/SplashScreens/index", () => ({
  ...RealSplashRegistry,
  DISABLE_SPLASH_SCREENS: false,
  SPLASH_REGISTRY: [
    {
      id: "test-splash",
      priority: 1,
      component: (props: { onDismiss: () => void }) => (
        <button type="button" onClick={props.onDismiss}>
          Test splash
        </button>
      ),
    },
  ],
}));

import { SplashScreenProvider } from "./SplashScreenProvider";

let harness: ConnectionHarness;
/** What the next server's getViewedSplashScreens answers, or a promise of it. */
let serverViewed: string[] | Promise<string[]>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

// A reconnect reloads the viewed splash list through the new client. If the connection drops
// again while that reload is in flight, the lost call is no load failure: the shown splash stays.
describe.each([...GAP_MODES])("SplashScreenProvider across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverViewed = [];
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const viewed = serverViewed;
      return { splashScreens: { getViewedSplashScreens: () => Promise.resolve(viewed) } };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the shown splash when the reload is lost with the connection", async () => {
    const view = render(
      <harness.Wrapper>
        <RouterProvider>
          <SettingsProvider>
            <SplashScreenProvider>
              <span>app</span>
            </SplashScreenProvider>
          </SettingsProvider>
        </RouterProvider>
      </harness.Wrapper>
    );
    await view.findByText("Test splash");

    serverViewed = new Promise(() => undefined);
    await harness.drop();
    harness.reconnect();
    await settle();
    await harness.drop();
    await settle();

    expect(view.queryByText("Test splash")).not.toBeNull();
  });

  // Offline the view cannot be saved: the splash stays, or it would open again after the reconnect.
  test("a dismiss while offline keeps the splash", async () => {
    const view = render(
      <harness.Wrapper>
        <RouterProvider>
          <SettingsProvider>
            <SplashScreenProvider>
              <span>app</span>
            </SplashScreenProvider>
          </SettingsProvider>
        </RouterProvider>
      </harness.Wrapper>
    );
    const splash = await view.findByText("Test splash");

    await harness.drop();
    fireEvent.click(splash);
    await settle();
    expect(view.queryByText("Test splash")).not.toBeNull();
  });
});
