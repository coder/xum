import "../../../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { DaytonaAccessForm } from "./DaytonaSettingsForms";

describe("DaytonaAccessForm", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  const ENV_CONFIG: DaytonaPublicConfig = {
    apiKeySet: false,
    apiKeySource: null,
    // From DAYTONA_API_URL: storing it would override later changes to the environment.
    apiUrl: "https://daytona.internal.example/api",
    target: null,
  };

  /** Renders the form, runs `edit`, presses Save, and returns what was sent. */
  async function saveAfter(
    edit: (
      fields: { key: HTMLElement; url: HTMLElement },
      user: ReturnType<typeof userEvent.setup>
    ) => Promise<void>
  ) {
    const setConfig = mock((input: Record<string, string>) =>
      Promise.resolve({ ...ENV_CONFIG, apiKeySet: input.apiKey !== undefined })
    );
    const client = createTestApiClient({
      daytona: { getConfig: () => Promise.resolve(ENV_CONFIG), setConfig },
    });
    const view = render(
      <APIProvider client={client}>
        <DaytonaAccessForm />
      </APIProvider>
    );
    const key = await waitFor(() => {
      const input = view.getByLabelText("API key");
      expect((input as HTMLInputElement).disabled).toBe(false);
      return input;
    });
    const user = userEvent.setup({ document: key.ownerDocument });
    await edit({ key, url: view.getByLabelText("API URL") }, user);
    await user.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    return setConfig.mock.calls[0][0];
  }

  test("saving only a new key leaves the URL from the environment unsaved", async () => {
    const sent = await saveAfter((fields, user) => user.type(fields.key, "new-key"));
    expect(sent).toEqual({ apiKey: "new-key" });
  });

  test("saves a URL the user edited", async () => {
    const sent = await saveAfter(async (fields, user) => {
      await user.clear(fields.url);
      await user.type(fields.url, "https://other.example/api");
    });
    expect(sent).toEqual({ apiUrl: "https://other.example/api" });
  });
});
