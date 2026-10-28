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

  const NO_KEY: DaytonaPublicConfig = { apiKeySet: false, apiKeySource: null };

  test("saves a new key and clears the field", async () => {
    const setConfig = mock((_input: { apiKey?: string }) =>
      Promise.resolve<DaytonaPublicConfig>({ apiKeySet: true, apiKeySource: "settings" })
    );
    const client = createTestApiClient({
      daytona: { getConfig: () => Promise.resolve(NO_KEY), setConfig },
    });
    const view = render(
      <APIProvider client={client}>
        <DaytonaAccessForm />
      </APIProvider>
    );
    const key = await waitFor(() => {
      const input = view.getByLabelText("API key") as HTMLInputElement;
      expect(input.disabled).toBe(false);
      return input;
    });
    const user = userEvent.setup({ document: key.ownerDocument });
    await user.type(key, "new-key");
    await user.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    expect(setConfig.mock.calls[0][0]).toEqual({ apiKey: "new-key" });
    await waitFor(() => expect(key.value).toBe(""));
    expect(view.getByText("Key set (settings)")).toBeTruthy();
  });
});
