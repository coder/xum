import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import type { ProviderModelDiscoveryResult, ProvidersConfigMap } from "@/common/orpc/types";
import { ModelsSection } from "./ModelsSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

interface DiscoveryRequest {
  provider: string;
  signal: AbortSignal;
  resolve: (result: ProviderModelDiscoveryResult) => void;
  reject: (error: Error) => void;
}

// Use the real component/store/context stack; only the RPC boundary is controlled.
// Deferred replies deliberately ignore abort to prove the UI also fences late results.
async function setup(provider = "anthropic") {
  const config: ProvidersConfigMap = Object.fromEntries(
    ["anthropic", "openai", "coder"].map((id) => [
      id,
      {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [],
        ...(id === "coder" ? { discoveredModels: ["coder/model"] } : {}),
      },
    ])
  );
  const client = setupSettingsStory({});
  client.providers.getConfig = () => Promise.resolve(structuredClone(config));
  const requests: DiscoveryRequest[] = [];
  client.providers.discoverModels = (input, options) => {
    if (!options?.signal) throw new Error("Discovery requires cancellation");
    const deferred = Promise.withResolvers<ProviderModelDiscoveryResult>();
    requests.push({ provider: input.provider, signal: options.signal, ...deferred });
    return deferred.promise;
  };
  const save = mock(client.providers.setModels);
  client.providers.setModels = save;
  const view = render(
    <SettingsSectionStory
      setup={() => {
        updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, provider);
        return client;
      }}
    >
      <TooltipProvider>
        <ModelsSection />
      </TooltipProvider>
    </SettingsSectionStory>
  );
  await act(() => Promise.resolve());
  const input = view.getByRole("combobox", { name: "Model ID" });
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected an editable model field");
  const add = view.getByRole("button", { name: "Add" });
  const user = userEvent.setup({ document: input.ownerDocument });
  const open = () => fireEvent.focus(input);
  const type = async (value: string) => {
    await user.clear(input);
    await user.type(input, value);
  };
  const key = (key: string, isComposing = false) => fireEvent.keyDown(input, { key, isComposing });
  const reply = (index: number, result: ProviderModelDiscoveryResult) =>
    act(() => Promise.resolve(requests[index].resolve(result)));
  return { view, input, add, requests, save, open, type, key, reply, user };
}

