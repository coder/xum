import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealAPIModule from "@/browser/contexts/API";
import * as RealModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import * as RealModelsModule from "@/browser/hooks/useModelsFromSettings";
import * as RealProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as RealRoutingModule from "@/browser/hooks/useRouting";
import * as RealPolicyModule from "@/browser/contexts/PolicyContext";
import type { EffectivePolicy, EvaluationModelCheck } from "@/common/orpc/types";
import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    updateEvaluationDefaults: ReturnType<typeof mock>;
    checkEvaluationModel: ReturnType<typeof mock>;
  };
} | null = null;
// Backend verdict per model string; unknown models read as admissible.
let checkResults: Record<string, EvaluationModelCheck | Promise<EvaluationModelCheck>> = {};
// Enforced policy (null = not enforced), as PolicyContext would expose it.
let enforcedPolicy: EffectivePolicy | null = null;
let providersConfigMock: Record<string, { isCustom?: boolean }> = {};
let routingMock: { routePriority: string[]; routeOverrides: Record<string, string> } = {
  routePriority: ["direct"],
  routeOverrides: {},
};
let apiMockNull = false;

// Capture the real exports BEFORE any mock.module call in this file: the spread
// must see the real module, or the afterAll restore would reinstall the stub.
restoreModulesAfterSuite([
  ["@/browser/contexts/API", { ...RealAPIModule }],
  ["@/browser/hooks/useModelsFromSettings", { ...RealModelsModule }],
  ["@/browser/hooks/useProvidersConfig", { ...RealProvidersConfigModule }],
  ["@/browser/hooks/useRouting", { ...RealRoutingModule }],
  ["@/browser/contexts/PolicyContext", { ...RealPolicyModule }],
  ["@/browser/components/ModelSelector/ModelSelector", { ...RealModelSelectorModule }],
]);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMockNull ? null : apiMock }),
}));
void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => routingMock,
}));
void mock.module("@/browser/contexts/PolicyContext", () => ({
  usePolicy: () =>
    enforcedPolicy === null
      ? { status: { state: "none" }, policy: null, source: "none", loading: false }
      : { status: { state: "enforced" }, policy: enforcedPolicy, source: "file", loading: false },
}));
void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5",
      "xai:grok-code-fast-1",
      "openrouter:openai/gpt-5",
    ],
    hiddenModelsForSelector: [
      "google:gemini-2.5-flash",
      "xai:grok-4-1-fast",
      "google:gemini-2.5-pro",
    ],
  }),
}));
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: providersConfigMock, loading: false }),
}));
void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    emptyLabel?: string;
    onChange: (value: string) => void;
    models: string[];
    hiddenModels?: string[];
  }) => (
    <select
      aria-label="Model"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      data-hidden-models={(props.hiddenModels ?? []).join(",")}
    >
      <option value="">{props.emptyLabel ?? ""}</option>
      {props.models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  ),
}));

import { EvaluationModelCard } from "./EvaluationModelCard";

function renderCard(
  persistedModel?: string,
  update: () => Promise<undefined> = () => Promise.resolve(undefined)
) {
  const updateEvaluationDefaults = mock(update);
  const checkEvaluationModel = mock(({ model }: { model: string }) =>
    Promise.resolve(checkResults[model] ?? { ok: true as const })
  );
  apiMock = {
    config: {
      getConfig: mock(() =>
        Promise.resolve(
          persistedModel === undefined ? {} : { evaluationDefaults: { model: persistedModel } }
        )
      ),
      updateEvaluationDefaults,
      checkEvaluationModel,
    },
  };
  const view = render(<EvaluationModelCard />);
  const select = () => view.getByLabelText("Model") as HTMLSelectElement;
  return { view, select, updateEvaluationDefaults, checkEvaluationModel };
}

