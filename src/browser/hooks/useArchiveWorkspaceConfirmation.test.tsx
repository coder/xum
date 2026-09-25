import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { installDom } from "../../../tests/ui/dom";
import {
  useArchiveWorkspaceConfirmation,
  type UseArchiveWorkspaceConfirmationOptions,
} from "./useArchiveWorkspaceConfirmation";

type PreflightResult = Awaited<
  ReturnType<UseArchiveWorkspaceConfirmationOptions["preflightArchiveWorkspace"]>
>;
type ArchiveResult = Awaited<
  ReturnType<UseArchiveWorkspaceConfirmationOptions["archiveWorkspace"]>
>;

const WORKSPACE_ID = "ws-1";
const READY: PreflightResult = { success: true, data: { kind: "ready" } };
const ARCHIVED: ArchiveResult = { success: true, data: { kind: "archived" } };

function lossy(paths: string[]) {
  return { success: true, data: { kind: "confirm-lossy-untracked-files" as const, paths } };
}

function setup(overrides: Partial<UseArchiveWorkspaceConfirmationOptions> = {}) {
  const preflightArchiveWorkspace = mock(
    (_workspaceId: string): Promise<PreflightResult> => Promise.resolve(READY)
  );
  const archiveWorkspace = mock(
    (_workspaceId: string, _options?: { acknowledgedUntrackedPaths?: string[] }) =>
      Promise.resolve(ARCHIVED)
  );
  const showError = mock(
    (_workspaceId: string, _error: string, _anchorEl?: HTMLElement) => undefined
  );
  const options: UseArchiveWorkspaceConfirmationOptions = {
    preflightArchiveWorkspace,
    archiveWorkspace,
    isArchiving: () => false,
    isStreaming: () => false,
    getDisplayTitle: () => "Feature work",
    showError,
    ...overrides,
  };
  const view = renderHook(() => useArchiveWorkspaceConfirmation(options));
  const request = (anchorEl?: HTMLElement) =>
    act(() => view.result.current.requestArchive(WORKSPACE_ID, anchorEl));
  const confirm = () => act(async () => view.result.current.modalProps.onConfirm());
  return {
    view,
    request,
    confirm,
    preflightArchiveWorkspace: (overrides.preflightArchiveWorkspace ??
      preflightArchiveWorkspace) as typeof preflightArchiveWorkspace,
    archiveWorkspace: (overrides.archiveWorkspace ?? archiveWorkspace) as typeof archiveWorkspace,
    showError: (overrides.showError ?? showError) as typeof showError,
  };
}

