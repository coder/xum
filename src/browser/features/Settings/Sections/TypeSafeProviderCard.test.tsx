import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualAPIModule from "@/browser/contexts/API";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import type { AutoModelRoutingEvaluationStatus } from "@/common/types/autoModelRouting";
import {
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";
import { installDom } from "../../../../../tests/ui/dom";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualAPIModule = { ...ActualAPIModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };

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
  });

  beforeEach(() => {
    cleanupDom = installDom();
    mockApi = createMockApi();
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