describe("EvaluationModelCard", () => {
  let restoreDom: (() => void) | undefined;

  beforeEach(() => {
    restoreDom = installDom();
    checkResults = {};
    enforcedPolicy = null;
    providersConfigMock = {};
    routingMock = { routePriority: ["direct"], routeOverrides: {} };
    apiMockNull = false;
  });

  afterEach(() => {
    cleanup();
    restoreDom?.();
    apiMock = null;
  });

  test("offers only evaluation-eligible models and persists a selection through the dedicated endpoint", async () => {
    // The enforced policy allows Anthropic, OpenAI's gpt-5 and one hidden Google
    // model; the other hidden Google model must not be offered via "Show all models…".
    enforcedPolicy = {
      providerAccess: [
        { id: "anthropic", allowedModels: null },
        { id: "openai", allowedModels: ["gpt-5"] },
        { id: "google", allowedModels: ["gemini-2.5-flash"] },
      ],
    } as unknown as EffectivePolicy;
    const { view, select, updateEvaluationDefaults, checkEvaluationModel } = renderCard();
    await waitFor(() => expect(apiMock?.config.getConfig).toHaveBeenCalled());

    // Unsupported providers, explicit gateway selections and policy-disallowed
    // models are dropped from both the primary and the hidden list.
    const options = Array.from(select().options).map((option) => option.value);
    expect(options).toEqual(["", "anthropic:claude-haiku-4-5", "openai:gpt-5"]);
    expect(select().dataset.hiddenModels).toBe("google:gemini-2.5-flash");
    expect(view.queryByRole("button", { name: "Clear evaluation model" })).toBeNull();
    // Nothing selected: nothing to check.
    expect(checkEvaluationModel).not.toHaveBeenCalled();

    fireEvent.change(select(), { target: { value: "openai:gpt-5" } });

    expect(updateEvaluationDefaults).toHaveBeenCalledWith({ model: "openai:gpt-5" });
    await waitFor(() => expect(select().value).toBe("openai:gpt-5"));
    await waitFor(() =>
      expect(checkEvaluationModel).toHaveBeenCalledWith({ model: "openai:gpt-5" })
    );
    expect(view.getByRole("button", { name: "Clear evaluation model" })).toBeTruthy();
    expect(view.queryByRole("note")).toBeNull();
  });

  test("gates options on the origin provider's policy, not on a permitted gateway route", async () => {
    // OpenRouter may be allowed and routing may prefer it, but evaluation runs on
    // the origin's direct route and the resolver checks policy against `openai`.
    enforcedPolicy = {
      providerAccess: [
        { id: "anthropic", allowedModels: null },
        { id: "openrouter", allowedModels: null },
      ],
    } as unknown as EffectivePolicy;
    routingMock = { routePriority: ["openrouter", "direct"], routeOverrides: {} };
    const { select } = renderCard();
    await waitFor(() => expect(apiMock?.config.getConfig).toHaveBeenCalled());

    const options = Array.from(select().options).map((option) => option.value);
    expect(options).toEqual(["", "anthropic:claude-haiku-4-5"]);
  });

  test("re-checks the selected model when route preferences or policy change", async () => {
    const { view, checkEvaluationModel } = renderCard("openai:gpt-5");
    await waitFor(() => expect(checkEvaluationModel).toHaveBeenCalledTimes(1));

    checkResults = {
      "openai:gpt-5": {
        ok: false,
        reason: "unsupported-route",
        routeKind: "gateway",
        providerName: "openrouter",
      },
    };
    routingMock = { routePriority: ["openrouter", "direct"], routeOverrides: {} };
    view.rerender(<EvaluationModelCard />);

    await waitFor(() => expect(checkEvaluationModel).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.getByRole("note").textContent).toContain("Would route via openrouter")
    );
  });

  test("publishes nothing while no API client is available", async () => {
    apiMockNull = true;
    const { view, select } = renderCard();
    // No API: the card cannot load either, so the selector shows "Not set".
    expect(select().value).toBe("");

    fireEvent.change(select(), { target: { value: "openai:gpt-5" } });

    await waitFor(() => expect(view.getByText(/Not connected/)).toBeTruthy());
    expect(select().value).toBe("");
  });

  test("drops models whose built-in id is shadowed by a custom provider", async () => {
    providersConfigMock = { openai: { isCustom: true } };
    const { select } = renderCard();
    await waitFor(() => expect(apiMock?.config.getConfig).toHaveBeenCalled());

    const options = Array.from(select().options).map((option) => option.value);
    expect(options).toEqual(["", "anthropic:claude-haiku-4-5"]);
  });

  test("keeps showing the stored model when the write is rejected", async () => {
    const { view, select } = renderCard("anthropic:claude-haiku-4-5", () =>
      Promise.reject(new Error("disk full"))
    );
    await waitFor(() => expect(select().value).toBe("anthropic:claude-haiku-4-5"));

    fireEvent.change(select(), { target: { value: "openai:gpt-5" } });

    await waitFor(() => expect(view.getByText("disk full")).toBeTruthy());
    expect(select().value).toBe("anthropic:claude-haiku-4-5");
  });

  test("loads the persisted default and clears it with null", async () => {
    const { view, select, updateEvaluationDefaults } = renderCard("anthropic:claude-haiku-4-5");
    await waitFor(() => expect(select().value).toBe("anthropic:claude-haiku-4-5"));

    fireEvent.click(view.getByRole("button", { name: "Clear evaluation model" }));

    expect(updateEvaluationDefaults).toHaveBeenCalledWith({ model: null });
    await waitFor(() => expect(select().value).toBe(""));
    expect(view.queryByRole("button", { name: "Clear evaluation model" })).toBeNull();
  });

  // The hint is the backend resolver's verdict, so auth-mode, route and
  // credential rules are not re-implemented client-side.
  test.each([
    [
      { ok: false, reason: "unsupported-route", routeKind: "codex-oauth", providerName: "openai" },
      "ChatGPT OAuth",
    ],
    [{ ok: false, reason: "unsupported-route", routeKind: "custom" }, "custom provider"],
    [
      { ok: false, reason: "unsupported-route", routeKind: "gateway", providerName: "openrouter" },
      "Would route via openrouter",
    ],
    [{ ok: false, reason: "unauthorized", providerName: "openai" }, "no usable API key"],
    [{ ok: false, reason: "unsupported-provider" }, "not supported for evaluation"],
  ] as const satisfies ReadonlyArray<readonly [EvaluationModelCheck, string]>)(
    "explains the backend rejection %j for the persisted model",
    async (result, expectedText) => {
      checkResults = { "openai:gpt-5": result };
      const { view } = renderCard("openai:gpt-5");

      await waitFor(() => expect(view.getByRole("note").textContent).toContain(expectedText));
      expect(view.getByRole("button", { name: "Clear evaluation model" })).toBeTruthy();
    }
  );

  test("ignores a late verdict for a previous selection", async () => {
    const late = Promise.withResolvers<EvaluationModelCheck>();
    checkResults = { "anthropic:claude-haiku-4-5": late.promise };
    const { view, select, checkEvaluationModel } = renderCard("anthropic:claude-haiku-4-5");
    await waitFor(() =>
      expect(checkEvaluationModel).toHaveBeenCalledWith({ model: "anthropic:claude-haiku-4-5" })
    );

    fireEvent.change(select(), { target: { value: "openai:gpt-5" } });
    await waitFor(() => expect(select().value).toBe("openai:gpt-5"));
    await waitFor(() =>
      expect(checkEvaluationModel).toHaveBeenCalledWith({ model: "openai:gpt-5" })
    );

    // The stale response for the previous model arrives after the switch.
    late.resolve({ ok: false, reason: "unauthorized", providerName: "anthropic" });
    await late.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.queryByRole("note")).toBeNull();
  });
});
