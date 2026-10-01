import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useImperativeHandle, useState, type ReactNode, type RefObject } from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY, MODEL_KEY_MAX_CHARS } from "@/common/constants/storage";
import { MODEL_CATALOG_SUGGESTION_PAGE_SIZE } from "@/common/constants/ui";
import type {
  ModelCatalogEntry,
  ModelCatalogSearchInput,
  ModelCatalogSearchResult,
  ProviderModelDiscoveryResult,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { searchModelCatalog } from "@/common/utils/tokens/modelCatalogSearch";
import { ModelsSection } from "./ModelsSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

interface DiscoveryRequest {
  provider: string;
  signal: AbortSignal;
  resolve: (result: ProviderModelDiscoveryResult) => void;
  reject: (error: Error) => void;
}

function SettingsProbe() {
  const settings = useSettings();
  return (
    <button type="button" onClick={() => settings.open("models")}>
      {settings.isOpen ? "Settings open" : "Settings closed"}
    </button>
  );
}

// A reconnect hands the settings tree a new API client while config stays put.
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
async function setup(
  provider = "anthropic",
  options: {
    anthropicModels?: string[];
    catalog?: (
      input: ModelCatalogSearchInput
    ) => ModelCatalogSearchResult | Promise<ModelCatalogSearchResult>;
  } = {}
) {
  const config: ProvidersConfigMap = Object.fromEntries(
    ["anthropic", "openai", "coder"].map((id) => [
      id,
      {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: id === "anthropic" ? (options.anthropicModels ?? []) : [],
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
  // Discovery tests stay independent of the bundled catalogue unless they opt in.
  const catalogRequests: ModelCatalogSearchInput[] = [];
  client.providers.searchModelCatalog = (input) => {
    catalogRequests.push(input);
    return Promise.resolve(options.catalog?.(input) ?? { models: [], total: 0, nextOffset: null });
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
          <SettingsProbe />
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
    catalogRequests,
    save,
    open,
    type,
    key,
    reply,
    user,
    reconnect,
  };
}

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

describe("ModelsSection asynchronous discovery", () => {
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

describe("ModelsSection catalogue suggestions", () => {
  test("a catalogue match is added under its own provider, not the selected one", async () => {
    const ui = await setup("openai", { catalog: searchModelCatalog });
    ui.open();
    await ui.type("fable");
    const option = await ui.view.findByRole("option", { name: /claude-fable-5$/ });
    expect(option.textContent).toContain("Anthropic");
    // The built-in successor is already selectable, so it is not offered.
    expect(ui.view.queryByRole("option", { name: /claude-fable-5-1/ })).toBeNull();
    fireEvent.click(option);
    expect(ui.save.mock.calls[0][0]).toEqual({ provider: "anthropic", models: ["claude-fable-5"] });
    expect(ui.view.getByRole("combobox", { name: "Provider" }).textContent).toContain("Anthropic");
    expect(ui.input.value).toBe("");
  });

  test("a failed search retires the previous query's matches", async () => {
    const ui = await setup("openai", {
      catalog: (input) =>
        input.query === "fable" ? searchModelCatalog(input) : Promise.reject(new Error("offline")),
    });
    ui.open();
    await ui.type("fable");
    await ui.view.findByRole("option", { name: /claude-fable-5$/ });
    await ui.user.type(ui.input, "x");
    await act(() => Promise.resolve());
    expect(ui.view.queryAllByRole("option").length).toBe(0);
    // Only the catalogue matches retire; discovery still fills the same list.
    await ui.reply(0, { status: "ok", modelIds: ["fablex-model"] });
    expect(ui.view.getByRole("option", { name: "fablex-model" })).toBeTruthy();
  });

  test.each<ProviderModelDiscoveryResult>([
    { status: "not-configured" },
    { status: "ok", modelIds: [] },
  ])("visible catalogue matches suppress the unavailable discovery status %j", async (result) => {
    const ui = await setup("openai", { catalog: searchModelCatalog });
    ui.open();
    await ui.type("fable");
    await ui.reply(0, result);
    await ui.view.findByRole("option", { name: /claude-fable-5$/ });
    expect(ui.view.queryByRole("status")).toBeNull();

    await ui.type("zzqx");
    expect(ui.view.queryByRole("option")).toBeNull();
    expect(ui.view.getByRole("status")).toBeTruthy();
  });

  test.each(["no provider", "discovery without matches"])(
    "with %s, a query matching nothing in the catalogue gets a status",
    async (scenario) => {
      const ui = await setup(scenario === "no provider" ? "" : "anthropic", {
        catalog: searchModelCatalog,
      });
      ui.open();
      if (scenario !== "no provider") await ui.reply(0, { status: "ok", modelIds: ["other"] });
      // Nothing has been searched yet, so nothing can be reported as unmatched.
      expect(ui.view.queryByRole("status")).toBeNull();
      await ui.type("fable");
      await ui.view.findByRole("option", { name: /claude-fable-5$/ });
      expect(ui.view.queryByRole("status")).toBeNull();

      await ui.type("zzqx");
      await ui.view.findByRole("status");
      expect(ui.view.queryByRole("option")).toBeNull();
    }
  );

  test.each(["reconnect", "reopen"])(
    "a %s change hides old catalogue matches until the new search replies",
    async (change) => {
      const reply: ModelCatalogSearchResult = {
        models: [
          {
            id: "openai:vendor-old",
            provider: "openai",
            providerModelId: "vendor-old",
            contextWindowTokens: null,
            builtIn: false,
          },
        ],
        total: 1,
        nextOffset: null,
      };
      const held = Promise.withResolvers<ModelCatalogSearchResult>();
      let hold = false;
      const ui = await setup("anthropic", {
        catalog: () => (hold ? held.promise : reply),
      });
      ui.open();
      await ui.type("vendor");
      await ui.view.findByRole("option", { name: /vendor-old/ });

      hold = true;
      const requestCount = ui.catalogRequests.length;
      if (change === "reconnect") {
        await ui.reconnect();
      } else {
        ui.key("Escape");
        ui.open();
      }
      expect(ui.catalogRequests.length).toBeGreaterThan(requestCount);
      expect(ui.view.queryByRole("option", { name: /vendor-old/ })).toBeNull();
      await act(() => Promise.resolve(held.resolve(reply)));
      await ui.view.findByRole("option", { name: /vendor-old/ });
    }
  );

  test.each(["keyboard", "pointer"])(
    "%s Show more keeps its highlight, so Enter pages and never adds the query",
    async (method) => {
      const entry = (provider: string, providerModelId: string, builtIn = false) =>
        ({
          id: `${provider}:${providerModelId}`,
          provider,
          providerModelId,
          contextWindowTokens: null,
          builtIn,
        }) satisfies ModelCatalogEntry;
      const catalog = [
        entry("anthropic", "vendor-builtin", true),
        entry("anthropic", "vendor-added"),
        entry("openai", "vendor-first"),
        entry("openai", "vendor-second"),
        entry("openai", "vendor-third"),
        entry("openai", "vendor-fourth"),
        entry("openai", "vendor-late"),
      ];
      const pageSize = 3;
      const ui = await setup("anthropic", {
        anthropicModels: ["vendor-added"],
        catalog: (input) => {
          const offset = input.offset ?? 0;
          const end = offset + pageSize;
          return {
            models: catalog.slice(offset, end),
            total: catalog.length,
            nextOffset: end < catalog.length ? end : null,
          };
        },
      });
      ui.open();
      await ui.type("vendor");
      await ui.reply(0, { status: "ok", modelIds: ["vendor-disc"] });
      const optionNames = () => ui.view.getAllByRole("option").map((option) => option.textContent);
      expect(optionNames()).toEqual(["vendor-disc", "OpenAIvendor-first", "Show more (4)"]);
      const activeName = () =>
        document.getElementById(ui.input.getAttribute("aria-activedescendant") ?? "")?.textContent;

      if (method === "keyboard") {
        ui.key("ArrowDown");
        expect(activeName()).toBe("vendor-disc");
        ui.key("ArrowDown");
        expect(activeName()).toBe("OpenAIvendor-first");
        ui.key("ArrowDown");
        ui.key("Enter");
      } else {
        fireEvent.click(ui.view.getByRole("option", { name: /^Show more/ }));
      }
      await ui.view.findByRole("option", { name: /vendor-fourth/ });
      expect(ui.catalogRequests.at(-1)).toEqual({
        query: "vendor",
        offset: pageSize,
        limit: MODEL_CATALOG_SUGGESTION_PAGE_SIZE,
      });
      expect(activeName()).toBe("Show more (1)");

      ui.key("Enter");
      await ui.view.findByRole("option", { name: /vendor-late/ });
      expect(optionNames().at(-1)).toBe("OpenAIvendor-late");
      // The last page removes "Show more"; Enter must neither add the query nor a model.
      ui.key("Enter");
      expect(ui.save).not.toHaveBeenCalled();

      ui.key("ArrowUp");
      ui.key("Enter");
      expect(ui.save.mock.calls[0][0]).toEqual({ provider: "openai", models: ["vendor-late"] });
    }
  );
});

describe("ModelsSection Escape", () => {
  test("clears a non-empty filter, then closes Settings", async () => {
    const ui = await setup();
    fireEvent.click(ui.view.getByRole("button", { name: "Settings closed" }));
    const filter = ui.view.getByRole("textbox", { name: "Filter models" });
    if (!(filter instanceof HTMLInputElement)) throw new Error("Expected an editable filter");
    await ui.user.type(filter, "gpt");
    fireEvent.keyDown(filter, { key: "Escape" });
    expect([filter.value, ui.view.queryByText("Settings open") !== null]).toEqual(["", true]);
    fireEvent.keyDown(filter, { key: "Escape" });
    await ui.view.findByText("Settings closed");
  });

  test("in Model ID closes the list, then clears the field, then closes Settings", async () => {
    const ui = await setup();
    fireEvent.click(ui.view.getByRole("button", { name: "Settings closed" }));
    await ui.type("claude");
    await ui.reply(0, { status: "ok", modelIds: ["claude-x"] });
    ui.key("Escape");
    expect([ui.input.getAttribute("aria-expanded"), ui.input.value]).toEqual(["false", "claude"]);
    ui.key("Escape");
    expect([ui.input.value, ui.view.queryByText("Settings open") !== null]).toEqual(["", true]);
    ui.key("Escape");
    await ui.view.findByText("Settings closed");
  });
});

describe("ModelsSection manual model IDs", () => {
  test.each(["sonnet 4", "tab\tid"])(
    "rejects %p, flags the field until it is edited",
    async (modelId) => {
      const ui = await setup();
      await ui.type(modelId);
      ui.key("Enter");
      fireEvent.click(ui.add);
      expect(ui.save).not.toHaveBeenCalled();
      expect([ui.input.value, ui.input.getAttribute("aria-invalid")]).toEqual([modelId, "true"]);
      await ui.user.type(ui.input, "x");
      expect(ui.input.hasAttribute("aria-invalid")).toBe(false);
    }
  );

  // A selected "provider:id" longer than the per-workspace model key would not survive a restart.
  // Typing over a hundred characters takes several seconds, hence the longer timeout.
  test("rejects an ID too long to persist as the selected model, accepts one at the limit", async () => {
    const ui = await setup();
    const maxIdChars = MODEL_KEY_MAX_CHARS - JSON.stringify("anthropic:").length;
    await ui.type("m".repeat(maxIdChars + 1));
    fireEvent.click(ui.add);
    expect(ui.save).not.toHaveBeenCalled();
    expect(ui.input.getAttribute("aria-invalid")).toBe("true");

    await ui.user.type(ui.input, "{Backspace}");
    fireEvent.click(ui.add);
    expect(ui.save.mock.calls[0][0]).toEqual({
      provider: "anthropic",
      models: ["m".repeat(maxIdChars)],
    });
  }, 15_000);

  test("editing a model rejects an ID too long to persist, accepts one at the limit", async () => {
    const maxIdChars = MODEL_KEY_MAX_CHARS - JSON.stringify("anthropic:").length;
    const original = `${"m".repeat(maxIdChars - 1)}x`;
    const ui = await setup("anthropic", { anthropicModels: [original] });
    fireEvent.click(ui.view.getAllByRole("button", { name: "Edit model" })[0]);
    const editInput = ui.view.getByDisplayValue(original);
    await ui.user.type(editInput, "{Backspace}mm{Enter}");
    expect(ui.save).not.toHaveBeenCalled();

    await ui.user.type(editInput, "{Backspace}{Enter}");
    expect(ui.save.mock.calls[0][0]).toEqual({
      provider: "anthropic",
      models: ["m".repeat(maxIdChars)],
    });
  });

  test("accepts IDs with characters beyond the common set", async () => {
    const ui = await setup();
    await ui.type("vendor/model+fast#v2");
    fireEvent.click(ui.add);
    expect(ui.save.mock.calls[0][0]).toEqual({
      provider: "anthropic",
      models: ["vendor/model+fast#v2"],
    });
  });
});

describe("ModelsSection table filter and paging", () => {
  test("an active edit locks paging and filtering until it ends", async () => {
    const models = Array.from({ length: 60 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`);
    const ui = await setup("anthropic", { anthropicModels: models });
    const filter = ui.view.getByRole("textbox", { name: "Filter models" });
    const locked = () => [
      filter.hasAttribute("disabled"),
      ...["Previous", "Next"].map((name) =>
        ui.view.getByRole("button", { name }).hasAttribute("disabled")
      ),
    ];
    // A middle page, so neither pager button is disabled by position.
    fireEvent.click(ui.view.getByRole("button", { name: "Next" }));
    expect(locked()).toEqual([false, false, false]);
    fireEvent.click(ui.view.getAllByRole("button", { name: "Edit model" })[0]);
    expect(locked()).toEqual([true, true, true]);
    fireEvent.click(ui.view.getByRole("button", { name: /Cancel/ }));
    expect(locked()).toEqual([false, false, false]);
  });

  test("pages custom models and filters both tables", async () => {
    const models = Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`);
    const ui = await setup("anthropic", { anthropicModels: models });
    const filter = ui.view.getByRole("textbox", { name: "Filter models" });
    const visible = (text: string) => ui.view.queryByText(text) !== null;
    const builtIn = KNOWN_MODELS.OPUS.providerModelId;

    expect([visible("model-25"), visible("model-26"), visible(builtIn)]).toEqual([
      true,
      false,
      true,
    ]);
    fireEvent.click(ui.view.getByRole("button", { name: "Next" }));
    expect([visible("model-01"), visible("model-26")]).toEqual([false, true]);

    // A new filter starts from the first page even when it keeps every row.
    await ui.user.type(filter, "anthropic");
    expect([visible("model-01"), visible("model-26")]).toEqual([true, false]);

    await ui.user.clear(filter);
    await ui.user.type(filter, "MODEL-2");
    expect([visible("model-02"), visible("model-20"), visible("model-29")]).toEqual([
      false,
      true,
      true,
    ]);
    expect(visible(builtIn)).toBe(false);
    expect(ui.view.queryByRole("button", { name: "Next" })).toBeNull();

    // Built-ins also match by alias.
    await ui.user.clear(filter);
    await ui.user.type(filter, KNOWN_MODELS.OPUS.aliases?.[0] ?? "");
    expect([visible(builtIn), visible("model-01")]).toEqual([true, false]);
  });
});
