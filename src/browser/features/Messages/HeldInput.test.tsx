import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";

import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { MODAL_DIALOG_OVERLAY_ATTRIBUTE } from "@/browser/utils/ui/keybinds";
import type { HeldInput as HeldInputData } from "@/common/orpc/types";
import { HeldInput } from "./HeldInput";

const workspaceId = "ws-transcript-only";

function heldInput(id: string): HeldInputData {
  return { id, reason: "interrupted", displayText: id, attachmentCount: 0, reviewCount: 0 };
}

/**
 * Transcript-only banners as TranscriptOnlyNoticePane renders them: the oldest one owns the
 * Discard shortcut, and a successful discard removes it (the backend's held-inputs-changed
 * event), which makes the next banner the target.
 */
function renderTranscriptOnlyBanners(ids: string[]) {
  const discarded: string[] = [];
  let removeHeldInput: (id: string) => void = () => undefined;
  const discardHeldInput = mock((input: { workspaceId: string; heldInputId: string }) => {
    discarded.push(input.heldInputId);
    act(() => removeHeldInput(input.heldInputId));
    return Promise.resolve({ success: true as const, data: undefined });
  });
  function Banners() {
    const [heldInputs, setHeldInputs] = useState(() => ids.map(heldInput));
    removeHeldInput = (id) => setHeldInputs((current) => current.filter((held) => held.id !== id));
    return heldInputs.map((held, index) => (
      <HeldInput
        key={held.id}
        workspaceId={workspaceId}
        heldInput={held}
        isShortcutTarget={index === 0}
        canSend={false}
      />
    ));
  }
  const view = render(
    <APIProvider client={createTestApiClient({ workspace: { discardHeldInput } })}>
      <Banners />
    </APIProvider>
  );
  return { view, discarded };
}

function pressDiscard(options: { repeat?: boolean } = {}) {
  act(() => {
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Backspace",
        ctrlKey: true,
        altKey: true,
        repeat: options.repeat ?? false,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

describe("HeldInput transcript-only Discard shortcut", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("an auto-repeated chord discards only the oldest held input", async () => {
    const { view, discarded } = renderTranscriptOnlyBanners(["held-1", "held-2", "held-3"]);
    pressDiscard();
    await waitFor(() => expect(view.queryByText("held-1")).toBeNull());
    // The key stays down: the next banner is now the target and must ignore the repeats.
    pressDiscard({ repeat: true });
    pressDiscard({ repeat: true });
    expect(discarded).toEqual(["held-1"]);
    // A fresh press still reaches the new target.
    pressDiscard();
    await waitFor(() => expect(discarded).toEqual(["held-1", "held-2"]));
  });

  test("does not discard the held input hidden behind an open modal", async () => {
    const { discarded } = renderTranscriptOnlyBanners(["held-1"]);
    const overlay = document.createElement("div");
    overlay.setAttribute(MODAL_DIALOG_OVERLAY_ATTRIBUTE, "");
    overlay.setAttribute("data-state", "open");
    document.body.appendChild(overlay);
    pressDiscard();
    expect(discarded).toEqual([]);
    // Closing the modal gives the shortcut back.
    overlay.remove();
    pressDiscard();
    await waitFor(() => expect(discarded).toEqual(["held-1"]));
  });
});
