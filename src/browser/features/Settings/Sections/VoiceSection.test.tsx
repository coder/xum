import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import * as voiceStoreModule from "@/browser/stores/LocalVoiceStore";
import { localVoiceStore } from "@/browser/stores/LocalVoiceStore";
import { LOCAL_VOICE_MODELS } from "@/common/constants/localVoiceModels";
import { VOICE_MODEL_KEY } from "@/common/constants/storage";
import { VoiceSection } from "./VoiceSection";

type VoiceState = ReturnType<typeof localVoiceStore.getSnapshot>;
let state: VoiceState;
const listeners = new Set<() => void>();

function updateVoiceState(patch: Partial<VoiceState>) {
  act(() => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  });
}

function renderVoiceSettings() {
  return render(
    <RouterProvider>
      <SettingsProvider>
        <VoiceSection />
      </SettingsProvider>
    </RouterProvider>
  );
}

describe("VoiceSection", () => {
  let cleanupDom: () => void;
  let restoreSpies: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
    state = { downloaded: [], loading: false, operation: null, error: null };
    updatePersistedState(VOICE_MODEL_KEY, "openai");
    const supported = spyOn(voiceStoreModule, "supportsLocalVoice").mockReturnValue(true);
    const snapshot = spyOn(localVoiceStore, "getSnapshot").mockImplementation(() => state);
    const subscribe = spyOn(localVoiceStore, "subscribe").mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const download = spyOn(localVoiceStore, "download").mockResolvedValue(undefined);
    const remove = spyOn(localVoiceStore, "remove").mockResolvedValue(undefined);
    const cancel = spyOn(localVoiceStore, "cancelDownload").mockImplementation(() => undefined);
    restoreSpies = () => {
      download.mockRestore();
      remove.mockRestore();
      cancel.mockRestore();
      supported.mockRestore();
      snapshot.mockRestore();
      subscribe.mockRestore();
    };
  });

  afterEach(() => {
    cleanup();
    restoreSpies();
    listeners.clear();
    cleanupDom();
  });

  test("enables local selection only after a download and persists explicit cloud selection", () => {
    const view = renderVoiceSettings();
    const local = view.getByRole("radio", { name: /Parakeet TDT v3/ });
    expect(local.hasAttribute("disabled")).toBe(true);
    updateVoiceState({ downloaded: ["parakeet-v3"] });
    expect(local.hasAttribute("disabled")).toBe(false);
    fireEvent.click(local);
    expect(local.matches(":checked")).toBe(true);
    expect(readPersistedState(VOICE_MODEL_KEY, "openai")).toBe("parakeet-v3");

    fireEvent.click(view.getByRole("radio", { name: /OpenAI Whisper/ }));
    expect(local.matches(":checked")).toBe(false);
    expect(readPersistedState(VOICE_MODEL_KEY, "parakeet-v3")).toBe("openai");
  });

  test("disables model actions during loading and other model operations", () => {
    state.loading = true;
    const view = renderVoiceSettings();
    const download = view.getByRole("button", {
      name: "Download Parakeet TDT v2",
    });
    expect(download.hasAttribute("disabled")).toBe(true);
    updateVoiceState({ loading: false });
    expect(download.hasAttribute("disabled")).toBe(false);
    updateVoiceState({
      downloaded: ["parakeet-v3"],
      operation: { id: "parakeet-v2", kind: "remove", bytes: 0 },
    });
    expect(download.hasAttribute("disabled")).toBe(true);
    expect(
      view.getByRole("button", { name: "Remove Parakeet TDT v3" }).hasAttribute("disabled")
    ).toBe(true);
    expect(view.getByRole("radio", { name: /Parakeet TDT v3/ }).hasAttribute("disabled")).toBe(
      true
    );
    expect(view.getByRole("radio", { name: /OpenAI Whisper/ }).hasAttribute("disabled")).toBe(
      false
    );
  });

  test("keeps local controls disabled when the browser lacks local inference support", () => {
    spyOn(voiceStoreModule, "supportsLocalVoice").mockReturnValue(false);
    state.downloaded = ["parakeet-v3"];
    const view = renderVoiceSettings();
    expect(view.getByRole("radio", { name: /Parakeet TDT v3/ }).hasAttribute("disabled")).toBe(
      true
    );
    expect(
      view.getByRole("button", { name: "Download Parakeet TDT v2" }).hasAttribute("disabled")
    ).toBe(true);
    expect(view.getByRole("status")).not.toBeNull();
  });

  test("starts the requested download and exposes progress and cancellation", () => {
    const download = spyOn(localVoiceStore, "download").mockResolvedValue(undefined);
    const cancel = spyOn(localVoiceStore, "cancelDownload").mockImplementation(() => undefined);
    const view = renderVoiceSettings();
    fireEvent.click(view.getByRole("button", { name: "Download Parakeet TDT v3" }));
    expect(download).toHaveBeenCalledWith("parakeet-v3");
    const total = LOCAL_VOICE_MODELS["parakeet-v3"].files.reduce(
      (sum, file) => sum + file.bytes,
      0
    );
    updateVoiceState({ operation: { id: "parakeet-v3", kind: "download", bytes: total / 2 } });
    expect(view.getByRole("status").textContent).toBe("50%");
    expect(view.queryByRole("button", { name: "Download Parakeet TDT v3" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Cancel download" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("removes the requested model without selecting the cloud provider", () => {
    const remove = spyOn(localVoiceStore, "remove").mockResolvedValue(undefined);
    state.downloaded = ["parakeet-v3", "parakeet-v2"];
    updatePersistedState(VOICE_MODEL_KEY, "parakeet-v3");
    const view = renderVoiceSettings();
    fireEvent.click(view.getByRole("button", { name: "Remove Parakeet TDT v3" }));
    expect(remove).toHaveBeenCalledWith("parakeet-v3");
    updateVoiceState({ downloaded: ["parakeet-v2"] });
    expect(readPersistedState(VOICE_MODEL_KEY, "openai")).toBe("parakeet-v3");
    expect(view.getByRole("radio", { name: /OpenAI Whisper/ }).matches(":checked")).toBe(false);
    expect(view.getByRole("status")).not.toBeNull();
  });

  test("shows operation errors and clears them when the user retries", async () => {
    const download = spyOn(localVoiceStore, "download").mockRejectedValueOnce(
      new Error("Storage unavailable")
    );
    const view = renderVoiceSettings();
    fireEvent.click(view.getByRole("button", { name: "Download Parakeet TDT v3" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Storage unavailable"));
    download.mockResolvedValue(undefined);
    fireEvent.click(view.getByRole("button", { name: "Download Parakeet TDT v3" }));
    expect(view.queryByRole("alert")).toBeNull();
    updateVoiceState({ error: "Model verification failed" });
    expect(view.getByRole("alert").textContent).toBe("Model verification failed");
  });

  test("does not select the cloud provider for an invalid saved model", () => {
    updatePersistedState(VOICE_MODEL_KEY, "removed-model");
    state.loading = true;
    const view = renderVoiceSettings();
    expect(view.queryByRole("status")).toBeNull();
    updateVoiceState({ loading: false });
    expect(view.getByRole("status")).not.toBeNull();
    expect(view.getAllByRole("radio").every((radio) => !radio.matches(":checked"))).toBe(true);
    fireEvent.click(view.getByRole("radio", { name: /OpenAI Whisper/ }));
    expect(view.queryByRole("status")).toBeNull();
    expect(readPersistedState(VOICE_MODEL_KEY, "removed-model")).toBe("openai");
  });

  test("opens provider settings through the settings router", () => {
    const view = renderVoiceSettings();
    fireEvent.click(view.getByRole("button", { name: "Open provider settings" }));
    expect(window.location.pathname).toBe("/settings/providers");
  });
});
