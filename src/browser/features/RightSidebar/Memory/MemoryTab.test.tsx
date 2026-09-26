// Bootstrap Happy DOM before react-dom evaluates: React decides input-event
// support at module-eval time, and controlled <textarea> onChange never fires
// if `document` was undefined when react-dom loaded.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import * as RealExperimentsModule from "@/browser/hooks/useExperiments";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  MemoryConsolidationRecordPayload,
  MemoryConsolidationStatusPayload,
  MemoryFileInfo,
} from "@/common/orpc/schemas/memory";

interface MemoryChangeEvent {
  scope: "global" | "project" | "workspace";
  path: string;
  actor: "agent" | "user";
  workspaceId: string;
  projectPath: string;
}

interface FakeMemoryApiOptions {
  consolidationStatus?: MemoryConsolidationStatusPayload;
  consolidationStatusFailuresRemaining?: number;
  consolidateRecord?: MemoryConsolidationRecordPayload;
}

const DEFAULT_CONSOLIDATION_RECORD: MemoryConsolidationRecordPayload = {
  lastRunAt: Date.now(),
  trigger: "manual",
  summary: "consolidated",
  ops: [{ command: "create", path: "/memories/global/prefs.md", applied: true }],
};

const DEFAULT_CONSOLIDATION_STATUS: MemoryConsolidationStatusPayload = {
  workspaceRecord: null,
  projectRecord: null,
  globalRecord: null,
  latestHarvestRecord: null,
  projectAvailable: true,
};

/**
 * Minimal fake of the api.memory surface the tab consumes. Tests drive change
 * events through `emitChange` to exercise the live-refresh path.
 */
function createFakeMemoryApi(initialFiles: MemoryFileInfo[], options: FakeMemoryApiOptions = {}) {
  const state = {
    files: initialFiles,
    contents: new Map<string, { content: string; sha256: string }>(),
    saveCalls: [] as Array<{ path: string; content: string; expectedSha256: string | null }>,
    deleteCalls: [] as string[],
    pinCalls: [] as Array<{ path: string; pinned: boolean }>,
    consolidateCalls: 0,
    consolidationStatus: options.consolidationStatus ?? DEFAULT_CONSOLIDATION_STATUS,
    consolidationStatusFailuresRemaining: options.consolidationStatusFailuresRemaining ?? 0,
    consolidateRecord: options.consolidateRecord ?? DEFAULT_CONSOLIDATION_RECORD,
    nextSaveConflict: false,
    listeners: new Set<(event: MemoryChangeEvent) => void>(),
  };

  const api = {
    memory: {
      list: (_input: { workspaceId: string }, _opts?: { signal?: AbortSignal }) =>
        Promise.resolve({ success: true as const, data: { files: state.files } }),
      read: (input: { workspaceId: string; path: string }, _opts?: { signal?: AbortSignal }) => {
        const entry = state.contents.get(input.path);
        return Promise.resolve(
          entry
            ? { success: true as const, data: entry }
            : { success: false as const, error: `No memory file at ${input.path}` }
        );
      },
      save: (input: {
        workspaceId: string;
        path: string;
        content: string;
        expectedSha256: string | null;
      }) => {
        state.saveCalls.push({
          path: input.path,
          content: input.content,
          expectedSha256: input.expectedSha256,
        });
        if (state.nextSaveConflict) {
          state.nextSaveConflict = false;
          return Promise.resolve({
            success: false as const,
            error: {
              kind: "conflict" as const,
              message: `${input.path} changed since it was loaded; reload and re-apply your edits`,
            },
          });
        }
        state.contents.set(input.path, { content: input.content, sha256: `sha-${input.content}` });
        return Promise.resolve({
          success: true as const,
          data: { sha256: `sha-${input.content}` },
        });
      },
      delete: (input: { workspaceId: string; path: string }) => {
        state.deleteCalls.push(input.path);
        state.files = state.files.filter((file) => file.path !== input.path);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      setPinned: (input: { workspaceId: string; path: string; pinned: boolean }) => {
        state.pinCalls.push({ path: input.path, pinned: input.pinned });
        state.files = state.files.map((file) =>
          file.path === input.path ? { ...file, pinned: input.pinned } : file
        );
        return Promise.resolve({ success: true as const, data: undefined });
      },
      consolidationStatus: (_input: { workspaceId: string }, _opts?: { signal?: AbortSignal }) => {
        if (state.consolidationStatusFailuresRemaining > 0) {
          state.consolidationStatusFailuresRemaining -= 1;
          return Promise.reject(new Error("status unavailable"));
        }
        return Promise.resolve({ success: true as const, data: state.consolidationStatus });
      },
      consolidate: (_input: { workspaceId: string }) => {
        state.consolidateCalls += 1;
        return Promise.resolve({ success: true as const, data: state.consolidateRecord });
      },
      onChange: (_input: { workspaceId: string }, opts?: { signal?: AbortSignal }) => {
        async function* iterate(): AsyncGenerator<MemoryChangeEvent> {
          const queue: MemoryChangeEvent[] = [];
          let resolveNext: ((event: MemoryChangeEvent) => void) | null = null;
          const listener = (event: MemoryChangeEvent) => {
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
            } else {
              queue.push(event);
            }
          };
          state.listeners.add(listener);
          try {
            while (!opts?.signal?.aborted) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }
              yield await new Promise<MemoryChangeEvent>((resolve) => {
                resolveNext = resolve;
              });
            }
          } finally {
            state.listeners.delete(listener);
          }
        }
        return Promise.resolve(iterate());
      },
    },
  };

  return {
    api,
    state,
    setContent(path: string, content: string, sha256: string) {
      state.contents.set(path, { content, sha256 });
    },
    emitChange(event: MemoryChangeEvent) {
      for (const listener of state.listeners) {
        listener(event);
      }
    },
  };
}

