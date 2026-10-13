// Bootstrap the DOM before this file's imports evaluate (see tests/ui/dom.ts).
import { installDom } from "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { useWorkspaceActionKeybinds } from "./useWorkspaceActionKeybinds";

// Fork workspace (Ctrl+Alt+Shift+B) and Stop container (Ctrl+Alt+Shift+X) act on the selected
// workspace, and only where its menu would offer them (#6328).

const repoWorkspace = {
  id: "ws-1",
  runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
} as FrontendWorkspaceMetadata;
const devcontainerWorkspace = {
  id: "ws-1",
  runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
} as FrontendWorkspaceMetadata;
const scratchWorkspace = { id: "ws-1", kind: "scratch" } as FrontendWorkspaceMetadata;

function press(key: "B" | "X", target: EventTarget = document.body) {
  const event = new window.KeyboardEvent("keydown", {
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
});
