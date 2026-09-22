import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as RealAPIModule from "@/browser/contexts/API";
import * as RealModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import * as RealModelsModule from "@/browser/hooks/useModelsFromSettings";
import * as RealRoutingModule from "@/browser/hooks/useRouting";
import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    updateEvaluationDefaults: ReturnType<typeof mock>;
  };
} | null = null;
let routeMock: { route: string; isAuto: boolean; displayName: string } = {
  route: "direct",
  isAuto: true,
  displayName: "Direct",
};

// Capture the real exports BEFORE any mock.module call in this file: the spread
// must see the real module, or the afterAll restore would reinstall the stub.
restoreModulesAfterSuite([
  ["@/browser/contexts/API", { ...RealAPIModule }],
  ["@/browser/hooks/useModelsFromSettings", { ...RealModelsModule }],
  ["@/browser/hooks/useRouting", { ...RealRoutingModule }],
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
    hiddenModelsForSelector: ["google:gemini-2.5-flash", "xai:grok-4-1-fast"],
  }),
}));
void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({ resolveRoute: () => routeMock }),
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
  apiMock = {
    config: {
      getConfig: mock(() =>
        Promise.resolve(
          persistedModel === undefined ? {} : { evaluationDefaults: { model: persistedModel } }
        )
      ),
      updateEvaluationDefaults,
    },
  };
  const view = render(<EvaluationModelCard />);
  const select = () => view.getByLabelText("Model") as HTMLSelectElement;
  return { view, select, updateEvaluationDefaults };
}

describe("EvaluationModelCard", () => {
  let restoreDom: (() => void) | undefined;

  beforeEach(() => {
    restoreDom = installDom();
    routeMock = { route: "direct", isAuto: true, displayName: "Direct" };
  });

  afterEach(() => {
    cleanup();
    restoreDom?.();
    apiMock = null;
  });

  test("offers only evaluation-eligible models and persists a selection through the dedicated endpoint", async () => {
    const { view, select, updateEvaluationDefaults } = renderCard();
    await waitFor(() => expect(apiMock?.config.getConfig).toHaveBeenCalled());

    // Unsupported providers and explicit gateway selections are dropped from both
    // the primary list and the "Show all models…" list.
    const options = Array.from(select().options).map((option) => option.value);
    expect(options).toEqual(["", "anthropic:claude-haiku-4-5", "openai:gpt-5"]);
    expect(select().dataset.hiddenModels).toBe("google:gemini-2.5-flash");
    expect(view.queryByRole("button", { name: "Clear evaluation model" })).toBeNull();

    fireEvent.change(select(), { target: { value: "openai:gpt-5" } });

    expect(updateEvaluationDefaults).toHaveBeenCalledWith({ model: "openai:gpt-5" });
    await waitFor(() => expect(select().value).toBe("openai:gpt-5"));
    expect(view.getByRole("button", { name: "Clear evaluation model" })).toBeTruthy();
    expect(view.queryByRole("note")).toBeNull();
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

  test("flags an explicit gateway selection even when the canonical route is direct", async () => {
    // resolveRoute canonicalizes `openrouter:openai/gpt-5` to a direct OpenAI route
    // (mocked as "direct" here), but the backend rejects the raw gateway prefix.
    const { view } = renderCard("openrouter:openai/gpt-5");

    await waitFor(() =>
      expect(view.getByRole("note").textContent).toContain("Gateway-scoped model strings")
    );
  });

  test("flags a selection that would leave the direct route", async () => {
    routeMock = { route: "openrouter", isAuto: true, displayName: "OpenRouter" };
    const { view, select } = renderCard("openai:gpt-5");
    await waitFor(() => expect(select().value).toBe("openai:gpt-5"));

    expect(view.getByRole("note").textContent).toContain("Would route via OpenRouter");
  });

  test("flags a persisted model whose provider cannot evaluate", async () => {
    const { view } = renderCard("xai:grok-code-fast-1");

    // The mocked selector has no option for it, so the note is the observable signal.
    await waitFor(() =>
      expect(view.getByRole("note").textContent).toContain("not supported for evaluation")
    );
    expect(view.getByRole("button", { name: "Clear evaluation model" })).toBeTruthy();
  });
});