let fake: ReturnType<typeof createFakeMemoryApi> | null = null;

restoreModulesAfterSuite([
  ["@/browser/hooks/useExperiments", { ...RealExperimentsModule }],
  ["@/browser/components/Dialog/Dialog", { ...RealDialogModule }],
]);

void mock.module("@/browser/hooks/useExperiments", () => ({
  useExperimentValue: (experimentId: string) =>
    experimentId === EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
}));

// The delete flow confirms through ConfirmationModal, which renders via a
// Radix Dialog portal that happy-dom cannot see. Mock the Dialog primitives
// to render inline so the real confirm/cancel behavior stays under test.
void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children?: unknown }) =>
    props.open ? <div>{props.children as ReactNode}</div> : null,
  DialogContent: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  DialogHeader: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  DialogTitle: (props: { children?: unknown }) => <h2>{props.children as ReactNode}</h2>,
  DialogDescription: (props: { children?: unknown }) => <p>{props.children as ReactNode}</p>,
  DialogFooter: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  WarningBox: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  WarningTitle: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
  WarningText: (props: { children?: unknown }) => <div>{props.children as ReactNode}</div>,
}));

import { MemoryTab } from "./MemoryTab";

// Inject the fake client through the real provider: a module mock of contexts/API is
// process-wide and leaks this partial client into later-evaluated suites.
function ApiWrapper(props: { children: ReactNode }) {
  if (!fake) {
    throw new Error("Test bug: assign `fake` before rendering MemoryTab");
  }
  // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (double needs type repair)
  return <APIProvider client={fake.api as unknown as APIClient}>{props.children}</APIProvider>;
}

function renderWithApi(ui: ReactElement) {
  return render(ui, { wrapper: ApiWrapper });
}

function fileInfo(overrides: Partial<MemoryFileInfo> = {}): MemoryFileInfo {
  return {
    path: "/memories/global/prefs.md",
    scope: "global",
    description: "",
    pinned: false,
    accessCount: 0,
    lastAccessedAt: null,
    ...overrides,
  };
}

