import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";

import { readPersistedString, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getPendingAiSelection,
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
} from "@/browser/utils/aiSelectionIntent";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import { repairLocalModelPreferencesForRemovedProvider } from "./modelPreferenceRepair";

const REMOVED_PROVIDER = "removed-provider";
const OTHER_PROVIDER = "other-provider";

let cleanupDom: (() => void) | null = null;

describe("repairLocalModelPreferencesForRemovedProvider", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    updatePersistedState<undefined>(LAST_CUSTOM_MODEL_PROVIDER_KEY, undefined);
    resetAiSelectionIntentForTests();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("drops unsent model picks only when they belong to the removed provider", () => {
    const unaffectedModel = `${OTHER_PROVIDER}:workspace-model`;
    markAiSelectionIntent("affected", "model", `${REMOVED_PROVIDER}:workspace-model`);
    markAiSelectionIntent("unaffected", "model", unaffectedModel);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER);

    expect(getPendingAiSelection("affected", "exec", "model")).toBeUndefined();
    expect(getPendingAiSelection("unaffected", "exec", "model")).toBe(unaffectedModel);
  });

  test("clears last custom model provider only when it matches the removed provider", () => {
    updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, REMOVED_PROVIDER);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER);

    expect(readPersistedString(LAST_CUSTOM_MODEL_PROVIDER_KEY)).toBe("");

    updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, OTHER_PROVIDER);

    repairLocalModelPreferencesForRemovedProvider(REMOVED_PROVIDER);

    expect(readPersistedString(LAST_CUSTOM_MODEL_PROVIDER_KEY)).toBe(OTHER_PROVIDER);
  });
});