describe("ModelsSection asynchronous discovery", () => {
  let restoreDom: () => void;
  beforeEach(() => {
    restoreDom = installDom();
  });
  afterEach(() => {
    cleanup();
    getProvidersConfigStore().setClient(null);
    getAppConfigStore().setClient(null);
    restoreDom();
  });

  test("requests only on opening, filters locally, and adds only an explicit selection", async () => {
    const ui = await setup();
    expect(ui.requests).toHaveLength(0);
    ui.open();
    await ui.type("new");
    await ui.type("new-model");
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].provider).toBe("anthropic");
    expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
    await ui.reply(0, { status: "ok", modelIds: ["new-model-a", "different"] });
    expect(ui.view.getAllByRole("option")).toHaveLength(1);
    expect(ui.save).not.toHaveBeenCalled();
    ui.key("Enter", true);
    expect(ui.save).not.toHaveBeenCalled();
    ui.key("ArrowDown");
    ui.key("Enter");
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["new-model-a"] });
    expect(ui.input.value).toBe("");
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].signal.aborted).toBe(true);
  });

  test.each(["Add", "Enter"])("literal %s works while discovery is pending", async (action) => {
    const ui = await setup();
    ui.open();
    await ui.type("manual/id");
    expect(ui.requests).toHaveLength(1);
    expect(ui.view.getByRole("status")).toBeTruthy();
    if (action === "Add") fireEvent.click(ui.add);
    else ui.key("Enter");
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["manual/id"] });
    expect(ui.requests[0].signal.aborted).toBe(true);
    await ui.reply(0, { status: "ok", modelIds: ["late-model"] });
    expect(ui.view.queryByRole("listbox")).toBeNull();
    expect(ui.input.value).toBe("");
  });

  test("switching provider aborts a pending request and ignores its late reply", async () => {
    const ui = await setup();
    ui.open();
    fireEvent.keyDown(ui.view.getByRole("combobox", { name: "Provider" }), { key: "Enter" });
    await ui.user.click(within(document.body).getByRole("option", { name: "OpenAI" }));
    ui.open();
    expect(ui.requests).toHaveLength(2);
    expect(ui.requests[0].signal.aborted).toBe(true);
    expect(ui.requests[1].provider).toBe("openai");
    await ui.reply(1, { status: "ok", modelIds: ["current-model"] });
    await ui.reply(0, { status: "ok", modelIds: ["old-model"] });
    expect(ui.view.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "current-model",
    ]);
  });

  test.each(["Escape", "blur", "unmount"])("%s cancels and fences late replies", async (action) => {
    const ui = await setup();
    ui.open();
    await ui.type("keep-me");
    if (action === "Escape") ui.key("Escape");
    else if (action === "blur") fireEvent.blur(ui.input, { relatedTarget: ui.add });
    else ui.view.unmount();
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].signal.aborted).toBe(true);
    await ui.reply(0, { status: "ok", modelIds: ["keep-me-old"] });
    expect(ui.view.queryByRole("listbox")).toBeNull();
    if (action !== "unmount") {
      expect(ui.input.value).toBe("keep-me");
      ui.open();
      expect(ui.requests).toHaveLength(2);
      expect(ui.view.queryByRole("listbox")).toBeNull();
      await ui.reply(1, { status: "ok", modelIds: ["keep-me-new"] });
      expect(ui.view.getByRole("option").textContent).toBe("keep-me-new");
    }
  });

  test("reopening never reuses a completed catalog or its keyboard choice", async () => {
    const ui = await setup();
    ui.open();
    await ui.reply(0, { status: "ok", modelIds: ["model-old"] });
    ui.key("ArrowDown");
    ui.key("Escape");
    ui.open();
    expect(ui.requests).toHaveLength(2);
    expect(ui.view.queryByRole("listbox")).toBeNull();
    await ui.reply(1, { status: "ok", modelIds: ["model-old"] });
    expect(ui.view.getByRole("option")).toBeTruthy();
    expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
  });

  test.each([false, true])(
    "same-content config replacement invalidates pending/displayed results (displayed=%s)",
    async (displayed) => {
      const ui = await setup();
      ui.open();
      await ui.type("model");
      if (displayed) {
        await ui.reply(0, { status: "ok", modelIds: ["model-old"] });
        ui.key("ArrowDown");
        expect(ui.input.getAttribute("aria-activedescendant")).not.toBeNull();
      }
      const previous = getProvidersConfigStore().getConfig();
      await act(async () => getProvidersConfigStore().refresh());
      expect(getProvidersConfigStore().getConfig()).toEqual(previous);
      expect(getProvidersConfigStore().getConfig()).not.toBe(previous);
      expect(ui.requests[0].signal.aborted).toBe(true);
      expect(ui.requests).toHaveLength(2);
      expect(ui.view.queryByRole("listbox")).toBeNull();
      expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
      if (!displayed) await ui.reply(0, { status: "ok", modelIds: ["model-old"] });
      expect(ui.view.queryByRole("listbox")).toBeNull();
      await ui.reply(1, { status: "ok", modelIds: ["model-old", "model-new"] });
      // Even if the same ID reappears, the old keyboard choice must not return.
      expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
      expect(ui.input.value).toBe("model");
      ui.key("Enter");
      expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["model"] });
    }
  );

  const unavailableResults: ProviderModelDiscoveryResult[] = [
    { status: "ok", modelIds: [] },
    { status: "error", reason: "timeout" },
    { status: "error", reason: "aborted" },
    { status: "error", reason: "stale-config" },
    { status: "unsupported" },
    { status: "not-configured" },
  ];
  test.each(unavailableResults)("manual entry survives unavailable catalog %j", async (result) => {
    const ui = await setup();
    ui.open();
    await ui.type("manual-model");
    await ui.reply(0, result);
    expect(ui.view.queryByRole("listbox")).toBeNull();
    expect(ui.input.value).toBe("manual-model");
    expect(ui.input.disabled).toBe(false);
    ui.key("Enter");
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["manual-model"] });
  });

  test("transport rejection retains the query and pointer selection persists via the same Add path", async () => {
    const ui = await setup();
    ui.open();
    await ui.type("custom");
    await act(() => Promise.resolve(ui.requests[0].reject(new Error("offline"))));
    expect(ui.input.value).toBe("custom");
    expect(ui.save).not.toHaveBeenCalled();
    ui.key("Escape");
    ui.open();
    await ui.reply(1, { status: "ok", modelIds: ["custom-new"] });
    fireEvent.click(ui.view.getByRole("option", { name: "custom-new" }));
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["custom-new"] });
    await ui.type("custom-new");
    ui.key("Enter");
    expect(ui.input.value).toBe("custom-new");
    expect(ui.save).toHaveBeenCalledTimes(1);
    expect(ui.view.getByText(/already exists/)).toBeTruthy();
  });

  test("Coder uses its existing catalog without a discovery RPC", async () => {
    const ui = await setup("coder");
    ui.open();
    const list = ui.view.getByRole("listbox");
    expect(within(list).getByRole("option", { name: "coder/model" })).toBeTruthy();
    expect(ui.requests).toHaveLength(0);
    expect(ui.save).not.toHaveBeenCalled();
  });
});
