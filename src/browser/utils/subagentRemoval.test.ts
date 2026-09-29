import { describe, expect, mock, test } from "bun:test";

import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import { createTestApiClient } from "@/browser/testUtils";
import type { WorkspaceRemoveResult } from "@/common/types/workspace";
import { confirmAndRemoveSubagent } from "./subagentRemoval";

function setup(options: {
  preview:
    | { success: true; data: { summary: string | null; paths: string[] } }
    | { success: false; error: string };
  confirmed: boolean;
  removal?: WorkspaceRemoveResult;
}) {
  const confirm = mock((_options: ConfirmDialogOptions) => Promise.resolve(options.confirmed));
  const removeSubagent = mock((_workspaceId: string) =>
    Promise.resolve(options.removal ?? { success: true })
  );
  const api = createTestApiClient({
    tasks: { previewRemoval: () => Promise.resolve(options.preview) },
  });
  const run = () =>
    confirmAndRemoveSubagent({
      api,
      confirm,
      removeSubagent,
      workspaceId: "child",
      title: "Child",
    });
  return { confirm, removeSubagent, run };
}

describe("confirmAndRemoveSubagent (#5106)", () => {
  test("lists the unpreserved work and removes only after the user confirms", async () => {
    const preview = {
      summary: "Removing this sub-agent would delete files.",
      paths: ["notes.txt"],
    };
    const cancelled = setup({ preview: { success: true, data: preview }, confirmed: false });
    expect(await cancelled.run()).toBeNull();
    expect(cancelled.confirm.mock.calls[0]?.[0]).toMatchObject({
      description: preview.summary,
      details: { items: ["notes.txt"] },
    });
    expect(cancelled.removeSubagent).not.toHaveBeenCalled();

    const confirmed = setup({ preview: { success: true, data: preview }, confirmed: true });
    expect(await confirmed.run()).toBeNull();
    expect(confirmed.removeSubagent).toHaveBeenCalledWith("child");
  });

  test("reports a failed preview without asking, and a refused removal after confirming", async () => {
    const failedPreview = setup({
      preview: { success: false, error: "This is not a sub-agent." },
      confirmed: true,
    });
    expect(await failedPreview.run()).toBe("This is not a sub-agent.");
    expect(failedPreview.confirm).not.toHaveBeenCalled();

    const refused = setup({
      preview: { success: true, data: { summary: null, paths: [] } },
      confirmed: true,
      removal: { success: false, error: "Stop the sub-agent before removing it." },
    });
    expect(await refused.run()).toBe("Stop the sub-agent before removing it.");
  });
});
