// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIContext } from "@/browser/contexts/API";
import { CoderCanonicalRoutes } from "./CoderCanonicalRoutes";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

describe("CoderCanonicalRoutes while reconnecting", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // After the switch the last client stays while Xum reconnects. A write through it fails, and
  // an optimistic route would look saved: the card must use the live client and write nothing.
  test("disables its server actions and writes nothing with a kept client", () => {
    const client = setupSettingsStory({ providersConfig: {} });
    let refreshCalls = 0;
    Object.assign(client, {
      coderOauth: {
        ...(client as { coderOauth?: object }).coderOauth,
        refreshProviders: () => {
          refreshCalls++;
          return Promise.resolve({ success: true as const, data: undefined });
        },
      },
    });
    const offline = {
      status: "reconnecting" as const,
      api: client,
      error: null,
      attempt: 1,
      authenticate: () => undefined,
      retry: () => undefined,
    };
    const view = render(
      <SettingsSectionStory setup={() => client}>
        <APIContext.Provider value={offline}>
          <CoderCanonicalRoutes />
        </APIContext.Provider>
      </SettingsSectionStory>
    );

    const refresh = view.getByRole("button", { name: "Refresh providers" }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    fireEvent.click(refresh);
    expect(refreshCalls).toBe(0);
  });
});
