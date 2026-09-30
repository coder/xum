import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  createTestApiClient,
  createTestConfig,
  type TestApiOverrides,
  type TestClientConfig,
} from "@/browser/testUtils";

type GoalDefaultsUpdate = Parameters<APIClient["config"]["updateGoalDefaults"]>[0];

import { GoalsSection } from "./GoalsSection";

function renderGoalsSection(config: { goalDefaults?: GoalDefaults } = {}) {
  const current: Partial<TestClientConfig> = { ...config };
  const updateGoalDefaults = mock(({ goalDefaults }: GoalDefaultsUpdate) => {
    // The real input is partial; the backend stores it normalized, as getConfig returns it.
    current.goalDefaults = normalizeGoalDefaults(goalDefaults);
    return Promise.resolve();
  });

  const mockApi = {
    config: {
      getConfig: mock(() => Promise.resolve(createTestConfig({ ...current }))),
      updateGoalDefaults,
    },
  } satisfies TestApiOverrides<APIClient>;

  // Inject the config-only client through the real provider; mocking the API module leaks
  // into later files.
  const view = render(
    <APIProvider client={createTestApiClient(mockApi)}>
      <ThemeProvider forcedTheme="dark">
        <GoalsSection />
      </ThemeProvider>
    </APIProvider>
  );

  return { view, updateGoalDefaults };
}

describe("GoalsSection", () => {
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

  test("renders default goal settings", async () => {
    const { view } = renderGoalsSection();

    const budgetInput = (await waitFor(() =>
      view.getByLabelText("Default goal budget in dollars")
    )) as HTMLInputElement;
    const turnInput = view.getByLabelText("Default goal turn cap") as HTMLInputElement;
    const requireBudget = view.getByLabelText("Always require explicit budget") as HTMLInputElement;

    expect(budgetInput.value).toBe("2.00");
    expect(turnInput.value).toBe("");
    expect(requireBudget.checked).toBe(true);
  });

  test("persists edited goal defaults", async () => {
    const { view, updateGoalDefaults } = renderGoalsSection({
      goalDefaults: { ...DEFAULT_GOAL_DEFAULTS, defaultBudgetCents: 300 },
    });

    const budgetInput = (await waitFor(() =>
      view.getByLabelText("Default goal budget in dollars")
    )) as HTMLInputElement;
    fireEvent.change(budgetInput, { target: { value: "3.50" } });
    fireEvent.blur(budgetInput);

    await waitFor(() => {
      expect(updateGoalDefaults).toHaveBeenLastCalledWith({
        goalDefaults: { ...DEFAULT_GOAL_DEFAULTS, defaultBudgetCents: 350 },
      });
    });

    const turnInput = view.getByLabelText("Default goal turn cap") as HTMLInputElement;
    fireEvent.change(turnInput, { target: { value: "25" } });
    fireEvent.blur(turnInput);

    await waitFor(() => {
      expect(updateGoalDefaults).toHaveBeenLastCalledWith({
        goalDefaults: { ...DEFAULT_GOAL_DEFAULTS, defaultBudgetCents: 350, defaultTurnCap: 25 },
      });
    });

    const requireBudget = view.getByLabelText("Always require explicit budget") as HTMLInputElement;
    fireEvent.click(requireBudget);

    await waitFor(() => {
      expect(updateGoalDefaults).toHaveBeenLastCalledWith({
        goalDefaults: {
          ...DEFAULT_GOAL_DEFAULTS,
          defaultBudgetCents: 350,
          defaultTurnCap: 25,
          alwaysRequireExplicitBudget: false,
        },
      });
    });
  });
});
