import "../../../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { createKeptClientConnection } from "@/browser/contexts/connection.testHarness";
import { ConnectionLostError } from "@/browser/contexts/connectionLink";
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

  test("loads the saved settings once the connection is live after a reconnect", async () => {
    let live = false;
    const client = createTestApiClient({
      daytona: {
        getConfig: () =>
          live ? Promise.resolve(ENV_CONFIG) : Promise.reject(new ConnectionLostError()),
      },
    });
    const connection = createKeptClientConnection(client);
    const view = render(<DaytonaAccessForm />, { wrapper: connection.Wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));

    live = true;
    connection.setStatus("connected");

    await waitFor(() =>
      expect((view.getByLabelText("API URL") as HTMLInputElement).value).toBe(ENV_CONFIG.apiUrl)
    );
    expect(view.queryByText(/Could not load Daytona settings/)).toBeNull();
  });

  const KEY_CONFIG: DaytonaPublicConfig = { ...ENV_CONFIG, apiKeySet: true, apiKeySource: "env" };

  /** A client whose calls fail, as the detached link's do, while `live.current` is false. */
  function reconnectingClient() {
    const live = { current: true };
    const whileLive = <T,>(value: () => Promise<T>) =>
      live.current ? value() : Promise.reject(new ConnectionLostError());
    const setConfig = mock((_input: Record<string, string>) =>
      whileLive(() => Promise.resolve(KEY_CONFIG))
    );
    const testConnection = mock(() => whileLive(() => Promise.resolve({ ok: true as const })));
    const getConfig = mock(() => whileLive(() => Promise.resolve(KEY_CONFIG)));
    const client = createTestApiClient({
      daytona: {
        getConfig,
        setConfig,
        testConnection,
      },
    });
    const connection = createKeptClientConnection(client);
    connection.setStatus("connected");
    const view = render(<DaytonaAccessForm />, { wrapper: connection.Wrapper });
    const button = (name: string) => view.getByRole("button", { name }) as HTMLButtonElement;
    const drop = () => {
      live.current = false;
      connection.setStatus("reconnecting");
    };
    const restore = () => {
      live.current = true;
      connection.setStatus("connected");
    };
    return { view, button, getConfig, setConfig, testConnection, drop, restore };
  }

  // While Xum reconnects, useAPI() keeps the last client, whose calls fail at once.
  test("disables Save and Test while reconnecting, and both work once live again", async () => {
    const rig = reconnectingClient();
    const key = await waitFor(() => {
      const input = rig.view.getByLabelText("API key") as HTMLInputElement;
      expect(input.disabled).toBe(false);
      return input;
    });
    const user = userEvent.setup({ document: key.ownerDocument });
    await user.type(key, "new-key");

    rig.drop();
    expect(rig.button("Save").disabled).toBe(true);
    expect(rig.button("Test connection").disabled).toBe(true);
    await user.click(rig.button("Save"));
    await user.click(rig.button("Test connection"));
    expect(rig.setConfig).not.toHaveBeenCalled();
    expect(rig.testConnection).not.toHaveBeenCalled();
    // The edit survives the gap, as in other settings sections.
    expect(key.value).toBe("new-key");

    rig.restore();
    await waitFor(() => expect(rig.button("Test connection").disabled).toBe(false));
    await user.click(rig.button("Test connection"));
    await waitFor(() => expect(rig.view.getByRole("status").textContent).toContain("Connected"));
    await user.click(rig.button("Save"));
    await waitFor(() => expect(rig.setConfig).toHaveBeenCalledTimes(1));
    expect(rig.setConfig.mock.calls[0][0]).toEqual({ apiKey: "new-key" });
    expect(rig.view.queryByRole("alert")).toBeNull();
  });

  // A call the drop cut off fails with the lost connection; the reload after it supersedes it.
  test("drops an error the lost connection caused once the settings reload", async () => {
    const rig = reconnectingClient();
    await waitFor(() => expect(rig.button("Test connection").disabled).toBe(false));
    let failTest!: (error: Error) => void;
    const cutOff = new Promise<never>((_, reject) => (failTest = reject));
    rig.testConnection.mockImplementationOnce(() => cutOff);
    const user = userEvent.setup({ document: rig.view.container.ownerDocument });
    await user.click(rig.button("Test connection"));
    await waitFor(() => expect(rig.testConnection).toHaveBeenCalledTimes(1));

    rig.drop();
    failTest(new ConnectionLostError());
    await waitFor(() => expect(rig.view.getByRole("alert")).toBeTruthy());

    rig.restore();
    await waitFor(() => expect(rig.getConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rig.view.queryByRole("alert")).toBeNull());
    expect(rig.button("Test connection").disabled).toBe(false);
  });

  test("saves a URL the user edited", async () => {
    const sent = await saveAfter(async (fields, user) => {
      await user.clear(fields.url);
      await user.type(fields.url, "https://other.example/api");
    });
    expect(sent).toEqual({ apiUrl: "https://other.example/api" });
  });
});