describe("useArchiveWorkspaceConfirmation", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("archives immediately when preflight is ready and nothing is streaming", async () => {
    const { view, request, archiveWorkspace } = setup();

    await request();

    expect(archiveWorkspace.mock.calls).toEqual([[WORKSPACE_ID, undefined]]);
    expect(view.result.current.modalProps.isOpen).toBe(false);
  });

  test("does nothing while an archive for the workspace is already in flight", async () => {
    const { request, preflightArchiveWorkspace, archiveWorkspace } = setup({
      isArchiving: () => true,
    });

    await request();

    expect(preflightArchiveWorkspace).not.toHaveBeenCalled();
    expect(archiveWorkspace).not.toHaveBeenCalled();
  });

  test("reports preflight failures at the triggering control without archiving", async () => {
    const anchor = document.createElement("button");
    const { request, archiveWorkspace, showError } = setup({
      preflightArchiveWorkspace: mock(() => Promise.resolve({ success: false, error: "no git" })),
    });

    await request(anchor);

    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(showError.mock.calls).toEqual([[WORKSPACE_ID, "no git", anchor]]);
  });

  test("confirms untracked-file loss before archiving with the acknowledged paths", async () => {
    const { view, request, confirm, archiveWorkspace } = setup({
      preflightArchiveWorkspace: mock(() => Promise.resolve(lossy(["a.txt"]))),
    });

    await request();

    const modal = view.result.current.modalProps;
    expect(modal.isOpen).toBe(true);
    expect(modal.title).toBe("Archive workspace with untracked files?");
    expect(modal.confirmLabel).toBe("Archive and delete files");
    expect(modal.warning).toContain("a.txt");
    expect(archiveWorkspace).not.toHaveBeenCalled();

    await confirm();

    expect(archiveWorkspace.mock.calls).toEqual([
      [WORKSPACE_ID, { acknowledgedUntrackedPaths: ["a.txt"] }],
    ]);
    expect(view.result.current.modalProps.isOpen).toBe(false);
  });

  test("confirms interrupting an active stream, then archives without acknowledged paths", async () => {
    const { view, request, confirm, archiveWorkspace } = setup({ isStreaming: () => true });

    await request();

    expect(view.result.current.modalProps.title).toBe('Archive "Feature work" while streaming?');
    expect(view.result.current.modalProps.confirmLabel).toBe("Archive");

    await confirm();

    expect(archiveWorkspace.mock.calls).toEqual([[WORKSPACE_ID, undefined]]);
  });

  test("falls back to a generic streaming title when the workspace has no display title", async () => {
    const { view, request } = setup({ isStreaming: () => true, getDisplayTitle: () => "" });

    await request();

    expect(view.result.current.modalProps.title).toBe("Archive chat?");
  });

  test("cancel closes the confirmation without archiving", async () => {
    const { view, request, archiveWorkspace } = setup({ isStreaming: () => true });

    await request();
    act(() => view.result.current.modalProps.onCancel());

    expect(view.result.current.modalProps.isOpen).toBe(false);
    expect(archiveWorkspace).not.toHaveBeenCalled();
  });

  test("asks again when the archive call itself finds untracked files", async () => {
    let attempt = 0;
    const archiveWorkspace = mock(
      (_workspaceId: string, _options?: { acknowledgedUntrackedPaths?: string[] }) => {
        attempt += 1;
        return Promise.resolve(attempt === 1 ? lossy(["a.txt", "late.txt"]) : ARCHIVED);
      }
    );
    const { view, request, confirm, showError } = setup({
      archiveWorkspace,
      preflightArchiveWorkspace: mock(() => Promise.resolve(lossy(["a.txt"]))),
      isStreaming: () => true,
    });

    await request();
    expect(view.result.current.modalProps.warning).toContain("interrupt");
    await confirm();

    const modal = view.result.current.modalProps;
    expect(modal.isOpen).toBe(true);
    expect(modal.warning).toContain("late.txt");
    // The user already confirmed the stream interruption; do not repeat it on the retry.
    expect(modal.warning).not.toContain("interrupt");

    await confirm();

    expect(archiveWorkspace.mock.calls).toEqual([
      [WORKSPACE_ID, { acknowledgedUntrackedPaths: ["a.txt"] }],
      [WORKSPACE_ID, { acknowledgedUntrackedPaths: ["a.txt", "late.txt"] }],
    ]);
    expect(showError).not.toHaveBeenCalled();
  });

  test("reopens with fresh paths when a confirmed archive fails after new files appear", async () => {
    let preflightCalls = 0;
    const preflightArchiveWorkspace = mock(() => {
      preflightCalls += 1;
      return Promise.resolve(lossy(preflightCalls === 1 ? ["a.txt"] : ["a.txt", "b.txt"]));
    });
    const { view, request, confirm, showError } = setup({
      preflightArchiveWorkspace,
      archiveWorkspace: mock(() =>
        Promise.resolve({ success: false, error: "Untracked files changed" })
      ),
    });

    await request();
    await confirm();

    expect(preflightArchiveWorkspace).toHaveBeenCalledTimes(2);
    expect(view.result.current.modalProps.isOpen).toBe(true);
    expect(view.result.current.modalProps.warning).toContain("b.txt");
    expect(showError).not.toHaveBeenCalled();
  });

  test("surfaces the archive error when a confirmed archive fails with unchanged paths", async () => {
    const preflightArchiveWorkspace = mock(() => Promise.resolve(lossy(["a.txt"])));
    const { view, request, confirm, showError } = setup({
      preflightArchiveWorkspace,
      archiveWorkspace: mock(() => Promise.resolve({ success: false, error: "snapshot failed" })),
    });

    await request();
    await confirm();

    expect(preflightArchiveWorkspace).toHaveBeenCalledTimes(2);
    expect(showError.mock.calls).toEqual([[WORKSPACE_ID, "snapshot failed", undefined]]);
    expect(view.result.current.modalProps.isOpen).toBe(false);
  });
});
