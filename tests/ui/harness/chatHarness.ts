import { act, fireEvent, waitFor } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputKey } from "@/common/constants/storage";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

export class ChatHarness {
  constructor(
    private readonly container: HTMLElement,
    private readonly workspaceId: string
  ) {}

  private async getActiveTextarea(): Promise<HTMLTextAreaElement> {
    return waitFor(
      () => {
        // There can be multiple ChatInput instances mounted (e.g., ProjectPage + Workspace view).
        // Use the last textarea in DOM order to target the active view.
        const textareas = Array.from(
          this.container.querySelectorAll('textarea[aria-label="Message Claude"]')
        );

        if (textareas.length === 0) {
          throw new Error("Chat textarea not found");
        }

        // Prefer the last enabled textarea in DOM order (workspace view should be enabled once ready).
        const enabled = [...textareas].reverse().find((el) => !el.disabled);
        if (!enabled) {
          throw new Error(`Chat textarea is disabled (found ${textareas.length})`);
        }

        return enabled;
      },
      { timeout: 10_000 }
    );
  }

  async send(text: string): Promise<void> {
    const textarea = await this.getActiveTextarea();
    textarea.focus();

    // happy-dom + React can be flaky for synthetic textarea input events.
    // Since ChatInput uses usePersistedState, updating the persisted key is both deterministic
    // and exercises the real UI state path.
    act(() => {
      updatePersistedState(getInputKey(this.workspaceId), text);
    });

    await waitFor(
      () => {
        if (textarea.value !== text) {
          throw new Error(`Textarea value mismatch: "${textarea.value}"`);
        }
      },
      { timeout: 5_000 }
    );

    const chatInputSection = textarea.closest('[data-component="ChatInputSection"]');
    if (!chatInputSection) {
      throw new Error("ChatInputSection not found for textarea");
    }

    const sendButton = await waitFor(
      () => {
        const el = chatInputSection.querySelector(
          'button[aria-label="Send message"]'
        );
        if (!el) {
          throw new Error("Send button not found");
        }
        if (el.disabled) {
          throw new Error("Send button disabled");
        }
        return el;
      },
      { timeout: 10_000 }
    );

    fireEvent.click(sendButton);
  }

  async expectTranscriptContains(
    needle: string | RegExp,
    timeoutMs = 30_000
  ): Promise<void> {
    await waitFor(
      () => {
        const text = this.container.textContent ?? "";
        if (typeof needle === "string") {
          expect(text).toContain(needle);
        } else {
          expect(text).toMatch(needle);
        }
      },
      { timeout: timeoutMs }
    );
  }

  /**
   * Wait for the workspace to finish streaming (handleStreamEnd fully processed).
   * Waits through both the start-pending phase (isStarting) and active streaming
   * phase (canInterrupt) before resolving — ensuring all lifecycle callbacks
   * (recency update, onResponseComplete) have completed.
   */
  async expectStreamComplete(timeoutMs = 30_000): Promise<void> {
    await waitFor(
      () => {
        const state = workspaceStore.getWorkspaceSidebarState(this.workspaceId);
        // isStarting = pendingStreamStartTime !== null && !canInterrupt.
        // In gated flows ([mock:wait-start]), the stream hasn't started yet
        // so canInterrupt is false but isStarting is true — we must wait.
        if (state.isStarting) {
          throw new Error("Workspace still waiting for stream-start");
        }
        // canInterrupt = activeStreams.length > 0; false = no active streams.
        // By the time WorkspaceStore bumps state after handleStreamEnd,
        // all synchronous work (recency update, onResponseComplete callback)
        // has already completed.
        if (state.canInterrupt) {
          throw new Error("Workspace still streaming");
        }
      },
      { timeout: timeoutMs }
    );
  }

  async expectTranscriptNotContains(needle: string, timeoutMs = 30_000): Promise<void> {
    await waitFor(
      () => {
        const text = this.container.textContent ?? "";
        expect(text).not.toContain(needle);
      },
      { timeout: timeoutMs }
    );
  }

  /**
   * Type text into the chat input without sending.
   * Used to simulate a user draft that should be preserved during operations.
   */
  async typeWithoutSending(text: string): Promise<void> {
    const textarea = await this.getActiveTextarea();
    textarea.focus();

    act(() => {
      updatePersistedState(getInputKey(this.workspaceId), text);
    });

    await waitFor(
      () => {
        if (textarea.value !== text) {
          throw new Error(`Textarea value mismatch: "${textarea.value}"`);
        }
      },
      { timeout: 5_000 }
    );
  }

  /**
   * Get the current value of the chat input.
   */
  async getInputValue(): Promise<string> {
    const textarea = await this.getActiveTextarea();
    return textarea.value;
  }

  /**
   * Assert the chat input contains the expected text.
   */
  async expectInputValue(expected: string, timeoutMs = 5_000): Promise<void> {
    await waitFor(
      async () => {
        const value = await this.getInputValue();
        expect(value).toBe(expected);
      },
      { timeout: timeoutMs }
    );
  }

  /**
   * Get the currently displayed model name from the ModelSelector.
   * Returns the text shown in the model selector button (not the full model ID).
   */
  async getModelSelectorText(): Promise<string> {
    return waitFor(
      () => {
        const modelSelectorGroup = this.container.querySelector(
          '[data-component="ModelSelectorGroup"]'
        );
        if (!modelSelectorGroup) {
          throw new Error("ModelSelectorGroup not found");
        }
        // The model name is displayed in a button with role="combobox"
        const combobox = modelSelectorGroup.querySelector('[role="combobox"]');
        if (!combobox) {
          throw new Error("Model selector combobox not found");
        }
        return combobox.textContent?.trim() ?? "";
      },
      { timeout: 5_000 }
    );
  }
}
