import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealAPIModule from "@/browser/contexts/API";
import * as RealModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import * as RealModelsModule from "@/browser/hooks/useModelsFromSettings";
import * as RealProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import type { EvaluationModelCheck } from "@/common/orpc/types";
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
// Policy predicate shared with the chat pickers; models not listed here are disallowed.
let policyDisallowed: string[] = [];
let providersConfigMock: Record<string, { isCustom?: boolean }> = {};

// Capture the real exports BEFORE any mock.module call in this file: the spread
// must see the real module, or the afterAll restore would reinstall the stub.
restoreModulesAfterSuite([
  ["@/browser/contexts/API", { ...RealAPIModule }],
  ["@/browser/hooks/useModelsFromSettings", { ...RealModelsModule }],
  ["@/browser/hooks/useProvidersConfig", { ...RealProvidersConfigModule }],
  ["@/browser/components/ModelSelector/ModelSelector", { ...RealModelSelectorModule }],
]);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
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
    isAllowedByPolicyOnActiveRoute: (model: string) => !policyDisallowed.includes(model),
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
    policyDisallowed = [];
    providersConfigMock = {};
  });

  afterEach(() => {
    cleanup();
    restoreDom?.();
    apiMock = null;
  });

  test("offers only evaluation-eligible models and persists a selection through the dedicated endpoint", async () => {
    // A policy-disallowed model hides in "Show all models…": it must not be offered there either.
    policyDisallowed = ["google:gemini-2.5-pro"];
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
