import React, {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import * as GitStatusStoreModule from "@/browser/stores/GitStatusStore";
import type { GitStatus } from "@/common/types/workspace";
import * as CopyToClipboardModule from "@/browser/hooks/useCopyToClipboard";
import * as PopoverModule from "../Popover/Popover";
import * as TooltipModule from "../Tooltip/Tooltip";

import { BranchSelector } from "./BranchSelector";

interface ExecuteBashInput {
  workspaceId: string;
  script: string;
  command?: string;
  args?: string[];
  options?: {
    timeout_secs?: number;
    cwdMode?: "default" | "repo-root";
  };
}

type ExecuteBashResult =
  | {
      success: true;
      data: {
        success: boolean;
        output?: string;
        exitCode: number;
        wall_duration_ms: number;
        error?: string;
      };
    }
  | { success: false; error: string };

interface MockApiClient {
  workspace: {
    executeBash: (input: ExecuteBashInput) => Promise<ExecuteBashResult>;
  };
}

let mockApi: MockApiClient;
let mockGitStatus: GitStatus | null = null;
const invalidateGitStatusMock = mock(() => undefined);
const clearGitStatusMock = mock(() => undefined);
const copyToClipboardMock = mock(() => Promise.resolve());

const PopoverContext = createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>({
  open: false,
  onOpenChange: () => undefined,
});

function bashSuccess(output: string): ExecuteBashResult {
  return {
    success: true,
    data: {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms: 0,
    },
  };
}

describe("BranchSelector", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;
  let originalLocation: typeof globalThis.location;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    originalLocation = globalThis.location;

    const dom = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage;
    globalThis.location = dom.location as unknown as Location;

    mockGitStatus = null;
    invalidateGitStatusMock.mockClear();
    clearGitStatusMock.mockClear();
    copyToClipboardMock.mockClear();
    mockApi = {
      workspace: {
        executeBash: mock(() => Promise.resolve(bashSuccess(""))),
      },
    };

    spyOn(APIModule, "useAPI").mockImplementation(() => ({
      // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (double needs type repair)
      api: mockApi as unknown as APIClient,
      status: "connected" as const,
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }));

    spyOn(GitStatusStoreModule, "useGitStatus").mockImplementation(() => mockGitStatus);
    spyOn(GitStatusStoreModule, "invalidateGitStatus").mockImplementation(invalidateGitStatusMock);
    spyOn(GitStatusStoreModule, "clearGitStatus").mockImplementation(clearGitStatusMock);
    spyOn(CopyToClipboardModule, "useCopyToClipboard").mockImplementation(() => ({
      copied: false,
      copyToClipboard: copyToClipboardMock,
    }));

    spyOn(PopoverModule, "Popover").mockImplementation(((props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => (
      <PopoverContext.Provider value={{ open: props.open, onOpenChange: props.onOpenChange }}>
        {props.children}
      </PopoverContext.Provider>
    )) as unknown as typeof PopoverModule.Popover);
    spyOn(PopoverModule, "PopoverTrigger").mockImplementation(((props: {
      asChild?: boolean;
      children: ReactNode;
    }) => {
      const popover = useContext(PopoverContext);
      if (
        props.asChild &&
        isValidElement<{ onClick?: (event: React.MouseEvent) => void }>(props.children)
      ) {
        const child = props.children;
        return cloneElement(child, {
          onClick: (event: React.MouseEvent) => {
            child.props.onClick?.(event);
            popover.onOpenChange(!popover.open);
          },
        });
      }
      return <button onClick={() => popover.onOpenChange(!popover.open)}>{props.children}</button>;
    }) as unknown as typeof PopoverModule.PopoverTrigger);
    spyOn(PopoverModule, "PopoverContent").mockImplementation(((props: { children: ReactNode }) => {
      const popover = useContext(PopoverContext);
      return popover.open ? <div>{props.children}</div> : null;
    }) as unknown as typeof PopoverModule.PopoverContent);

    spyOn(TooltipModule, "Tooltip").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.Tooltip);
    spyOn(TooltipModule, "TooltipTrigger").mockImplementation(((props: {
      children: ReactNode;
      asChild?: boolean;
    }) => <>{props.children}</>) as unknown as typeof TooltipModule.TooltipTrigger);
    spyOn(TooltipModule, "TooltipContent").mockImplementation(((props: {
      children: ReactNode;
      side?: string;
    }) => <>{props.children}</>) as unknown as typeof TooltipModule.TooltipContent);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.location = originalLocation;
  });

  test("resolves and shows the active branch even when the recent branch list does not include it", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("git rev-parse --is-inside-work-tree")) {
        return Promise.resolve(bashSuccess("true"));
      }
      if (input.script.includes("git branch --show-current")) {
        return Promise.resolve(bashSuccess("feature/lazy-start"));
      }
      if (input.script.includes("%(refname:short)")) {
        return Promise.resolve(
          bashSuccess(
            Array.from({ length: 101 }, (_, index) => `recent-branch-${index + 1}`).join("\n")
          )
        );
      }
      if (input.script.includes("git remote")) {
        return Promise.resolve(bashSuccess("origin"));
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };

    const view = render(<BranchSelector workspaceId="ws-1" workspaceName="scratch-workspace" />);

    expect(view.getByRole("button", { name: "scratch-workspace" })).toBeDefined();
    expect(view.queryByLabelText("Copy branch name")).toBeNull();
    expect(view.container.querySelector(".lucide-git-branch")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "scratch-workspace" }));

    await waitFor(() => {
      expect(view.getByLabelText("Copy branch name")).toBeDefined();
    });
    expect(view.getAllByText("feature/lazy-start").length).toBeGreaterThan(0);
    const executedScripts = executeBash.mock.calls.map(([input]) => input.script);
    expect(
      executedScripts.some((script) => script.includes("git rev-parse --is-inside-work-tree"))
    ).toBe(true);
    expect(executedScripts.some((script) => script.includes("git branch --show-current"))).toBe(
      true
    );
    expect(executedScripts.some((script) => script.includes("%(refname:short)"))).toBe(true);
    expect(executedScripts.some((script) => script.includes("git remote"))).toBe(true);
  });

  test("resets stale branch state when the component remounts for a different workspace", async () => {
    mockGitStatus = {
      branch: "feature/lazy-start",
      ahead: 1,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };

    const view = render(
      <BranchSelector key="ws-1" workspaceId="ws-1" workspaceName="first-workspace" />
    );

    await waitFor(() => {
      expect(view.getByRole("button", { name: "feature/lazy-start" })).toBeDefined();
    });

    mockGitStatus = null;
    view.rerender(
      <BranchSelector key="ws-2" workspaceId="ws-2" workspaceName="second-workspace" />
    );

    expect(view.getByRole("button", { name: "second-workspace" })).toBeDefined();
    expect(view.queryByRole("button", { name: "feature/lazy-start" })).toBeNull();
    expect(view.queryByLabelText("Copy branch name")).toBeNull();
  });

  test("switches to the non-git fallback after an explicit open confirms the workspace is not a repo", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("git rev-parse --is-inside-work-tree")) {
        return Promise.resolve({
          success: true,
          data: {
            success: false,
            error: "fatal: not a git repository",
            exitCode: 128,
            wall_duration_ms: 0,
          },
        } satisfies ExecuteBashResult);
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };
    mockGitStatus = {
      branch: "stale-branch",
      ahead: 1,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };
    localStorage.setItem(
      "branch:ws-2",
      JSON.stringify({ data: "stale-branch", cachedAt: Date.now() })
    );
    localStorage.setItem("branchIndex", JSON.stringify(["branch:ws-2"]));

    const view = render(<BranchSelector workspaceId="ws-2" workspaceName="plain-workspace" />);

    expect(view.getByRole("button", { name: "stale-branch" })).toBeDefined();

    fireEvent.click(view.getByRole("button", { name: "stale-branch" }));

    await waitFor(() => {
      expect(executeBash.mock.calls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(view.queryByRole("button", { name: "plain-workspace" })).toBeNull();
    });
    expect(view.getByText("plain-workspace")).toBeDefined();
    expect(localStorage.getItem("branch:ws-2")).toBeNull();
    expect(localStorage.getItem("branchIndex")).toBe(JSON.stringify([]));
    expect(clearGitStatusMock).toHaveBeenCalledWith("ws-2");
    expect(executeBash.mock.calls[0]?.[0].script).toContain("git rev-parse --is-inside-work-tree");
  });

  test("keeps the selector interactive when the repo probe fails inconclusively", async () => {
    const executeBash = mock((input: ExecuteBashInput) => {
      if (input.script.includes("git rev-parse --is-inside-work-tree")) {
        return Promise.resolve({
          success: false,
          error: "runtime not ready",
        } satisfies ExecuteBashResult);
      }
      throw new Error(`Unexpected script: ${input.script}`);
    });
    mockApi = {
      workspace: {
        executeBash,
      },
    };
    mockGitStatus = {
      branch: "stale-branch",
      ahead: 1,
      behind: 0,
      dirty: false,
      outgoingAdditions: 0,
      outgoingDeletions: 0,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };
    localStorage.setItem(
      "branch:ws-3",
      JSON.stringify({ data: "stale-branch", cachedAt: Date.now() })
    );
    localStorage.setItem("branchIndex", JSON.stringify(["branch:ws-3"]));

    const view = render(<BranchSelector workspaceId="ws-3" workspaceName="plain-workspace" />);

    fireEvent.click(view.getByRole("button", { name: "stale-branch" }));

    await waitFor(() => {
      expect(executeBash.mock.calls).toHaveLength(1);
    });
    expect(view.getByRole("button", { name: "stale-branch" })).toBeDefined();
    expect(localStorage.getItem("branch:ws-3")).not.toBeNull();
    expect(clearGitStatusMock).not.toHaveBeenCalled();
  });
});
