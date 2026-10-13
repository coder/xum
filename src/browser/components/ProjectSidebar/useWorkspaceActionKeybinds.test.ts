// Bootstrap the DOM before this file's imports evaluate (see tests/ui/dom.ts).
import { installDom } from "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceActionKeybinds } from "./useWorkspaceActionKeybinds";

// Fork workspace (Ctrl+Alt+Shift+B) and Stop container (Ctrl+Alt+Shift+X) act on the selected
// workspace, and only where its menu would offer them (#6328).

function workspace(overrides: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
  const metadata: FrontendWorkspaceMetadata = {
    id: "ws-1",
    name: "ws-1",
    projectName: "demo",
    projectPath: "/projects/demo",
    namedWorkspacePath: "/projects/demo/ws-1",
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    ...overrides,
  };
  return metadata;
}
const repoWorkspace = workspace({});
const devcontainerWorkspace = workspace({
  runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
});
const scratchWorkspace = workspace({ kind: "scratch" });

function press(key: "B" | "X", target: EventTarget = document.body, repeat = false) {
  const event = new window.KeyboardEvent("keydown", {
    repeat,
    key,
    code: `Key${key}`,
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  // happy-dom infers AltGraph from any Ctrl+Alt chord; model physical Ctrl+Alt here.
  Object.defineProperty(event, "getModifierState", { value: () => false });
  target.dispatchEvent(event);
  return event;
}

describe("useWorkspaceActionKeybinds", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function renderKeybinds(
    workspace: FrontendWorkspaceMetadata | undefined,
    status: RuntimeStatus | null = null,
    selectedWorkspaceId: string | null = "ws-1"
  ) {
    const onForkWorkspace = mock((_id: string) => undefined);
    const onStopRuntime = mock((_id: string) => undefined);
    renderHook(() =>
      useWorkspaceActionKeybinds({
        selectedWorkspaceId,
        getWorkspaceMetadata: () => workspace,
        runtimeStatusStore: { getStatus: () => status },
        onForkWorkspace,
        onStopRuntime,
      })
    );
    return { onForkWorkspace, onStopRuntime };
  }

  test("forks the selected repository workspace", () => {
    const { onForkWorkspace } = renderKeybinds(repoWorkspace);
    expect(press("B").defaultPrevented).toBe(true);
    expect(onForkWorkspace.mock.calls).toEqual([["ws-1"]]);
  });

  test("leaves the fork key alone for a scratch chat, with nothing selected, or while typing", () => {
    const scratch = renderKeybinds(scratchWorkspace);
    expect(press("B").defaultPrevented).toBe(false);
    expect(scratch.onForkWorkspace).not.toHaveBeenCalled();
    cleanup();

    const none = renderKeybinds(repoWorkspace, null, null);
    press("B");
    expect(none.onForkWorkspace).not.toHaveBeenCalled();
    cleanup();

    const typing = renderKeybinds(repoWorkspace);
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    press("B", input);
    expect(typing.onForkWorkspace).not.toHaveBeenCalled();
  });

  test("stops the selected workspace's container only while its devcontainer runs", () => {
    const running = renderKeybinds(devcontainerWorkspace, "running");
    expect(press("X").defaultPrevented).toBe(true);
    expect(running.onStopRuntime.mock.calls).toEqual([["ws-1"]]);
    cleanup();

    const stopped = renderKeybinds(devcontainerWorkspace, "stopped");
    expect(press("X").defaultPrevented).toBe(false);
    expect(stopped.onStopRuntime).not.toHaveBeenCalled();
    cleanup();

    // A worktree has no container even if a stale status says "running".
    const worktree = renderKeybinds(repoWorkspace, "running");
    press("X");
    expect(worktree.onStopRuntime).not.toHaveBeenCalled();
  });

  // Codex on #6398: a held key auto-repeats, and each repeat would start another fork.
  test("a held key runs its action once", () => {
    const { onForkWorkspace } = renderKeybinds(repoWorkspace);
    press("B");
    expect(press("B", document.body, true).defaultPrevented).toBe(true);
    press("B", document.body, true);
    expect(onForkWorkspace).toHaveBeenCalledTimes(1);
  });

  // Codex on #6398: a modal covers the workspace, so its keys must not act behind it.
  test("does nothing while a modal dialog is open", () => {
    const { onForkWorkspace } = renderKeybinds(repoWorkspace);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-modal-dialog-overlay", "");
    overlay.setAttribute("data-state", "open");
    document.body.appendChild(overlay);
    expect(press("B").defaultPrevented).toBe(false);
    expect(onForkWorkspace).not.toHaveBeenCalled();
    overlay.remove();
  });

  // Perf owner on #6398: ProjectSidebar passes new callbacks on every render.
  test("keeps one listener across renders and calls the latest callbacks", () => {
    const addSpy = spyOn(window, "addEventListener");
    const first = mock((_id: string) => undefined);
    const latest = mock((_id: string) => undefined);
    const view = renderHook(
      (props: { onForkWorkspace: (id: string) => void }) =>
        useWorkspaceActionKeybinds({
          selectedWorkspaceId: "ws-1",
          getWorkspaceMetadata: () => repoWorkspace,
          runtimeStatusStore: { getStatus: () => null },
          onForkWorkspace: props.onForkWorkspace,
          onStopRuntime: () => undefined,
        }),
      { initialProps: { onForkWorkspace: first } }
    );
    view.rerender({ onForkWorkspace: latest });
    press("B");
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    addSpy.mockRestore();
  });
});