describe("MemoryTab", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    fake = null;
  });

  test("lists files grouped by scope with descriptions", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/prefs.md", scope: "global", description: "likes tea" }),
      fileInfo({ path: "/memories/project/conventions.md", scope: "project" }),
    ]);
    const { getByText, findByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    await findByText("prefs.md");
    expect(getByText("Global")).toBeTruthy();
    expect(getByText("Project")).toBeTruthy();
    expect(getByText("likes tea")).toBeTruthy();
    expect(getByText("conventions.md")).toBeTruthy();
  });

  test("shows an empty state when there are no memory files", async () => {
    fake = createFakeMemoryApi([]);
    const { findByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);
    await findByText(/No memory files/);
  });

  test("manual consolidation does not invent project coverage when status is unavailable", async () => {
    fake = createFakeMemoryApi([], { consolidationStatusFailuresRemaining: 20 });
    const { findByRole, findByText, getByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    await findByText(/No memory files/);
    expect(getByText(/^Project:/).textContent).not.toContain("manual");

    fireEvent.click(await findByRole("button", { name: "Consolidate now" }));

    await waitFor(() => {
      expect(fake!.state.consolidateCalls).toBe(1);
    });
    await findByRole("button", { name: "Consolidate now" });
    expect(getByText(/^Project:/).textContent).not.toContain("manual");
  });

  test("deduplicates identical consolidation summaries in the tooltip", async () => {
    const sharedRecord = {
      ...DEFAULT_CONSOLIDATION_RECORD,
      summary: "shared consolidation summary",
    };
    fake = createFakeMemoryApi([], {
      consolidationStatus: {
        workspaceRecord: sharedRecord,
        projectRecord: sharedRecord,
        globalRecord: sharedRecord,
        latestHarvestRecord: null,
        projectAvailable: true,
      },
    });
    const { findByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    const workspaceLine = await findByText(/^Workspace: .*manual/);
    const statusBlock = workspaceLine.parentElement;
    expect(statusBlock).not.toBeNull();
    fireEvent.pointerMove(statusBlock!);

    await waitFor(() => {
      const tooltipBlocks = Array.from(
        document.querySelectorAll<HTMLElement>(".whitespace-pre-line")
      );
      expect(tooltipBlocks.length).toBeGreaterThan(0);
      for (const block of tooltipBlocks) {
        const matches = block.textContent?.match(/shared consolidation summary/g) ?? [];
        expect(matches).toHaveLength(1);
      }
    });
  });

  test("consolidation summary does not leave a native title tooltip", async () => {
    fake = createFakeMemoryApi([], {
      consolidationStatus: {
        workspaceRecord: {
          ...DEFAULT_CONSOLIDATION_RECORD,
          summary: "workspace summary",
        },
        projectRecord: null,
        globalRecord: null,
        latestHarvestRecord: null,
        projectAvailable: true,
      },
    });
    const { findByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    const workspaceLine = await findByText(/^Workspace: .*manual/);
    const statusBlock = workspaceLine.parentElement;
    expect(statusBlock).not.toBeNull();
    // Native title tooltips are rendered by the OS and appear in addition to our
    // portaled app tooltip, so this block must not expose one.
    expect(statusBlock!.getAttribute("title")).toBeNull();
  });

  test("renders failed harvest errors inline for keyboard and screen reader access", async () => {
    fake = createFakeMemoryApi([], {
      consolidationStatus: {
        workspaceRecord: null,
        projectRecord: null,
        globalRecord: null,
        projectAvailable: true,
        latestHarvestRecord: {
          status: "failed",
          startedAt: Date.now(),
          completedAt: Date.now(),
          attemptCount: 1,
          boundaryKey: "summary-1",
          compactionEpoch: 1,
          acceptedCandidates: 0,
          skippedCandidates: 0,
          error: "harvest provider failed",
        },
      },
    });
    const { findByRole } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    expect((await findByRole("alert")).textContent).toContain(
      "Harvest error: harvest provider failed"
    );
  });

  test("shows usage stats for used files and omits them for never-used files", async () => {
    fake = createFakeMemoryApi([
      fileInfo({
        path: "/memories/global/hot.md",
        accessCount: 3,
        lastAccessedAt: Date.now(),
      }),
      fileInfo({ path: "/memories/global/cold.md" }),
    ]);
    const { findByText, queryAllByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    await findByText("hot.md");
    await findByText(/Used 3×/);
    // The never-used file renders no usage line.
    expect(queryAllByText(/Used /)).toHaveLength(1);
  });

  test("pin toggle calls setPinned with the opposite state", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md", pinned: false })]);
    const { findByLabelText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByLabelText("Pin prefs.md"));
    await waitFor(() => {
      expect(fake!.state.pinCalls).toEqual([{ path: "/memories/global/prefs.md", pinned: true }]);
    });
    // After refresh the row reflects the pinned state.
    await findByLabelText("Unpin prefs.md");
  });

  test("opens a file, edits it, and saves with the loaded sha", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    fake.setContent("/memories/global/prefs.md", "likes tea", "sha-original");
    const { findByText, findByLabelText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByText("prefs.md"));
    const editor = (await findByLabelText("Memory file content")) as HTMLTextAreaElement;
    expect(editor.value).toBe("likes tea");

    fireEvent.input(editor, { target: { value: "likes coffee" } });
    fireEvent.click(await findByLabelText("Save memory file"));

    await waitFor(() => {
      expect(fake!.state.saveCalls).toEqual([
        {
          path: "/memories/global/prefs.md",
          content: "likes coffee",
          expectedSha256: "sha-original",
        },
      ]);
    });
  });

  test("shows a conflict banner when a save is rejected and reloads on request", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    fake.setContent("/memories/global/prefs.md", "likes tea", "sha-original");
    const { findByText, findByLabelText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    fireEvent.click(await findByText("prefs.md"));
    const editor = (await findByLabelText("Memory file content")) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: "draft edit" } });

    fake.state.nextSaveConflict = true;
    fireEvent.click(await findByLabelText("Save memory file"));
    await findByText(/changed since it was loaded/);

    // Reload fetches the latest content and clears the conflict.
    fake.setContent("/memories/global/prefs.md", "agent version", "sha-agent");
    fireEvent.click(await findByLabelText("Reload memory file"));
    await waitFor(() => {
      expect(editor.value).toBe("agent version");
    });
  });

  test("deletes a file from the list after confirming the modal", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByLabelText, findByText, findByRole } = renderWithApi(
      <MemoryTab workspaceId="ws-1" />
    );

    fireEvent.click(await findByLabelText("Delete prefs.md"));
    // The row action only opens the confirmation modal; nothing is deleted yet.
    expect(fake.state.deleteCalls).toEqual([]);

    fireEvent.click(await findByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(fake!.state.deleteCalls).toEqual(["/memories/global/prefs.md"]);
    });
    await findByText(/No memory files/);
  });

  test("cancelling the delete confirmation keeps the file", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByLabelText, findByText, findByRole, queryByRole } = renderWithApi(
      <MemoryTab workspaceId="ws-1" />
    );

    fireEvent.click(await findByLabelText("Delete prefs.md"));
    fireEvent.click(await findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    });
    expect(fake.state.deleteCalls).toEqual([]);
    await findByText("prefs.md");
  });

  test("scope sections collapse and expand from their headers", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByText, findByRole, queryByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);
    await findByText("prefs.md");

    const header = await findByRole("button", { name: /global/i });
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(queryByText("prefs.md")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(header);
    await findByText("prefs.md");
  });

  test("groups nested files under a collapsible directory node", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/topic/notes.md", scope: "global" }),
      fileInfo({ path: "/memories/global/root.md", scope: "global" }),
    ]);
    const { findByText, getByText, getByRole, getByLabelText, queryByText } = renderWithApi(
      <MemoryTab workspaceId="ws-1" />
    );

    // The file renders under a directory node showing just its basename.
    const base = await findByText("notes.md");
    expect(base.textContent).toBe("notes.md");
    expect(queryByText("topic/")).toBeNull();
    const dirToggle = getByText("topic").closest("button")!;
    expect(dirToggle.getAttribute("aria-expanded")).toBe("true");
    // Pin/delete affordances still target the full scope-relative name.
    getByLabelText("Delete topic/notes.md");
    getByLabelText("Pin topic/notes.md");
    // The root file is not nested under any directory toggle.
    expect(getByText("root.md")).toBeTruthy();
    expect(getByRole("button", { name: "Delete root.md", hidden: true })).toBeTruthy();
  });

  test("collapsing a directory hides its files and nested directories", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/a/b/c.md", scope: "global" })]);
    const { findByText, getByText, queryByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    // Multi-level nesting: a → b → c.md, expanded by default.
    await findByText("c.md");
    const outer = getByText("a").closest("button")!;
    fireEvent.click(outer);
    expect(outer.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("b")).toBeNull();
    expect(queryByText("c.md")).toBeNull();

    fireEvent.click(outer);
    await findByText("c.md");
  });

  test("directory counts include files in nested subdirectories", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/a/x.md", scope: "global" }),
      fileInfo({ path: "/memories/global/a/b/y.md", scope: "global" }),
    ]);
    const { findByText, getByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    await findByText("x.md");
    expect(getByText("a").closest("button")!.textContent).toContain("(2)");
    expect(getByText("b").closest("button")!.textContent).toContain("(1)");
  });

  test("sorts directories before files, each alphabetically", async () => {
    fake = createFakeMemoryApi([
      fileInfo({ path: "/memories/global/zeta.md", scope: "global" }),
      fileInfo({ path: "/memories/global/beta/inner.md", scope: "global" }),
      fileInfo({ path: "/memories/global/alpha.md", scope: "global" }),
      fileInfo({ path: "/memories/global/acme/other.md", scope: "global" }),
    ]);
    const { findByText, getByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);

    await findByText("alpha.md");
    const expectBefore = (first: HTMLElement, second: HTMLElement) => {
      expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    };
    expectBefore(getByText("acme"), getByText("beta"));
    expectBefore(getByText("beta"), getByText("alpha.md"));
    expectBefore(getByText("alpha.md"), getByText("zeta.md"));
  });

  test("marks files edited by the agent with a badge until opened", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    fake.setContent("/memories/global/prefs.md", "likes tea", "sha-original");
    const { findByText, queryByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);
    await findByText("prefs.md");
    expect(queryByText("agent edited")).toBeNull();

    fake.emitChange({
      scope: "global",
      path: "/memories/global/prefs.md",
      actor: "agent",
      workspaceId: "ws-other",
      projectPath: "/project/other",
    });
    await findByText("agent edited");

    // Opening the file acknowledges the badge.
    fireEvent.click(await findByText("prefs.md"));
    await waitFor(() => {
      expect(queryByText("agent edited")).toBeNull();
    });
  });

  test("user-actor change events do not produce the agent badge", async () => {
    fake = createFakeMemoryApi([fileInfo({ path: "/memories/global/prefs.md" })]);
    const { findByText, queryByText } = renderWithApi(<MemoryTab workspaceId="ws-1" />);
    await findByText("prefs.md");

    fake.emitChange({
      scope: "global",
      path: "/memories/global/prefs.md",
      actor: "user",
      workspaceId: "ws-1",
      projectPath: "/project/one",
    });
    await waitFor(() => {
      expect(queryByText("agent edited")).toBeNull();
    });
  });
});
