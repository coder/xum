import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { wrapAsyncIterator } from "@orpc/shared";
import { useImperativeHandle, useState, type ReactNode, type RefObject } from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import type {
  EffectivePolicy,
  ProviderModelDiscoveryResult,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { createAsyncEventQueue } from "@/common/utils/asyncEventIterator";
import { ModelsSection } from "./ModelsSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

interface DiscoveryRequest {
  provider: string;
  signal: AbortSignal;
  resolve: (result: ProviderModelDiscoveryResult) => void;
  reject: (error: Error) => void;
}

// A reconnect hands the settings tree a new API client while config and policy stay put.
function SwappableAPI(props: {
  initial: APIClient;
  handle: RefObject<((client: APIClient) => void) | null>;
  children: ReactNode;
}) {
  const [client, setClient] = useState(props.initial);
  useImperativeHandle(props.handle, () => setClient, []);
  return <APIProvider client={client}>{props.children}</APIProvider>;
}

// Use the real component/store/context stack; only the RPC boundary is controlled.
// Deferred replies deliberately ignore abort to prove the UI also fences late results.
async function setup(provider = "anthropic", initialPolicy: EffectivePolicy | null = null) {
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
  let policy = initialPolicy;
  const policyEvents = createAsyncEventQueue<void>();
  client.policy.get = () =>
    Promise.resolve({
      source: policy ? "governor" : "none",
      status: { state: policy ? "enforced" : "disabled" },
      policy,
    });
  client.policy.onChanged = (_input, options) => {
    if (!options?.signal) throw new Error("Policy subscription requires cancellation");
    options.signal.addEventListener("abort", policyEvents.end, { once: true });
    return Promise.resolve(wrapAsyncIterator(policyEvents.iterate(), {}));
  };
  const replacePolicy = (next: EffectivePolicy) =>
    act(() => {
      policy = next;
      policyEvents.push();
      return Promise.resolve();
    });
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
  const swapHandle: RefObject<((client: APIClient) => void) | null> = { current: null };
  const view = render(
    <SettingsSectionStory
      setup={() => {
        updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, provider);
        return client;
      }}
    >
      <TooltipProvider>
        <SwappableAPI initial={client} handle={swapHandle}>
          <ModelsSection />
        </SwappableAPI>
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
  // Same methods, new identity: only the client object changes, as after a reconnect.
  const reconnect = () =>
    act(() => {
      const swap = swapHandle.current;
      if (!swap) throw new Error("SwappableAPI is not mounted");
      swap({ ...client });
      return Promise.resolve();
    });
  return {
    view,
    input,
    add,
    requests,
    save,
    open,
    type,
    key,
    reply,
    user,
    replacePolicy,
    reconnect,
  };
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

  test("a reconnected API client revokes the old keyboard choice", async () => {
    const ui = await setup();
    ui.open();
    await ui.type("model");
    await ui.reply(0, { status: "ok", modelIds: ["model-a"] });
    ui.key("ArrowDown");
    expect(ui.input.getAttribute("aria-activedescendant")).not.toBeNull();
    const config = getProvidersConfigStore().getConfig();
    await ui.reconnect();
    expect(getProvidersConfigStore().getConfig()).toBe(config);
    expect(ui.requests[0].signal.aborted).toBe(true);
    expect(ui.requests).toHaveLength(2);
    expect(ui.view.queryByRole("listbox")).toBeNull();
    await ui.reply(1, { status: "ok", modelIds: ["model-a"] });
    expect(ui.view.getByRole("option", { name: "model-a" })).toBeTruthy();
    // The same ID from the new client must not restore the old keyboard choice.
    expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
    ui.key("Enter");
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["model"] });
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

  const initialPolicy: EffectivePolicy = {
    policyFormatVersion: "0.1",
    providerAccess: [{ id: "anthropic", allowedModels: null }],
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
  };

  test.each(["allowedModels", "forcedBaseUrl"])(
    "policy-only %s change invalidates a completed catalog and its highlight",
    async (change) => {
      const ui = await setup("anthropic", initialPolicy);
      ui.open();
      await ui.type("model");
      await ui.reply(0, { status: "ok", modelIds: ["model-a"] });
      ui.key("ArrowDown");
      expect(ui.input.getAttribute("aria-activedescendant")).not.toBeNull();
      const config = getProvidersConfigStore().getConfig();
      await ui.replacePolicy({
        ...initialPolicy,
        providerAccess: [
          change === "allowedModels"
            ? { id: "anthropic", allowedModels: ["model", "model-b"] }
            : { id: "anthropic", forcedBaseUrl: "https://new-endpoint.invalid" },
        ],
      });
      // Real policy events must invalidate results without a provider refresh or remount.
      expect(getProvidersConfigStore().getConfig()).toBe(config);
      expect(ui.view.getByRole("combobox", { name: "Model ID" })).toBe(ui.input);
      expect(ui.view.queryAllByRole("listbox")).toHaveLength(0);
      expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
      expect(ui.requests[0].signal.aborted).toBe(true);
      expect(ui.requests.map((request) => request.provider)).toEqual(["anthropic", "anthropic"]);
      expect(ui.input.value).toBe("model");
      ui.key("Enter", true);
      expect(ui.save).not.toHaveBeenCalled();
      await ui.reply(1, {
        status: "ok",
        modelIds: change === "allowedModels" ? ["model-b"] : ["model-a", "model-b"],
      });
      expect(ui.view.getByRole("option", { name: "model-b" })).toBeTruthy();
      // A repeated ID from a new endpoint must not restore the old keyboard choice.
      expect(ui.input.getAttribute("aria-activedescendant")).toBeNull();
      ui.key("Enter");
      expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["model"] });
    }
  );

  test("policy-only changes cancel pending discovery and fence late old-policy replies", async () => {
    const ui = await setup("anthropic", initialPolicy);
    ui.open();
    await ui.type("model");
    const config = getProvidersConfigStore().getConfig();
    await ui.replacePolicy({
      ...initialPolicy,
      providerAccess: [{ id: "anthropic", allowedModels: ["model-b"] }],
    });
    expect(getProvidersConfigStore().getConfig()).toBe(config);
    expect(ui.requests[0].signal.aborted).toBe(true);
    expect(ui.requests).toHaveLength(2);
    await ui.reply(0, { status: "ok", modelIds: ["model-a"] });
    expect(ui.view.queryAllByRole("listbox")).toHaveLength(0);
    await ui.reply(1, { status: "ok", modelIds: ["model-b"] });
    fireEvent.click(ui.view.getByRole("option", { name: "model-b" }));
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["model-b"] });
    // A policy event while the field is closed must not start background discovery.
    await ui.replacePolicy(initialPolicy);
    expect(ui.requests).toHaveLength(2);
  });

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
