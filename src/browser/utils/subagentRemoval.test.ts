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
  const removeSubagent = mock((_workspaceId: string, _acknowledged: unknown) =>
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
  return { api, confirm, removeSubagent, run };
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
    // The removal carries the confirmed preview, so the backend can refuse if the work changed.
    expect(confirmed.removeSubagent).toHaveBeenCalledWith("child", preview);
  });

  test("reports failed previews and refused removals as errors, and leftovers as warnings", async () => {
    const failedPreview = setup({
      preview: { success: false, error: "This is not a sub-agent." },
      confirmed: true,
    });
    expect(await failedPreview.run()).toEqual({
      kind: "error",
      message: "This is not a sub-agent.",
    });
    expect(failedPreview.confirm).not.toHaveBeenCalled();

    const rejected = setup({ preview: { success: false, error: "unused" }, confirmed: true });
    rejected.api.tasks.previewRemoval = () => Promise.reject(new Error("connection lost"));
    expect(await rejected.run()).toEqual({ kind: "error", message: "connection lost" });

    const refused = setup({
      preview: { success: true, data: { summary: null, paths: [] } },
      confirmed: true,
      removal: { success: false, error: "Stop the sub-agent before removing it." },
    });
    expect(await refused.run()).toEqual({
      kind: "error",
      message: "Stop the sub-agent before removing it.",
    });

    // A forced removal that left something behind says so as a warning, not a failure (#5190).
    const leftover = setup({
      preview: { success: true, data: { summary: null, paths: [] } },
      confirmed: true,
      removal: {
        success: true,
        warnings: [{ kind: "leftover", description: "Container xum-child is still running." }],
      },
    });
    const notice = await leftover.run();
    expect(notice?.kind).toBe("warning");
    expect(notice?.message).toContain("Container xum-child is still running.");
  });
});
