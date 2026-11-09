import { describe, expect, mock, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import type { ConfirmDialogOptions } from "@/browser/contexts/ConfirmDialogContext";
import type {
  WorkspaceBackgroundProcessBlocker,
  WorkspaceRemoveResult,
} from "@/common/types/workspace";
import { confirmAndRemoveWorkspace } from "./confirmAndRemoveWorkspace";

const unknownRecord: WorkspaceBackgroundProcessBlocker = {
  workspaceId: "workspace-1",
  processId: "process-1",
  recordPath: "/sessions/workspace-1/processes/process-1",
  state: "unknown",
  reason: "The process record has no metadata.",
};

function blockedResult(
  backgroundProcesses: WorkspaceBackgroundProcessBlocker[] = [unknownRecord]
): WorkspaceRemoveResult {
  return { success: false, error: "Background processes block removal", backgroundProcesses };
}

function setup(results: WorkspaceRemoveResult[], confirmed = true) {
  const removeWorkspace = mock(
    (_workspaceId: string, _options?: Parameters<APIClient["workspace"]["remove"]>[0]["options"]) =>
      Promise.resolve(results.shift()!)
  );
  const confirm = mock((_options: ConfirmDialogOptions) => Promise.resolve(confirmed));
  return { removeWorkspace, confirm, workspaceId: "workspace-1" };
}

describe("confirmAndRemoveWorkspace", () => {
  test("returns success without confirmation", async () => {
    const result: WorkspaceRemoveResult = { success: true };
    const params = setup([result]);

    expect(await confirmAndRemoveWorkspace(params)).toBe(result);
    expect(params.confirm).not.toHaveBeenCalled();
    expect(params.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  test("does not prompt for an unrelated failure", async () => {
    const result: WorkspaceRemoveResult = { success: false, error: "Uncommitted changes" };
    const params = setup([result]);

    expect(await confirmAndRemoveWorkspace(params)).toBe(result);
    expect(params.confirm).not.toHaveBeenCalled();
    expect(params.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    "does not prompt for running processes with unknown records: %s",
    async (mixed) => {
      const running = { ...unknownRecord, processId: "live-process", state: "running" as const };
      const result = blockedResult(mixed ? [unknownRecord, running] : [running]);
      const params = setup([result]);

      expect(await confirmAndRemoveWorkspace(params)).toBe(result);
      expect(params.confirm).not.toHaveBeenCalled();
      expect(params.removeWorkspace).toHaveBeenCalledTimes(1);
    }
  );

  test("cancels without a second removal", async () => {
    const result = blockedResult();
    const params = setup([result], false);

    expect(await confirmAndRemoveWorkspace(params)).toBe(result);
    expect(params.confirm).toHaveBeenCalledTimes(1);
    expect(params.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  test("shows each record path and reason before the retry", async () => {
    const secondRecord = {
      ...unknownRecord,
      processId: "process-2",
      recordPath: "/sessions/workspace-1/processes/process-2",
      reason: "The process record is invalid.",
    };
    const params = setup([blockedResult([unknownRecord, secondRecord]), { success: true }]);

    await confirmAndRemoveWorkspace(params);

    const items = params.confirm.mock.calls[0][0].details?.items ?? [];
    for (const record of [unknownRecord, secondRecord]) {
      expect(
        items.some((item) => item.includes(record.recordPath) && item.includes(record.reason))
      ).toBe(true);
    }
  });

  test("acknowledges only shown records and preserves the original options", async () => {
    const result: WorkspaceRemoveResult = { success: true };
    const params = setup([blockedResult(), result]);
    const options = {
      force: true,
      acknowledgedDescendantIds: ["child-1"],
      acknowledgedUnknownProcessRecords: ["/previously-shown-record"],
    };

    expect(await confirmAndRemoveWorkspace({ ...params, options })).toBe(result);
    expect(params.removeWorkspace.mock.calls).toEqual([
      ["workspace-1", options],
      [
        "workspace-1",
        { ...options, acknowledgedUnknownProcessRecords: [unknownRecord.recordPath] },
      ],
    ]);
    expect(options.acknowledgedUnknownProcessRecords).toEqual(["/previously-shown-record"]);
  });

  test("does not add force or descendant acknowledgment", async () => {
    const failure = {
      ...blockedResult(),
      descendants: [{ workspaceId: "child-1", title: "Child", active: false }],
    };
    const params = setup([failure, { success: false, error: "A descendant blocks removal" }]);

    await confirmAndRemoveWorkspace(params);

    expect(params.removeWorkspace.mock.calls[1]).toEqual([
      "workspace-1",
      { acknowledgedUnknownProcessRecords: [unknownRecord.recordPath] },
    ]);
  });

  test.each(["unknown", "running"] as const)(
    "returns changed %s state without another prompt or retry",
    async (state) => {
      const changed = blockedResult([
        { ...unknownRecord, recordPath: "/sessions/workspace-1/processes/new-record", state },
      ]);
      const params = setup([blockedResult(), changed]);

      expect(await confirmAndRemoveWorkspace(params)).toBe(changed);
      expect(params.confirm).toHaveBeenCalledTimes(1);
      expect(params.removeWorkspace).toHaveBeenCalledTimes(2);
    }
  );
});
