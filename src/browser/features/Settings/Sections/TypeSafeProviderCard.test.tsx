import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualAPIModule from "@/browser/contexts/API";
import * as ActualAutoModelRoutingModule from "@/browser/hooks/useAutoModelRouting";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import {
  getDefaultAutoModelRoutingConfig,
  type AutoModelRoutingEvaluationStatus,
} from "@/common/types/autoModelRouting";
import {
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";
import { installDom } from "../../../../../tests/ui/dom";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualAPIModule = { ...ActualAPIModule };
const actualAutoModelRoutingModule = { ...ActualAutoModelRoutingModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
let mockEvaluationModel = DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL;

interface MockApi {
  config: { getAutoModelRoutingEvaluationStatus: ReturnType<typeof mock> };
  providers: { setProviderConfig: ReturnType<typeof mock> };
}

let mockApi: MockApi;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: mockApi, status: "connected" as const }),
  useOptionalAPI: () => ({ api: mockApi, status: "connected" as const }),
}));
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: null, loading: false }),
}));
void mock.module("@/browser/hooks/useAutoModelRouting", () => ({
  useAutoModelRouting: () => ({
    config: { ...getDefaultAutoModelRoutingConfig(), evaluationModel: mockEvaluationModel },
    setConfig: () => undefined,
    writeError: null,
  }),
}));

import { TypeSafeProviderCard } from "./TypeSafeProviderCard";

function createMockApi(status: Partial<AutoModelRoutingEvaluationStatus> = {}): MockApi {
  return {
    config: {
      getAutoModelRoutingEvaluationStatus: mock(
        (input?: { evaluationModel?: string }): Promise<AutoModelRoutingEvaluationStatus> =>
          Promise.resolve({
            evaluationModel: input?.evaluationModel ?? DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
            available: true,
            ...status,
          })
      ),
    },
    providers: {
      setProviderConfig: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    },
  };
}

describe("TypeSafeProviderCard", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/contexts/API", () => actualAPIModule);
    await mock.module("@/browser/hooks/useProvidersConfig", () => actualProvidersConfigModule);
    await mock.module("@/browser/hooks/useAutoModelRouting", () => actualAutoModelRoutingModule);
  });

  beforeEach(() => {
    cleanupDom = installDom();
    mockApi = createMockApi();
    mockEvaluationModel = DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  function statusText(container: HTMLElement) {
    return container.querySelector("[data-typesafe-provider-status]")?.textContent;
  }

  test("saving and clearing write the typesafe provider entry and drop the draft", async () => {
    const { getByLabelText, getByRole } = render(
      <TypeSafeProviderCard expanded onToggle={() => undefined} />
    );

    await userEvent.type(getByLabelText("API Key"), " sk-test ");
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.providers.setProviderConfig).toHaveBeenCalledTimes(1));
    expect(mockApi.providers.setProviderConfig.mock.calls[0]?.[0]).toEqual({
      provider: TYPESAFE_PROVIDER_KEY,
      keyPath: ["apiKey"],
      value: "sk-test",
    });
    // The draft is cleared so the key never lingers in the DOM.
    expect((getByLabelText("API Key") as HTMLInputElement).value).toBe("");

    fireEvent.click(getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(mockApi.providers.setProviderConfig).toHaveBeenCalledTimes(2));
    expect(mockApi.providers.setProviderConfig.mock.calls[1]?.[0]).toMatchObject({
      provider: TYPESAFE_PROVIDER_KEY,
      value: "",
    });
  });

  test("the status line shows the evaluator's reason when the key is missing", async () => {
    mockApi = createMockApi({ available: false, reason: "No TypeSafe API key configured" });
    const { container } = render(<TypeSafeProviderCard expanded onToggle={() => undefined} />);
    await waitFor(() => expect(statusText(container)).toBe("No TypeSafe API key configured"));
    expect(mockApi.config.getAutoModelRoutingEvaluationStatus.mock.calls[0]?.[0]).toEqual({
      evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
    });
  });

  test("the status probe follows a saved TypeSafe evaluator and falls back to the default otherwise", async () => {
    // A policy can allow the saved TypeSafe model while denying the default one.
    mockEvaluationModel = "typesafe:jev-2";
    const first = render(<TypeSafeProviderCard expanded onToggle={() => undefined} />);
    await waitFor(() =>
      expect(mockApi.config.getAutoModelRoutingEvaluationStatus).toHaveBeenCalledTimes(1)
    );
    expect(mockApi.config.getAutoModelRoutingEvaluationStatus.mock.calls[0]?.[0]).toEqual({
      evaluationModel: "typesafe:jev-2",
    });
    first.unmount();

    // Another provider's evaluator says nothing about the TypeSafe credential.
    mockApi = createMockApi();
    mockEvaluationModel = "anthropic:claude-haiku-4-5";
    render(<TypeSafeProviderCard expanded onToggle={() => undefined} />);
    await waitFor(() =>
      expect(mockApi.config.getAutoModelRoutingEvaluationStatus).toHaveBeenCalledTimes(1)
    );
    expect(mockApi.config.getAutoModelRoutingEvaluationStatus.mock.calls[0]?.[0]).toEqual({
      evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
    });
  });

  test("collapsing the card discards an unsaved key", async () => {
    const { getByLabelText, rerender } = render(
      <TypeSafeProviderCard expanded onToggle={() => undefined} />
    );
    await userEvent.type(getByLabelText("API Key"), "sk-unsaved");
    expect((getByLabelText("API Key") as HTMLInputElement).value).toBe("sk-unsaved");

    rerender(<TypeSafeProviderCard expanded={false} onToggle={() => undefined} />);
    rerender(<TypeSafeProviderCard expanded onToggle={() => undefined} />);
    expect((getByLabelText("API Key") as HTMLInputElement).value).toBe("");
    expect(mockApi.providers.setProviderConfig).not.toHaveBeenCalled();
  });

  test("a write rejected after the card collapsed still shows its error on the next expand", async () => {
    let settle: ((result: { success: false; error: string }) => void) | null = null;
    mockApi.providers.setProviderConfig.mockImplementation(
      () =>
        new Promise<{ success: false; error: string }>((resolve) => {
          settle = resolve;
        })
    );
    const { getByLabelText, getByRole, rerender, queryByText } = render(
      <TypeSafeProviderCard expanded onToggle={() => undefined} />
    );
    await userEvent.type(getByLabelText("API Key"), "sk-replacement");
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(settle).not.toBeNull());

    // Collapse while the write is in flight, then let it fail.
    rerender(<TypeSafeProviderCard expanded={false} onToggle={() => undefined} />);
    await act(() => {
      settle!({ success: false, error: "providers.jsonc is read-only" });
      return Promise.resolve();
    });
    rerender(<TypeSafeProviderCard expanded onToggle={() => undefined} />);
    expect(queryByText("providers.jsonc is read-only")).not.toBeNull();
    expect((getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed write surfaces the backend error", async () => {
    mockApi.providers.setProviderConfig.mockImplementation(() =>
      Promise.resolve({ success: false as const, error: "providers.jsonc is read-only" })
    );
    const { getByLabelText, getByRole, findByText } = render(
      <TypeSafeProviderCard expanded onToggle={() => undefined} />
    );
    await userEvent.type(getByLabelText("API Key"), "sk-test");
    fireEvent.click(getByRole("button", { name: "Save" }));
    expect(await findByText("providers.jsonc is read-only")).toBeTruthy();
  });
});
