import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { APIProvider } from "@/browser/contexts/API";
import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import { createTestApiClient } from "@/browser/testUtils";
import { DelegatedCreationInterruptedNotice } from "./DelegatedCreationInterruptedBanner";

const workspaceId = "orphan";

function renderNotice(options: {
  confirmed: boolean;
  removal?: { success: boolean; error?: string };
  keep?: { success: true; data: undefined } | { success: false; error: string };
}) {
  const confirm = mock((_options: ConfirmDialogOptions) => Promise.resolve(options.confirmed));
  const removeWorkspace = mock((..._args: unknown[]) =>
    Promise.resolve(options.removal ?? { success: true })
  );
  const keepInterruptedDelegatedWorkspace = mock((_input: { workspaceId: string }) =>
    Promise.resolve(options.keep ?? { success: true as const, data: undefined })
  );
  const view = render(
    <APIProvider client={createTestApiClient({ workspace: { keepInterruptedDelegatedWorkspace } })}>
      <DelegatedCreationInterruptedNotice
        workspaceId={workspaceId}
        workspaceName="fix-login-redirect"
        confirm={confirm}
        removeWorkspace={removeWorkspace}
      />
    </APIProvider>
  );
  return { view, confirm, removeWorkspace, keepInterruptedDelegatedWorkspace };
}

describe("DelegatedCreationInterruptedNotice (#4983)", () => {
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

  test("Remove asks first, then runs the normal removal without force", async () => {
    const { view, confirm, removeWorkspace } = renderNotice({ confirmed: true });

    fireEvent.click(view.getByRole("button", { name: "Remove workspace…" }));

    await waitFor(() => expect(removeWorkspace).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ confirmVariant: "destructive" });
    // No options argument: the removal is never forced.
    expect(removeWorkspace.mock.calls[0]).toEqual([workspaceId]);
  });

  test("a declined confirmation removes nothing", async () => {
    const { view, confirm, removeWorkspace } = renderNotice({ confirmed: false });

    fireEvent.click(view.getByRole("button", { name: "Remove workspace…" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const button = view.getByRole("button", { name: "Remove workspace…" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  test("a refused removal is shown in the banner", async () => {
    const error = "Workspace has uncommitted or untracked changes";
    const { view } = renderNotice({ confirmed: true, removal: { success: false, error } });

    fireEvent.click(view.getByRole("button", { name: "Remove workspace…" }));

    expect((await view.findByRole("alert")).textContent).toBe(error);
  });

  test("Keep clears the flag through the backend, and shows its refusal", async () => {
    const { view, keepInterruptedDelegatedWorkspace } = renderNotice({
      confirmed: false,
      keep: { success: false, error: "Workspace not found" },
    });

    fireEvent.click(view.getByRole("button", { name: "Keep workspace" }));

    expect((await view.findByRole("alert")).textContent).toBe("Workspace not found");
    expect(keepInterruptedDelegatedWorkspace.mock.calls[0]?.[0]).toEqual({ workspaceId });
  });
});
