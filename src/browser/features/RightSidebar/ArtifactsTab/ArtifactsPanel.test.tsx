// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { publishProjectTrustChanged } from "@/browser/utils/workspaceMcpMutations";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { getReviewStateStore } from "@/browser/stores/ReviewStateStore";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import type { DisplayedMessage } from "@/common/types/message";
import type { McpAppPluginView } from "@/common/orpc/schemas/mcpApps";
import type { ReviewStateDelta, ReviewStateEvent } from "@/common/orpc/schemas/reviewState";
import { applyReviewStateDelta } from "@/common/utils/reviewState";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
  ArtifactShelfEntry,
  ArtifactShelfListing,
  ArtifactVersion,
  PinnedArtifactFile,
} from "@/common/orpc/schemas/artifacts";
import {
  ARTIFACTS_SELECTION_KEY,
  ARTIFACTS_SELECTION_MAX_WORKSPACES,
} from "@/common/constants/storage";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { readArtifactSelection, writeArtifactSelection } from "./artifactSelection";
import {
  appViewPickerDetails,
  closeMcpAppView,
  openMcpAppView,
  pluginViewRef,
  type McpAppViewRef,
} from "./mcpAppViewsStore";
import { openArtifact } from "./openArtifact";

function entry(path: string, modifiedMs: number, kind: ArtifactEntry["kind"]): ArtifactEntry {
  return { path, kind, size: 10, modifiedMs };
}

function version(n: number, label: string | null, path: string): ArtifactVersion {
  return {
    version: n,
    label,
    source: label == null ? "turn-end" : "publish",
    createdAtMs: Date.now() - n * 60_000,
    sha256: `sha-${n}`,
    size: 10,
    path,
  };
}

/** Test stand-in for the backend's path-derived artifact id. */
const idFor = (path: string) => `id-${path}`;

function createFakeArtifactsApi(
  listing: ArtifactListing,
  files: Record<string, ArtifactReadResult>,
  extra: {
    /** Stored versions per artifact path, newest first. */
    versions?: Record<string, ArtifactVersion[]>;
    /** listVersions answers only once this settles (default: at once). */
    versionsGate?: Promise<void>;
    /** Version contents keyed by `${artifactId}@${version}`. */
    versionFiles?: Record<string, ArtifactReadResult>;
    pinned?: PinnedArtifactFile[];
    pinnedFiles?: Record<string, ArtifactReadResult>;
    /** mcpApps.listPluginViews result (default: none). */
    pluginViews?: McpAppPluginView[];
    /** Makes `list` fail with this error. */
    listError?: string;
    /** Makes `listVersions` fail with this error. */
    listVersionsError?: string;
    /** Shelf listing (M5c); contents keyed by `${scope}:${name}`. */
    shelf?: ArtifactShelfListing;
    shelfFiles?: Record<string, ArtifactReadResult>;
  } = {}
) {
  const state = {
    listing,
    files,
    pinned: extra.pinned ?? [],
    listCalls: 0,
    readCalls: [] as string[],
    readVersionCalls: [] as string[],
    readPinnedCalls: [] as string[],
    unpinCalls: [] as string[],
    shelf: extra.shelf ?? {
      project: { available: true as const, entries: [] as ArtifactShelfEntry[] },
      global: [] as ArtifactShelfEntry[],
    },
    readShelfCalls: [] as string[],
    unpinShelfCalls: [] as string[],
    pinToShelfCalls: [] as Array<{ artifactId: string; version: number; scope: string }>,
  };
  const found = (file: ArtifactReadResult | undefined, label: string) =>
    Promise.resolve(
      file
        ? { success: true as const, data: file }
        : { success: false as const, error: `Not found: ${label}` }
    );
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      listVersions: async (input: { workspaceId: string; path: string }) => {
        await extra.versionsGate;
        if (extra.listVersionsError != null) {
          return { success: false as const, error: extra.listVersionsError };
        }
        return {
          success: true as const,
          data: {
            artifactId: idFor(input.path),
            path: input.path,
            pin: null,
            versions: extra.versions?.[input.path] ?? [],
          },
        };
      },
      readVersion: (input: { workspaceId: string; artifactId: string; version: number }) => {
        const key = `${input.artifactId}@${input.version}`;
        state.readVersionCalls.push(key);
        return found(extra.versionFiles?.[key], key);
      },
      listPinned: () =>
        Promise.resolve({
          success: true as const,
          data: { available: true as const, files: state.pinned },
        }),
      readPinned: (input: { workspaceId: string; path: string }) => {
        state.readPinnedCalls.push(input.path);
        return found(extra.pinnedFiles?.[input.path], input.path);
      },
      unpinFile: (input: { workspaceId: string; path: string }) => {
        state.unpinCalls.push(input.path);
        state.pinned = state.pinned.filter((file) => file.path !== input.path);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      listShelf: () => Promise.resolve({ success: true as const, data: state.shelf }),
      readShelf: (input: { workspaceId: string; scope: string; name: string }) => {
        const key = `${input.scope}:${input.name}`;
        state.readShelfCalls.push(key);
        return found(extra.shelfFiles?.[key], key);
      },
      unpinShelf: (input: { workspaceId: string; scope: string; name: string }) => {
        state.unpinShelfCalls.push(`${input.scope}:${input.name}`);
        state.shelf = {
          ...state.shelf,
          global: state.shelf.global.filter((e) => e.name !== input.name),
        };
        return Promise.resolve({ success: true as const, data: undefined });
      },
      pinToShelf: (input: {
        workspaceId: string;
        artifactId: string;
        version: number;
        scope: "project" | "global";
      }) => {
        state.pinToShelfCalls.push({
          artifactId: input.artifactId,
          version: input.version,
          scope: input.scope,
        });
        return Promise.resolve({ success: true as const, data: { name: input.artifactId } });
      },
      getState: () =>
        Promise.resolve({ success: true as const, data: { version: 0, state: null } }),
      list: () => {
        state.listCalls += 1;
        return Promise.resolve(
          extra.listError != null
            ? { success: false as const, error: extra.listError }
            : { success: true as const, data: state.listing }
        );
      },
      read: (input: { workspaceId: string; path: string }) => {
        state.readCalls.push(input.path);
        const file = state.files[input.path];
        return Promise.resolve(
          file
            ? { success: true as const, data: file }
            : { success: false as const, error: `Artifact not found: ${input.path}` }
        );
      },
    },
    mcpApps: {
      listPluginViews: () =>
        Promise.resolve({ success: true as const, data: extra.pluginViews ?? [] }),
    },
  };
  return { api, state };
}

function textFile(
  path: string,
  kind: ArtifactEntry["kind"],
  content: string,
  modifiedMs = 1
): ArtifactReadResult {
  return { status: "ok", path, kind, size: content.length, modifiedMs, encoding: "utf8", content };
}

let fake: ReturnType<typeof createFakeArtifactsApi> | null = null;

function ApiWrapper(props: { children: ReactNode }) {
  if (!fake) throw new Error("Test bug: assign `fake` before rendering");
  return <APIProvider client={createTestApiClient(fake.api)}>{props.children}</APIProvider>;
}

/** Minimal backend review-state API: one empty snapshot, then records every update. */
function createFakeReviewStateClient() {
  let sections = {};
  const deltas: ReviewStateDelta[] = [];
  const reviewState = {
    subscribe: (_input: { workspaceId: string }, opts?: { signal?: AbortSignal }) => {
      const first: ReviewStateEvent = { type: "snapshot", snapshot: { sections }, revision: 1 };
      return Promise.resolve(
        (async function* () {
          yield first;
          await new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        })()
      );
    },
    update: (input: { workspaceId: string; delta: ReviewStateDelta }) => {
      deltas.push(input.delta);
      sections = applyReviewStateDelta(sections, input.delta);
      return Promise.resolve({ sections, revision: 1 + deltas.length });
    },
  };
  return { client: createTestApiClient({ workspace: { reviewState } }), deltas };
}

function renderPanel(workspaceId = "ws-artifacts") {
  return render(<ArtifactsPanel workspaceId={workspaceId} />, { wrapper: ApiWrapper });
}

describe("ArtifactsPanel", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    // Desktop mode (the preload bridge isDesktopMode checks).
    window.api = { getIsRosetta: () => Promise.resolve(false) } as unknown as typeof window.api;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    fake = null;
  });

  test("shows the newest artifact first and renders Markdown", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 2, "markdown"), entry("notes.txt", 1, "text")],
        truncated: false,
      },
      {
        "report.md": textFile("report.md", "markdown", "# Weekly report", 2),
        "notes.txt": textFile("notes.txt", "text", "plain notes"),
      }
    );
    const view = renderPanel();

    expect(await view.findByRole("heading", { name: "Weekly report" })).toBeTruthy();
    // The picker trigger names the selected artifact.
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("report.md");
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "j" });
    expect(await view.findByText("plain notes")).toBeTruthy();
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("notes.txt");
  });

  test("switches JSON between tree and raw views", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("data.json", 1, "json")],
        truncated: false,
      },
      { "data.json": textFile("data.json", "json", '{"runs":[1,2]}') }
    );
    const view = renderPanel();

    expect(await view.findByText("runs:")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "raw" }));
    // Raw is the file as written, not a re-indented serialization.
    expect(view.getByText('{"runs":[1,2]}')).toBeTruthy();
  });

  test("JSON keeps its view through fullscreen and a remount, but not into a new version", async () => {
    // Own workspace id: the remembered view outlives the panel by design.
    const workspaceId = "ws-json-mode";
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("data.json", 1, "json")],
        truncated: false,
      },
      { "data.json": textFile("data.json", "json", '{"runs":[1,2]}') }
    );
    const pressed = (root: HTMLElement, name: string) =>
      within(root).getByRole("button", { name }).getAttribute("aria-pressed");
    const first = renderPanel(workspaceId);
    expect(await first.findByText("runs:")).toBeTruthy();
    fireEvent.click(first.getByRole("button", { name: "raw" }));
    expect(pressed(first.container, "raw")).toBe("true");

    fireEvent.keyDown(first.getByTestId("artifacts-panel"), { key: "F", shiftKey: true });
    const dialog = await first.findByRole("dialog", { name: "Artifact data.json" });
    expect(pressed(dialog, "raw")).toBe("true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(first.queryByRole("dialog")).toBeNull());
    expect(pressed(first.container, "raw")).toBe("true");

    // Switching sidebar tabs unmounts the panel.
    first.unmount();
    const second = renderPanel(workspaceId);
    await second.findByRole("button", { name: "raw" });
    expect(pressed(second.container, "raw")).toBe("true");

    // A rewrite is a new version: its view starts at the default again.
    fake.state.listing = {
      available: true,
      dir: "/scratch/artifacts",
      entries: [entry("data.json", 2, "json")],
      truncated: false,
    };
    fake.state.files["data.json"] = textFile("data.json", "json", '{"runs":[1,2,3]}', 2);
    fireEvent.keyDown(second.getByTestId("artifacts-panel"), { key: "r" });
    expect(await second.findByText("runs:")).toBeTruthy();
    expect(pressed(second.container, "tree")).toBe("true");
  });

  test("JSON tree expansion survives Raw, fullscreen and a remount, but not a new version", async () => {
    const workspaceId = "ws-json-tree";
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("tree.json", 1, "json")],
        truncated: false,
      },
      { "tree.json": textFile("tree.json", "json", '{"runs":[1,2],"meta":{"deep":{"x":1}}}') }
    );
    const expanded = (root: HTMLElement, name: RegExp) =>
      within(root).getByRole("button", { name }).getAttribute("aria-expanded");
    // Defaults: the first two levels are open, deeper ones closed.
    const first = renderPanel(workspaceId);
    await first.findByRole("button", { name: /^runs:/ });
    expect(expanded(first.container, /^deep:/)).toBe("false");
    fireEvent.click(first.getByRole("button", { name: /^runs:/ }));
    fireEvent.click(first.getByRole("button", { name: /^deep:/ }));
    const toggled = (root: HTMLElement) => {
      expect(expanded(root, /^runs:/)).toBe("false");
      expect(expanded(root, /^deep:/)).toBe("true");
    };
    toggled(first.container);

    fireEvent.click(first.getByRole("button", { name: "raw" }));
    fireEvent.click(first.getByRole("button", { name: "tree" }));
    toggled(first.container);

    fireEvent.keyDown(first.getByTestId("artifacts-panel"), { key: "F", shiftKey: true });
    const dialog = await first.findByRole("dialog", { name: "Artifact tree.json" });
    toggled(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(first.queryByRole("dialog")).toBeNull());
    toggled(first.container);

    // Switching sidebar tabs unmounts the panel.
    first.unmount();
    const second = renderPanel(workspaceId);
    await second.findByRole("button", { name: /^runs:/ });
    toggled(second.container);

    // A rewrite is a new version: its tree starts at the defaults again.
    fake.state.listing = {
      available: true,
      dir: "/scratch/artifacts",
      entries: [entry("tree.json", 2, "json")],
      truncated: false,
    };
    fake.state.files["tree.json"] = textFile(
      "tree.json",
      "json",
      '{"runs":[1,2,3],"meta":{"deep":{"x":1}}}',
      2
    );
    fireEvent.keyDown(second.getByTestId("artifacts-panel"), { key: "r" });
    await waitFor(() => expect(expanded(second.container, /^runs:/)).toBe("true"));
    expect(expanded(second.container, /^deep:/)).toBe("false");
  });

  test("J from a control inside the viewer keeps the shortcuts working", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("data.json", 2, "json"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      {
        "data.json": textFile("data.json", "json", '{"runs":[1,2]}', 2),
        "b.txt": textFile("b.txt", "text", "beta"),
      }
    );
    const view = renderPanel();
    expect(await view.findByText("runs:")).toBeTruthy();
    // The tree toggle unmounts with the JSON viewer when J selects the next artifact.
    const toggle = view.getAllByRole("button", { expanded: true })[0];
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();
    expect(document.activeElement).toBe(view.getByTestId("artifacts-panel"));
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(await view.findByText("runs:")).toBeTruthy();

    // In fullscreen, focus stays in the dialog: the panel behind it is outside the focus trap.
    fireEvent.keyDown(document.activeElement!, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact data.json" });
    const dialogToggle = within(dialog).getAllByRole("button", { expanded: true })[0];
    dialogToggle.focus();
    fireEvent.keyDown(dialogToggle, { key: "j" });
    expect(await within(dialog).findByText("beta")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
  });

  test("raw JSON shows the file's own text, not a re-serialization", async () => {
    // A re-serialization would round the big number and drop the duplicate key.
    const content = '{"a":9007199254740993,"a":1}';
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("dup.json", 1, "json")],
        truncated: false,
      },
      { "dup.json": textFile("dup.json", "json", content) }
    );
    const view = renderPanel();
    fireEvent.click(await view.findByRole("button", { name: "raw" }));
    expect(view.getByTestId("artifacts-panel").textContent).toContain(content);
  });

  test("J/K/R do nothing while the picker or the version menu has focus", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();
    // Stand-ins for the open Radix listbox and the version menu, whose key events bubble to the
    // panel.
    for (const role of ["listbox", "menu"]) {
      const popup = document.createElement("div");
      popup.setAttribute("role", role);
      const item = document.createElement("div");
      popup.appendChild(item);
      panel.appendChild(popup);
      const listsBefore = fake.state.listCalls;
      fireEvent.keyDown(item, { key: "j" });
      fireEvent.keyDown(item, { key: "r" });
      expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("a.txt");
      expect(fake.state.listCalls).toBe(listsBefore);
      popup.remove();
    }
    // The closed picker's own trigger: Radix type-ahead owns printable keys there too.
    const trigger = view.getByRole("combobox", { name: "Artifact" });
    trigger.focus();
    const listsBefore = fake.state.listCalls;
    fireEvent.keyDown(trigger, { key: "j" });
    fireEvent.keyDown(trigger, { key: "r" });
    expect(trigger.textContent).toContain("a.txt");
    expect(fake.state.listCalls).toBe(listsBefore);
  });

  test("keeps the selection of only the most recently used workspaces", () => {
    const total = ARTIFACTS_SELECTION_MAX_WORKSPACES + 2;
    for (let i = 0; i < total; i++) writeArtifactSelection(`ws-${i}`, { path: `f${i}.md` });
    // Touching ws-2 again makes it the newest, so the next new workspace drops ws-3 instead.
    writeArtifactSelection("ws-2", { path: "again.md" });
    writeArtifactSelection("ws-new", { path: "n.md" });
    const map = JSON.parse(window.localStorage.getItem(ARTIFACTS_SELECTION_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(map)).toHaveLength(ARTIFACTS_SELECTION_MAX_WORKSPACES);
    expect(Object.keys(map).slice(-2)).toEqual(["ws-2", "ws-new"]);
    for (const dropped of ["ws-0", "ws-1", "ws-3"]) {
      expect(readArtifactSelection(dropped).path).toBeNull();
    }
    expect(readArtifactSelection("ws-2").path).toBe("again.md");
  });

  test("navigates with J/K and toggles fullscreen with Shift+F and Esc", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    // Stands in for the rest of the app behind the fullscreen overlay.
    const outside = document.body.appendChild(document.createElement("button"));
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();

    fireEvent.keyDown(panel, { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "k" });
    const viewerNode = await view.findByText("alpha");
    const readsBefore = fake.state.readCalls.length;

    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact a.txt" });
    // Modal: the app behind it takes no focus or input and is hidden from assistive tech.
    expect(outside.inert).toBe(true);
    // The viewer stays mounted: fullscreen must not rebuild it (that reloaded HTML frames).
    expect(view.getByText("alpha")).toBe(viewerNode);
    // Esc must not reach window-level handlers such as Escape-to-interrupt.
    let escapeReachedWindowUnhandled = false;
    const windowListener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) escapeReachedWindowUnhandled = true;
    };
    window.addEventListener("keydown", windowListener);
    fireEvent.keyDown(dialog, { key: "Escape" });
    window.removeEventListener("keydown", windowListener);
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(escapeReachedWindowUnhandled).toBe(false);
    expect(outside.inert).toBe(false);
    expect(view.getByText("alpha")).toBe(viewerNode);
    expect(fake.state.readCalls).toHaveLength(readsBefore);
    // Focus returns to the panel, so J/K keep working without another click.
    await waitFor(() => expect(document.activeElement).toBe(panel));
    outside.remove();
  });

  test("autoFocus takes focus from the chat input so J/K and Shift+F work at once", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    // Stands in for the chat input, which holds focus when Ctrl+Shift+K opens the tab.
    const chatInput = document.createElement("textarea");
    document.body.appendChild(chatInput);
    chatInput.focus();
    let consumed = 0;
    const view = render(
      <ArtifactsPanel
        workspaceId="ws-artifacts"
        autoFocus
        onAutoFocusConsumed={() => {
          consumed++;
        }}
      />,
      { wrapper: ApiWrapper }
    );
    const panel = view.getByTestId("artifacts-panel");
    expect(document.activeElement).toBe(panel);
    expect(consumed).toBe(1);
    // Shortcut focus shows the ring even though no typing key preceded it (no :focus-visible).
    expect(panel.getAttribute("data-shortcut-focus")).toBe("true");
    expect(await view.findByText("alpha")).toBeTruthy();

    // Keys go to whatever has focus, as a real key press would.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "F", shiftKey: true });
    expect(await view.findByRole("dialog", { name: "Artifact b.txt" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    // Leaving the panel drops the ring.
    act(() => chatInput.focus());
    expect(panel.getAttribute("data-shortcut-focus")).toBeNull();
    chatInput.remove();
  });

  // Bug bash: Reload re-read the file, but an unchanged file kept the same viewer, so an HTML
  // frame kept its in-page state and Reload looked like it did nothing.
  test("Reload starts an unchanged HTML artifact over in a new frame", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("page.html", 1, "html")],
        truncated: false,
      },
      { "page.html": textFile("page.html", "html", "<p>hi</p>") }
    );
    const view = render(<ArtifactsPanel workspaceId="ws-artifacts" />, {
      wrapper: (props: { children: ReactNode }) => (
        <ThemeProvider forcedTheme="dark">
          <ApiWrapper>{props.children}</ApiWrapper>
        </ThemeProvider>
      ),
    });
    const frame = await view.findByTestId("artifact-frame");
    const readsBefore = fake.state.readCalls.length;

    fireEvent.click(view.getByRole("button", { name: "Reload artifact" }));
    await waitFor(() => expect(fake?.state.readCalls.length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(view.getByTestId("artifact-frame")).not.toBe(frame));
  });

  test("retries a failed preview on the next successful poll", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      {}
    );
    const setIntervalSpy = spyOn(window, "setInterval");
    try {
      const view = renderPanel();
      // The first read fails (e.g. the runtime was briefly unreachable).
      expect(await view.findByText("Artifact not found: a.txt")).toBeTruthy();
      const poll = setIntervalSpy.mock.calls.find((call) => call[1] === 3000)?.[0];
      if (typeof poll !== "function") throw new Error("Test bug: no 3 s poll registered");

      fake.state.files = { "a.txt": textFile("a.txt", "text", "alpha") };
      act(() => poll());
      expect(await view.findByText("alpha")).toBeTruthy();
      expect(fake.state.readCalls).toEqual(["a.txt", "a.txt"]);

      // A healthy preview is not re-read by later polls.
      act(() => poll());
      await waitFor(() => expect(fake?.state.listCalls).toBeGreaterThanOrEqual(3));
      expect(fake.state.readCalls).toEqual(["a.txt", "a.txt"]);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test("re-reads a file rewritten with the same mtime but a new size", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") }
    );
    const setIntervalSpy = spyOn(window, "setInterval");
    try {
      const view = renderPanel();
      expect(await view.findByText("alpha")).toBeTruthy();
      const poll = setIntervalSpy.mock.calls.find((call) => call[1] === 3000)?.[0];
      if (typeof poll !== "function") throw new Error("Test bug: no 3 s poll registered");

      // `cp -p`-style rewrite: same mtime, different size.
      fake.state.listing = {
        available: true,
        dir: "/scratch/artifacts",
        entries: [{ ...entry("a.txt", 1, "text"), size: 42 }],
        truncated: false,
      };
      fake.state.files = { "a.txt": textFile("a.txt", "text", "alpha, longer now") };
      act(() => poll());
      expect(await view.findByText("alpha, longer now")).toBeTruthy();
      expect(fake.state.readCalls).toEqual(["a.txt", "a.txt"]);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test("marks artifacts that changed while the tab was open", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    expect(view.queryByLabelText("1 changed")).toBeNull();

    fake.state.listing = {
      available: true,
      dir: "/scratch/artifacts",
      entries: [entry("a.txt", 2, "text"), entry("b.txt", 5, "text")],
      truncated: false,
    };
    fireEvent.click(view.getByRole("button", { name: "Reload artifact" }));
    expect(await view.findByLabelText("1 changed")).toBeTruthy();

    // Opening the changed artifact clears its marker.
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();
    await waitFor(() => expect(view.queryByLabelText("1 changed")).toBeNull());
  });

  test("retries a failed preview on the next refresh", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") }
    );
    const realRead = fake.api.artifacts!.read!;
    let failures = 1;
    fake.api.artifacts!.read = (input: { workspaceId: string; path: string }) => {
      if (failures-- > 0) return Promise.resolve({ success: false as const, error: "Busy" });
      return realRead(input);
    };
    const view = renderPanel();
    expect(await view.findByText("Busy")).toBeTruthy();
    // Nothing on disk changed: only the periodic re-list (3 s) may retry the read.
    expect(await view.findByText("alpha", undefined, { timeout: 6000 })).toBeTruthy();
  }, 10_000);

  test("a slow retry is not restarted by later polls", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      {}
    );
    let reads = 0;
    fake.api.artifacts!.read = () => {
      reads += 1;
      // The first read fails; the retry never answers, like a slow remote read.
      return reads === 1
        ? Promise.resolve({ success: false as const, error: "Busy" })
        : new Promise(() => undefined);
    };
    const view = renderPanel();
    expect(await view.findByText("Busy")).toBeTruthy();
    // Two more polls (3 s each) happen while the retry is still pending.
    await new Promise((resolve) => setTimeout(resolve, 7_500));
    expect(reads).toBe(2);
  }, 12_000);

  test("re-reads a rewrite that kept the modification time", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    // `cp -p` or a 1 s filesystem: same mtime, different size.
    fake.state.listing = {
      available: true,
      dir: "/scratch/artifacts",
      entries: [{ ...entry("a.txt", 1, "text"), size: 99 }],
      truncated: false,
    };
    fake.state.files["a.txt"] = textFile("a.txt", "text", "rewritten");
    // Only the periodic re-list (3 s) reports the change.
    expect(await view.findByText("rewritten", undefined, { timeout: 6000 })).toBeTruthy();
  }, 10_000);

  test("panel shortcuts do nothing on the focused picker trigger", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    const trigger = view.getByRole("combobox", { name: "Artifact" });
    const listsBefore = fake.state.listCalls;
    // Radix type-ahead owns printable keys on the closed trigger.
    fireEvent.keyDown(trigger, { key: "r" });
    fireEvent.keyDown(trigger, { key: "j" });
    expect(fake.state.listCalls).toBe(listsBefore);
    expect(view.queryByText("beta")).toBeNull();
  });

  test("explains when the runtime has no artifacts folder", async () => {
    fake = createFakeArtifactsApi({ available: false, reason: "Not on this runtime yet." }, {});
    const view = renderPanel();
    expect(await view.findByText("Not on this runtime yet.")).toBeTruthy();
  });

  test("shows a notice instead of content for files over the size limit", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("huge.json", 1, "json")],
        truncated: false,
      },
      {
        "huge.json": {
          status: "too_large",
          path: "huge.json",
          kind: "json",
          size: 20 * 1024 * 1024,
          modifiedMs: 1,
          maxBytes: 10 * 1024 * 1024,
        },
      }
    );
    const view = renderPanel();
    expect(await view.findByText(/is too large to preview/)).toBeTruthy();
  });

  test("Reload re-fetches a selected app view", async () => {
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {}
    );
    let getViewCalls = 0;
    fake.api.mcpApps = {
      ...fake.api.mcpApps,
      getView: () => {
        getViewCalls += 1;
        return Promise.resolve({
          success: true as const,
          data: {
            html: "<p>view</p>",
            csp: {},
            prefersBorder: null,
            resultAvailable: false,
            result: null,
            pluginServerKey: null,
            invocation: null,
          },
        });
      },
    };
    const reloadRef = {
      toolCallId: "call-1",
      serverName: "charts",
      resourceUri: "ui://charts/view",
      toolName: "show_chart",
      label: "Show chart",
      arguments: {},
      cancelled: false,
      failed: false,
    };
    openMcpAppView("ws-app-reload", reloadRef);
    try {
      const view = render(<ArtifactsPanel workspaceId="ws-app-reload" />, {
        wrapper: (props: { children: ReactNode }) => (
          <ThemeProvider forcedTheme="dark">
            <ApiWrapper>{props.children}</ApiWrapper>
          </ThemeProvider>
        ),
      });
      await view.findByTestId("mcp-app-frame");
      expect(getViewCalls).toBe(1);
      fireEvent.click(view.getByRole("button", { name: "Reload artifact" }));
      await waitFor(() => expect(getViewCalls).toBe(2));
    } finally {
      closeMcpAppView("ws-app-reload", reloadRef);
    }
  });

  test("the remaining app views stay reachable after closing one, without a listing", async () => {
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {}
    );
    fake.api.artifacts = {
      ...fake.api.artifacts,
      list: () => Promise.resolve({ success: false as const, error: "Listing failed" }),
    };
    fake.api.mcpApps = {
      ...fake.api.mcpApps,
      getView: () => Promise.resolve({ success: false as const, error: "No view" }),
    };
    const ref = (toolCallId: string, label: string) => ({
      toolCallId,
      serverName: "charts",
      resourceUri: "ui://charts/view",
      toolName: "show_chart",
      label,
      arguments: {},
      cancelled: false,
      failed: false,
    });
    openMcpAppView("ws-app-close", ref("call-a", "First view"));
    openMcpAppView("ws-app-close", ref("call-b", "Second view"));
    try {
      const view = render(<ArtifactsPanel workspaceId="ws-app-close" />, {
        wrapper: (props: { children: ReactNode }) => (
          <ThemeProvider forcedTheme="dark">
            <ApiWrapper>{props.children}</ApiWrapper>
          </ThemeProvider>
        ),
      });
      // The most recently opened view is selected; close it.
      fireEvent.click(await view.findByRole("button", { name: "Close view" }));
      expect(await view.findByText("Listing failed")).toBeTruthy();
      expect(view.getByRole("combobox", { name: "Artifact" })).toBeTruthy();
    } finally {
      closeMcpAppView("ws-app-close", ref("call-a", "First view"));
      closeMcpAppView("ws-app-close", ref("call-b", "Second view"));
    }
  });

  test("lists plugin views before any is opened and opens one by its ID", async () => {
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {},
      {
        pluginViews: [
          {
            pluginViewId: "0123456789abcdef/settings",
            title: "Review settings",
            pluginName: "review-bot",
            serverName: "settings",
            serverKey: "plugin:0123456789abcdef:settings",
            enabled: false,
          },
        ],
      }
    );
    const requests: unknown[] = [];
    fake.api.mcpApps = {
      ...fake.api.mcpApps,
      getView: (input: unknown) => {
        requests.push(input);
        return Promise.resolve({
          success: false as const,
          error: "Enable the settings server for this workspace to open this view.",
        });
      },
    };
    writeArtifactSelection("ws-plugin-view", { path: "mcp-plugin-view:0123456789abcdef/settings" });
    const view = render(<ArtifactsPanel workspaceId="ws-plugin-view" />, {
      wrapper: (props: { children: ReactNode }) => (
        <ThemeProvider forcedTheme="dark">
          <ApiWrapper>{props.children}</ApiWrapper>
        </ThemeProvider>
      ),
    });
    // The listed view resolves the selection; the frame shows the backend's error.
    expect(await view.findByText(/Enable the settings server/)).toBeTruthy();
    expect(view.container.textContent).toContain("Review settings from plugin review-bot");
    expect(requests).toEqual([
      { kind: "plugin", workspaceId: "ws-plugin-view", pluginViewId: "0123456789abcdef/settings" },
    ]);
  });

  test("a plugin view the fresh listing lacks (uninstalled, trust revoked) unmounts", async () => {
    const listed = {
      pluginViewId: "0123456789abcdef/settings",
      title: "Review settings",
      pluginName: "review-bot",
      serverName: "settings",
      serverKey: "plugin:0123456789abcdef:settings",
      enabled: true,
    };
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {},
      { pluginViews: [listed] }
    );
    let views = [listed];
    fake.api.mcpApps = {
      ...fake.api.mcpApps,
      listPluginViews: () => Promise.resolve({ success: true as const, data: views }),
      getView: () =>
        Promise.resolve({
          success: true as const,
          data: {
            html: "<p>settings view</p>",
            csp: {},
            prefersBorder: null,
            resultAvailable: false,
            result: null,
            invocation: null,
            pluginServerKey: listed.serverKey,
          },
        }),
    };
    // Opened from the palette, so the view store holds it too.
    const opened = pluginViewRef(listed);
    openMcpAppView("ws-plugin-gone", opened);
    try {
      const view = render(<ArtifactsPanel workspaceId="ws-plugin-gone" />, {
        wrapper: (props: { children: ReactNode }) => (
          <ThemeProvider forcedTheme="dark">
            <ApiWrapper>{props.children}</ApiWrapper>
          </ThemeProvider>
        ),
      });
      expect(await view.findByTestId("mcp-app-frame")).toBeTruthy();

      // The user revokes the project's trust in Settings → Security.
      views = [];
      act(() => publishProjectTrustChanged());
      await waitFor(() => expect(view.queryByTestId("mcp-app-frame")).toBeNull());
      // The earlier open does not keep the view alive.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.queryByTestId("mcp-app-frame")).toBeNull();
      expect(view.container.textContent).not.toContain("Review settings from plugin review-bot");
    } finally {
      closeMcpAppView("ws-plugin-gone", opened);
    }
  });

  test("lists app views from the transcript; Close returns to files and keeps them", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "# Report") }
    );
    fake.api.mcpApps = {
      ...fake.api.mcpApps,
      getView: () =>
        Promise.resolve({
          success: true as const,
          data: {
            html: "<p>view</p>",
            csp: {},
            prefersBorder: null,
            resultAvailable: true,
            result: { content: [] },
            pluginServerKey: null,
            invocation: null,
          },
        }),
    };
    const toolCall = (toolCallId: string, status: "completed" | "executing") =>
      ({
        type: "tool",
        id: toolCallId,
        historyId: toolCallId,
        toolCallId,
        toolName: "dice_show_dice_board",
        args: {},
        status,
        isPartial: false,
        historySequence: 1,
        mcpServer: {
          connection: { key: "dice", transport: "stdio" },
          identity: { name: "dice" },
          source: "connection",
          app: { resourceUri: "ui://dice/board.html" },
        },
      }) as unknown as DisplayedMessage;
    // The loaded transcript holds a settled call and a still-running one; neither was opened
    // from its card.
    const store = useWorkspaceStoreRaw();
    // A code_execution call that made one nested MCP Apps call.
    const parent = {
      ...(toolCall("call-code", "completed") as object),
      toolName: "code_execution",
      mcpServer: undefined,
      nestedCalls: [
        {
          toolCallId: "call-nested",
          toolName: "dice_show_dice_board",
          input: { count: 2 },
          output: { content: [] },
          state: "output-available",
          mcpServer: (toolCall("x", "completed") as unknown as { mcpServer: unknown }).mcpServer,
        },
      ],
    } as unknown as DisplayedMessage;
    const state = {
      messages: [toolCall("call-done", "completed"), toolCall("call-running", "executing"), parent],
    } as unknown as WorkspaceState;
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-app-transcript"
    );
    const getState = spyOn(store, "getWorkspaceState").mockImplementation(() => state);
    try {
      writeArtifactSelection("ws-app-transcript", { path: "mcp-app:call-done" });
      const view = render(<ArtifactsPanel workspaceId="ws-app-transcript" />, {
        wrapper: (props: { children: ReactNode }) => (
          <ThemeProvider forcedTheme="dark">
            <ApiWrapper>{props.children}</ApiWrapper>
          </ThemeProvider>
        ),
      });
      await view.findByTestId("mcp-app-frame");

      fireEvent.click(view.getByRole("button", { name: "Close view" }));
      expect(await view.findByText("Report")).toBeTruthy();
      expect(view.queryByTestId("mcp-app-frame")).toBeNull();
      expect(readArtifactSelection("ws-app-transcript").path).toBeNull();

      // Still listed after Close: selecting it again shows the view.
      act(() => writeArtifactSelection("ws-app-transcript", { path: "mcp-app:call-done" }));
      await view.findByTestId("mcp-app-frame");

      // A nested MCP Apps call (inside code_execution) is listed too.
      act(() => writeArtifactSelection("ws-app-transcript", { path: "mcp-app:call-nested" }));
      await view.findByTestId("mcp-app-frame");

      // A call that has not settled has no view yet.
      act(() => writeArtifactSelection("ws-app-transcript", { path: "mcp-app:call-running" }));
      expect(await view.findByText("Report")).toBeTruthy();
      expect(view.queryByTestId("mcp-app-frame")).toBeNull();

      // J/K walk the picker into the app views and back out to the files.
      fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "j" });
      await view.findByTestId("mcp-app-frame");
      // The newest app view comes first: the nested call of the last message.
      expect(readArtifactSelection("ws-app-transcript").path).toBe("mcp-app:call-nested");
      fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "k" });
      expect(await view.findByText("Report")).toBeTruthy();
      expect(readArtifactSelection("ws-app-transcript").path).toBe("report.md");
    } finally {
      registered.mockRestore();
      getState.mockRestore();
    }
  });

  test("version menu switches between stored versions and the live file", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 3, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "live draft", 3) },
      {
        versions: {
          "report.md": [version(2, "Final numbers", "report.md"), version(1, null, "report.md")],
        },
        versionFiles: {
          [`${idFor("report.md")}@1`]: textFile("report.md", "markdown", "first snapshot"),
        },
      }
    );
    const view = renderPanel();
    expect(await view.findByText("live draft")).toBeTruthy();

    fireEvent.click(await view.findByRole("button", { name: "Version: Latest (live)" }));
    const menu = view.getByRole("menu", { name: "Artifact versions" });
    // Newest first after "Latest (live)"; unlabeled snapshots get a plain fallback name.
    const items = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).map(
      (item) => item.textContent
    );
    expect(items[0]).toBe("Latest (live)");
    expect(items[1]).toContain("v2Final numbers");
    expect(items[2]).toContain("v1Turn snapshot");

    fireEvent.click(view.getByRole("menuitemradio", { name: /v1/ }));
    expect(await view.findByText("first snapshot")).toBeTruthy();
    expect(fake.state.readVersionCalls).toEqual([`${idFor("report.md")}@1`]);
    expect(view.queryByRole("menu")).toBeNull();

    const liveReads = fake.state.readCalls.length;
    fireEvent.click(view.getByRole("button", { name: "Version: v1" }));
    fireEvent.click(view.getByRole("menuitemradio", { name: "Latest (live)" }));
    expect(await view.findByText("live draft")).toBeTruthy();
    expect(fake.state.readCalls.length).toBe(liveReads + 1);
  });

  test("hides the version menu for artifacts without versions", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("notes.txt", 1, "text")],
        truncated: false,
      },
      { "notes.txt": textFile("notes.txt", "text", "plain notes") }
    );
    const view = renderPanel();
    expect(await view.findByText("plain notes")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Version:/ })).toBeNull();
  });

  test("keeps a stored version viewable after its working file is deleted", async () => {
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {},
      {
        versions: { "gone.md": [version(1, "Draft", "gone.md")] },
        versionFiles: { [`${idFor("gone.md")}@1`]: textFile("gone.md", "markdown", "kept bytes") },
      }
    );
    writeArtifactSelection("ws-artifacts", { path: "gone.md", version: 1 });
    const view = renderPanel();
    expect(await view.findByText("kept bytes")).toBeTruthy();
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("gone.md");
  });

  test("a truncated listing does not mark unlisted versioned artifacts as deleted", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text")],
        truncated: true,
        // b.txt may well exist past the listing cap.
        versionedPaths: ["b.txt"],
      },
      { "a.txt": textFile("a.txt", "text", "alpha") },
      {
        versions: { "b.txt": [version(1, null, "b.txt")] },
        versionFiles: { "id-b.txt@1": textFile("b.txt", "text", "beta stored") },
      }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    act(() => openArtifact({ workspaceId: "ws-artifacts", path: "b.txt" }));
    // Not offered as a deleted artifact: the selection falls back to a listed one.
    await waitFor(() =>
      expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("a.txt")
    );
    expect(view.queryByText("beta stored")).toBeNull();
    expect(fake.state.readVersionCalls).toEqual([]);
  });

  test("keeps a deleted artifact selected at its latest stored version", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [],
        truncated: false,
        versionedPaths: ["gone.md"],
      },
      {},
      {
        versions: { "gone.md": [version(2, "Final", "gone.md"), version(1, "Draft", "gone.md")] },
        versionFiles: {
          [`${idFor("gone.md")}@2`]: textFile("gone.md", "markdown", "latest kept bytes"),
        },
      }
    );
    writeArtifactSelection("ws-artifacts", { path: "gone.md", version: null });
    const view = renderPanel();
    expect(await view.findByText("latest kept bytes")).toBeTruthy();
    expect(fake.state.readVersionCalls).toEqual([`${idFor("gone.md")}@2`]);
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("gone.md");
  });

  test("shows why a stored version cannot load when listing versions fails", async () => {
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {},
      { listVersionsError: "Version index unreadable" }
    );
    writeArtifactSelection("ws-artifacts", { path: "gone.md", version: 1 });
    const view = renderPanel();
    expect(await view.findByText("Version index unreadable")).toBeTruthy();
    expect(view.queryByText("Loading…")).toBeNull();
  });

  test("shows a stored version while listing the live folder fails", async () => {
    fake = createFakeArtifactsApi(
      { available: true, dir: "/scratch/artifacts", entries: [], truncated: false },
      {},
      {
        listError: "Could not reach this workspace's runtime: offline",
        versions: { "report.md": [version(1, "Draft", "report.md")] },
        versionFiles: {
          [`${idFor("report.md")}@1`]: textFile("report.md", "markdown", "offline bytes"),
        },
      }
    );
    writeArtifactSelection("ws-artifacts", { path: "report.md", version: 1 });
    const view = renderPanel();
    expect(await view.findByText("offline bytes")).toBeTruthy();
    expect(view.getByText("Could not reach this workspace's runtime: offline")).toBeTruthy();
  });

  test("follows openArtifact while mounted and reads pinned files live", async () => {
    const pinnedFile: PinnedArtifactFile = {
      path: "README.md",
      kind: "markdown",
      size: 5,
      modifiedMs: 1,
    };
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") },
      {
        pinned: [pinnedFile],
        pinnedFiles: { "README.md": textFile("README.md", "markdown", "# Readme") },
      }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();

    act(() => openArtifact({ workspaceId: "ws-artifacts", path: "README.md", pinned: true }));
    expect(await view.findByRole("heading", { name: "Readme" })).toBeTruthy();
    expect(fake.state.readPinnedCalls).toEqual(["README.md"]);
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("README.md");

    // A new mtime from the pinned listing re-reads the live file.
    fake.state.pinned = [{ ...pinnedFile, modifiedMs: 2 }];
    fireEvent.click(view.getByRole("button", { name: "Reload artifact" }));
    await waitFor(() => expect(fake?.state.readPinnedCalls.length).toBeGreaterThanOrEqual(2));

    fireEvent.click(view.getByRole("button", { name: "Unpin file" }));
    expect(await view.findByText("alpha")).toBeTruthy();
    expect(fake.state.unpinCalls).toEqual(["README.md"]);
    expect(view.queryByRole("button", { name: "Unpin file" })).toBeNull();
  });

  test("a slow unpin does not take away a selection made meanwhile", async () => {
    const pinnedFile: PinnedArtifactFile = {
      path: "README.md",
      kind: "markdown",
      size: 5,
      modifiedMs: 1,
    };
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") },
      {
        pinned: [pinnedFile],
        pinnedFiles: { "README.md": textFile("README.md", "markdown", "# Readme") },
      }
    );
    const unpinned = Promise.withResolvers<{ success: true; data: undefined }>();
    fake.api.artifacts!.unpinFile = () => unpinned.promise;
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    act(() => openArtifact({ workspaceId: "ws-artifacts", path: "README.md", pinned: true }));
    expect(await view.findByRole("heading", { name: "Readme" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Unpin file" }));
    // The user picks another artifact before the unpin completes.
    act(() => openArtifact({ workspaceId: "ws-artifacts", path: "b.txt" }));
    expect(await view.findByText("beta")).toBeTruthy();
    await act(async () => {
      unpinned.resolve({ success: true, data: undefined });
      await unpinned.promise;
    });
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("b.txt");
    expect(view.queryByText("alpha")).toBeNull();
  });

  test("U unpins the selected pinned file and nothing else", async () => {
    const pinnedFile: PinnedArtifactFile = {
      path: "README.md",
      kind: "markdown",
      size: 5,
      modifiedMs: 1,
    };
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") },
      {
        pinned: [pinnedFile],
        pinnedFiles: { "README.md": textFile("README.md", "markdown", "# Readme") },
      }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();
    // An artifact is selected: U has nothing to unpin.
    fireEvent.keyDown(panel, { key: "u" });
    expect(fake.state.unpinCalls).toEqual([]);

    act(() => openArtifact({ workspaceId: "ws-artifacts", path: "README.md", pinned: true }));
    expect(await view.findByRole("heading", { name: "Readme" })).toBeTruthy();
    fireEvent.keyDown(panel, { key: "u" });
    await waitFor(() => expect(fake?.state.unpinCalls).toEqual(["README.md"]));
    expect(await view.findByText("alpha")).toBeTruthy();
  });

  test("shows shelf entries read-only and unpins them", async () => {
    const shelfEntry: ArtifactShelfEntry = {
      scope: "global",
      name: "style-guide.md",
      file: "style-guide.md",
      title: "style guide",
      kind: "markdown",
      size: 9,
      version: 2,
      sourceWorkspaceId: "ws-other",
      sourcePath: "style-guide.md",
      pinnedAtMs: 5,
      pinnedBy: "agent",
    };
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") },
      {
        shelf: { project: { available: true, entries: [] }, global: [shelfEntry] },
        shelfFiles: { "global:style-guide.md": textFile("style-guide.md", "markdown", "# Guide") },
      }
    );
    writeArtifactSelection("ws-artifacts", { scope: "shelf", path: "global:style-guide.md" });
    const view = renderPanel();
    expect(await view.findByRole("heading", { name: "Guide" })).toBeTruthy();
    expect(fake.state.readShelfCalls).toEqual(["global:style-guide.md"]);
    // Shelf copies are fixed: no version menu, an unpin action instead.
    expect(view.queryByRole("button", { name: /^Version:/ })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Unpin from shelf" }));
    expect(await view.findByText("alpha")).toBeTruthy();
    expect(fake.state.unpinShelfCalls).toEqual(["global:style-guide.md"]);
  });

  test("version menu pins the shown version, or the newest while following the live file", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 3, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "live draft", 3) },
      {
        versions: {
          "report.md": [version(2, "Final numbers", "report.md"), version(1, null, "report.md")],
        },
        versionFiles: {
          [`${idFor("report.md")}@1`]: textFile("report.md", "markdown", "first snapshot"),
        },
      }
    );
    const view = renderPanel();
    expect(await view.findByText("live draft")).toBeTruthy();
    fireEvent.click(await view.findByRole("button", { name: "Version: Latest (live)" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Pin to project shelf" }));
    await waitFor(() =>
      expect(fake?.state.pinToShelfCalls).toEqual([
        { artifactId: idFor("report.md"), version: 2, scope: "project" },
      ])
    );

    fireEvent.click(view.getByRole("button", { name: "Version: Latest (live)" }));
    fireEvent.click(view.getByRole("menuitemradio", { name: /v1/ }));
    expect(await view.findByText("first snapshot")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Version: v1" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Pin to global shelf" }));
    await waitFor(() =>
      expect(fake?.state.pinToShelfCalls.at(-1)).toEqual({
        artifactId: idFor("report.md"),
        version: 1,
        scope: "global",
      })
    );
  });

  test("pins and unpins shelf entries from the keyboard", async () => {
    const shelfEntry: ArtifactShelfEntry = {
      scope: "global",
      name: "report.md",
      file: "report.md",
      title: "report",
      kind: "markdown",
      size: 5,
      version: 2,
      sourceWorkspaceId: "ws-artifacts",
      sourcePath: "report.md",
      pinnedAtMs: 5,
      pinnedBy: "user",
    };
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 3, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "live draft", 3) },
      {
        versions: { "report.md": [version(2, "Final numbers", "report.md")] },
        shelf: { project: { available: true, entries: [] }, global: [shelfEntry] },
        shelfFiles: { "global:report.md": textFile("report.md", "markdown", "shelf copy") },
      }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("live draft")).toBeTruthy();
    await view.findByRole("button", { name: "Version: Latest (live)" });

    fireEvent.keyDown(panel, { key: "p" });
    fireEvent.keyDown(panel, { key: "P", shiftKey: true });
    await waitFor(() =>
      expect(fake?.state.pinToShelfCalls).toEqual([
        { artifactId: idFor("report.md"), version: 2, scope: "project" },
        { artifactId: idFor("report.md"), version: 2, scope: "global" },
      ])
    );

    act(() => writeArtifactSelection("ws-artifacts", { scope: "shelf", path: "global:report.md" }));
    expect(await view.findByText("shelf copy")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "u" });
    await waitFor(() => expect(fake?.state.unpinShelfCalls).toEqual(["global:report.md"]));
  });

  test("annotate mode turns a text selection into an attached artifact review note", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const reviewBackend = createFakeReviewStateClient();
    getReviewStateStore().setClient(reviewBackend.client);
    try {
      // Own workspace id: annotate mode outlives the panel by design, and this test leaves it on.
      const view = renderPanel("ws-annotate-selection");
      const paragraph = await view.findByText("Revenue grew 12% this quarter.");
      const select = () => {
        const range = document.createRange();
        range.setStart(paragraph.firstChild!, 8);
        range.setEnd(paragraph.firstChild!, 16);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        fireEvent.mouseUp(paragraph);
      };

      // Outside annotate mode a selection is just a selection.
      select();
      expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();

      fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "c" });
      expect(
        view.getByRole("button", { name: "Stop annotating" }).getAttribute("aria-pressed")
      ).toBe("true");
      select();
      const popover = await view.findByTestId("artifact-annotation-popover");
      fireEvent.change(popover.querySelector("textarea")!, { target: { value: "Source?" } });
      fireEvent.click(view.getByRole("button", { name: "Comment" }));

      await waitFor(() => expect(reviewBackend.deltas.length).toBeGreaterThan(0));
      const added = Object.values(reviewBackend.deltas[0].reviews?.set ?? {});
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        status: "attached",
        data: {
          filePath: "report.md",
          selectedCode: "grew 12%",
          userNote: "Source?",
          // The live file is annotated against its newest stored version.
          artifact: {
            version: 2,
            anchor: {
              kind: "text",
              quote: "grew 12%",
              prefix: "Revenue ",
              suffix: " this quarter.",
            },
          },
        },
      });
      expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();
    } finally {
      getReviewStateStore().setClient(null);
    }
  });

  // #5690: annotate mode needed a mouse; a pick happened only on mouseup.
  test("annotate mode: a keyboard selection in the viewer opens the comment box", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const view = renderPanel("ws-annotate-keyboard");
    const panel = view.getByTestId("artifacts-panel");
    const paragraph = await view.findByText("Revenue grew 12% this quarter.");
    const viewer = view.getByTestId("artifact-viewer-scroll");
    // Outside annotate mode the viewer is not a tab stop.
    expect(viewer.hasAttribute("tabindex")).toBe(false);
    fireEvent.keyDown(panel, { key: "c" });
    expect(viewer.getAttribute("tabindex")).toBe("0");

    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 8);
    range.setEnd(paragraph.firstChild!, 16);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    // Shortcuts that hold Shift (Shift+F) do not change the selection, so they open nothing.
    fireEvent.keyDown(viewer, { key: "F", shiftKey: true });
    fireEvent.keyUp(viewer, { key: "Shift" });
    expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();
    // Shift+Arrow extends a (caret browsing or screen reader) selection, often over several
    // presses: the box waits until Shift is released, or it would take focus after the first.
    for (let press = 0; press < 2; press++) {
      fireEvent.keyDown(viewer, { key: "ArrowRight", shiftKey: true });
      fireEvent.keyUp(viewer, { key: "ArrowRight", shiftKey: true });
    }
    expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();
    fireEvent.keyUp(viewer, { key: "Shift" });
    const popover = await view.findByTestId("artifact-annotation-popover");
    expect(popover.textContent).toContain("grew 12%");
  });

  test("the default selection prefers a versioned file over newer other files", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [
          entry("img/a.png", 3, "image"),
          entry("img/b.png", 2, "image"),
          entry("report.md", 1, "markdown"),
        ],
        truncated: false,
        versionedPaths: ["report.md"],
      },
      { "report.md": textFile("report.md", "markdown", "# Published report") }
    );
    const view = renderPanel();
    expect(await view.findByRole("heading", { name: "Published report" })).toBeTruthy();
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("report.md");
  });

  test("the default selection prefers a deleted published file over other files", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("img/a.png", 3, "image"), entry("img/b.png", 2, "image")],
        truncated: false,
        versionedPaths: ["report.md"],
      },
      {}
    );
    const view = renderPanel();
    await waitFor(() =>
      expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("report.md")
    );
  });

  test("J/K skip collapsed other files but keep the selected one", async () => {
    const shelfEntry: ArtifactShelfEntry = {
      scope: "global",
      name: "style-guide.md",
      file: "style-guide.md",
      title: "style guide",
      kind: "markdown",
      size: 9,
      version: 2,
      sourceWorkspaceId: "ws-other",
      sourcePath: "style-guide.md",
      pinnedAtMs: 5,
      pinnedBy: "agent",
    };
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [
          entry("img/a.png", 3, "image"),
          entry("img/b.png", 2, "image"),
          entry("report.md", 1, "markdown"),
        ],
        truncated: false,
        versionedPaths: ["report.md"],
      },
      { "report.md": textFile("report.md", "markdown", "# Published report") },
      {
        shelf: { project: { available: true, entries: [] }, global: [shelfEntry] },
        shelfFiles: { "global:style-guide.md": textFile("style-guide.md", "markdown", "# Guide") },
      }
    );
    writeArtifactSelection("ws-artifacts", { scope: "artifact", path: "img/b.png" });
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    const trigger = () => view.getByRole("combobox", { name: "Artifact" }).textContent;
    await waitFor(() => expect(trigger()).toContain("img/b.png"));

    // The selected other file stays listed after the versioned one; img/a.png is hidden.
    fireEvent.keyDown(panel, { key: "k" });
    expect(await view.findByRole("heading", { name: "Published report" })).toBeTruthy();
    fireEvent.keyDown(panel, { key: "j" });
    // img/b.png is no longer selected, so it is hidden too: J goes straight to the shelf.
    expect(await view.findByRole("heading", { name: "Guide" })).toBeTruthy();
    expect(trigger()).toContain("style-guide.md");
  });

  test("versions past a truncated listing's cap do not hide the listed files", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("c.txt", 1, "text")],
        truncated: true,
        // b.txt may exist past the cap, so it is no versioned file to group the listed ones under.
        versionedPaths: ["b.txt"],
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "c.txt": textFile("c.txt", "text", "gamma") }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    // A flat list: J reaches c.txt instead of skipping it as a collapsed other file.
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "j" });
    expect(await view.findByText("gamma")).toBeTruthy();
  });

  test("annotate stays off until the live file's version list arrives", async () => {
    let releaseVersions: (() => void) | undefined;
    const versionsGate = new Promise<void>((resolve) => {
      releaseVersions = resolve;
    });
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] }, versionsGate }
    );
    const view = renderPanel();
    await view.findByText("Revenue grew 12% this quarter.");
    // The note would record a version, and which one is not known yet.
    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "c" });
    expect(view.queryByRole("button", { name: "Stop annotating" })).toBeNull();
    releaseVersions?.();
    expect(await view.findByRole("button", { name: "Annotate" })).toBeTruthy();
  });

  test("Esc leaves annotate mode without reaching Escape-to-interrupt", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    await view.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(panel, { key: "c" });
    expect(view.getByRole("button", { name: "Stop annotating" })).toBeTruthy();

    let escapeReachedWindowUnhandled = false;
    const windowListener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) escapeReachedWindowUnhandled = true;
    };
    window.addEventListener("keydown", windowListener);
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(view.getByRole("button", { name: "Annotate" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(escapeReachedWindowUnhandled).toBe(false);
    // Not annotating: Esc is not the panel's, so it still reaches window handlers.
    fireEvent.keyDown(panel, { key: "Escape" });
    window.removeEventListener("keydown", windowListener);
    expect(escapeReachedWindowUnhandled).toBe(true);
  });

  test("annotate mode survives a sidebar tab switch and stays per workspace", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const first = renderPanel("ws-annotate-a");
    await first.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(first.getByTestId("artifacts-panel"), { key: "c" });
    expect(first.getByRole("button", { name: "Stop annotating" })).toBeTruthy();

    // Switching sidebar tabs unmounts the panel.
    first.unmount();
    const second = renderPanel("ws-annotate-a");
    expect(await second.findByRole("button", { name: "Stop annotating" })).toBeTruthy();
    second.unmount();

    // Another workspace has its own mode.
    const other = renderPanel("ws-annotate-b");
    expect(await other.findByRole("button", { name: "Annotate" })).toBeTruthy();
    other.rerender(<ArtifactsPanel workspaceId="ws-annotate-a" />);
    expect(await other.findByRole("button", { name: "Stop annotating" })).toBeTruthy();
    // Turning it off is remembered too.
    fireEvent.keyDown(other.getByTestId("artifacts-panel"), { key: "Escape" });
    other.unmount();
    const last = renderPanel("ws-annotate-a");
    expect(await last.findByRole("button", { name: "Annotate" })).toBeTruthy();
  });

  test("Shift+F then K switches artifact inside fullscreen, and closing returns to the panel", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();

    panel.focus();
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact b.txt" });
    // Focus lands on the dialog itself, not its first control (the picker owns letter keys).
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(await within(dialog).findByText("alpha")).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: "F", shiftKey: true });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  // #5694: closing fullscreen returns focus to the button that opened it, as dialogs do.
  test("closing fullscreen returns focus to the Fullscreen button that opened it", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 2, "text"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha"), "b.txt": textFile("b.txt", "text", "beta") }
    );
    const view = renderPanel();
    expect(await view.findByText("alpha")).toBeTruthy();
    const button = view.getByRole("button", { name: "Fullscreen" });
    // A real click focuses the button before it activates.
    act(() => button.focus());
    fireEvent.click(button);
    const dialog = await view.findByRole("dialog", { name: "Artifact a.txt" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);
    // J/K still reach the panel from the button.
    fireEvent.keyDown(button, { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();
  });

  // #5715: the undo cleared inert that another component set while fullscreen was open.
  test("leaving fullscreen keeps inert that another component set meanwhile", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") }
    );
    const mine = document.body.appendChild(document.createElement("div"));
    const theirs = document.body.appendChild(document.createElement("div"));
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();
    // No await between opening fullscreen and the mutations: happy-dom holds MutationObserver
    // listeners through a WeakRef, so a GC during an await can silently drop the observer.
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    view.getByRole("dialog", { name: "Artifact a.txt" });
    expect([mine.inert, theirs.inert]).toEqual([true, true]);
    // Another component (ChatPane under immersive review sets the attribute) marks it as well.
    theirs.setAttribute("inert", "");

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect([mine.inert, theirs.inert]).toEqual([false, true]);
    mine.remove();
    theirs.remove();
  });

  // #5715: focus that fell to <body> with a removed node outside the panel (a portaled menu) came
  // back only after the next change inside the panel.
  test("in fullscreen, focus lost with a node outside the panel returns to the panel", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("a.txt", 1, "text")],
        truncated: false,
      },
      { "a.txt": textFile("a.txt", "text", "alpha") }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();
    // No await until the menu is gone: happy-dom holds MutationObserver listeners through a
    // WeakRef, so a GC during an await can silently drop the observer.
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = view.getByRole("dialog", { name: "Artifact a.txt" });
    // Portaled menus open after fullscreen, so they are not inert.
    const menu = document.body.appendChild(document.createElement("button"));
    act(() => menu.focus());
    expect(document.activeElement).toBe(menu);

    act(() => menu.remove());
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  test("the fullscreen dialog shows its focus ring while shortcuts focus it", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("data.json", 2, "json"), entry("b.txt", 1, "text")],
        truncated: false,
      },
      {
        "data.json": textFile("data.json", "json", '{"runs":[1,2]}', 2),
        "b.txt": textFile("b.txt", "text", "beta"),
      }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("runs:")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact data.json" });
    // Opening fullscreen focuses the dialog itself, by script: Chrome may not count that as
    // :focus-visible, so the dialog marks it.
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(dialog.getAttribute("data-shortcut-focus")).toBe("true");

    // Focus moving into a control clears it; that control shows its own ring.
    const toggle = within(dialog).getAllByRole("button", { expanded: true })[0];
    act(() => toggle.focus());
    expect(dialog.hasAttribute("data-shortcut-focus")).toBe(false);

    // J from that control moves focus back to the dialog, marked again.
    fireEvent.keyDown(toggle, { key: "j" });
    expect(await within(dialog).findByText("beta")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute("data-shortcut-focus")).toBe("true");
  });

  // A narrow window mounts ArtifactsDialog while the CSS-hidden sidebar panel stays mounted.
  test("two mounted panels share annotate mode, JSON mode and tree expansion", async () => {
    const workspaceId = "ws-two-panels";
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("data.json", 1, "json")],
        truncated: false,
      },
      { "data.json": textFile("data.json", "json", '{"runs":[1,2]}') },
      { versions: { "data.json": [version(2, null, "data.json")] } }
    );
    const sidebar = renderPanel(workspaceId);
    const dialog = renderPanel(workspaceId);
    const [a, b] = [sidebar.container, dialog.container];
    await within(a).findByRole("button", { name: /^runs:/ });
    await within(b).findByRole("button", { name: /^runs:/ });
    const attr = (root: HTMLElement, name: string | RegExp, attribute: string) =>
      within(root).getByRole("button", { name }).getAttribute(attribute);

    // Annotate: on in one, then off in the other, reaches both.
    await within(a).findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(within(a).getByTestId("artifacts-panel"), { key: "c" });
    expect(await within(b).findByRole("button", { name: "Stop annotating" })).toBeTruthy();
    fireEvent.keyDown(within(b).getByTestId("artifacts-panel"), { key: "Escape" });
    expect(await within(a).findByRole("button", { name: "Annotate" })).toBeTruthy();

    // Tree expansion.
    fireEvent.click(within(b).getByRole("button", { name: /^runs:/ }));
    expect(attr(a, /^runs:/, "aria-expanded")).toBe("false");

    // JSON mode.
    fireEvent.click(within(b).getByRole("button", { name: "raw" }));
    expect(attr(a, "raw", "aria-pressed")).toBe("true");
  });

  test("Esc on the closed picker leaves annotate mode", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const view = renderPanel("ws-annotate-picker");
    await view.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "c" });
    expect(view.getByRole("button", { name: "Stop annotating" })).toBeTruthy();

    const trigger = view.getByRole("combobox", { name: "Artifact" });
    trigger.focus();
    let escapeReachedWindowUnhandled = false;
    const windowListener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) escapeReachedWindowUnhandled = true;
    };
    window.addEventListener("keydown", windowListener);
    fireEvent.keyDown(trigger, { key: "Escape" });
    window.removeEventListener("keydown", windowListener);
    expect(view.getByRole("button", { name: "Annotate" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(escapeReachedWindowUnhandled).toBe(false);
    // The open list keeps Escape: it closes the list, not annotate mode.
    fireEvent.keyDown(view.getByTestId("artifacts-panel"), { key: "c" });
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    const option = document.createElement("div");
    listbox.appendChild(option);
    view.getByTestId("artifacts-panel").appendChild(listbox);
    fireEvent.keyDown(option, { key: "Escape" });
    expect(view.getByRole("button", { name: "Stop annotating" })).toBeTruthy();
    listbox.remove();
  });

  // Bug bash: the comment box unmounted with focus in it, focus fell to <body>, and later Escapes
  // never reached the panel (the Radix dialog's focus trap used to hide this).
  test("in fullscreen, Esc keeps peeling layers after it closes the comment box", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const view = renderPanel("ws-annotate-escape-layers");
    const panel = view.getByTestId("artifacts-panel");
    await view.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(panel, { key: "c" });
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    await view.findByRole("dialog", { name: "Artifact report.md" });
    const paragraph = view.getByText("Revenue grew 12% this quarter.");
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 8);
    range.setEnd(paragraph.firstChild!, 16);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(paragraph);
    const textarea = (await view.findByTestId("artifact-annotation-popover")).querySelector(
      "textarea"
    )!;
    textarea.focus();

    // Keys go to whatever has focus, as a real key press would.
    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() => expect(view.queryByTestId("artifact-annotation-popover")).toBeNull());
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(view.getByRole("button", { name: "Annotate" }).getAttribute("aria-pressed")).toBe(
      "false"
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  // Review: leaving fullscreen from inside the viewer (Escape in an HTML frame arrives over the
  // bridge) left focus on that control or frame, which forwards only Escape and Shift+F, so J/K,
  // C and R stopped working. The dialog always focused the panel on close; so must we.
  test("leaving fullscreen from a control inside the viewer focuses the panel", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("data.json", 1, "json")],
        truncated: false,
      },
      { "data.json": textFile("data.json", "json", '{"runs":[1,2]}') }
    );
    const view = renderPanel("ws-fullscreen-exit-focus");
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("runs:")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact data.json" });
    const toggle = within(dialog).getAllByRole("button", { expanded: true })[0];
    act(() => toggle.focus());

    fireEvent.keyDown(toggle, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(toggle.isConnected).toBe(true);
    expect(document.activeElement).toBe(panel);
  });

  // Bug bash: the comment box is placed at the selection's screen position, so after the layout
  // changed it floated over the sidebar, far from its text.
  test("leaving or entering fullscreen closes an open comment box", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const view = renderPanel("ws-annotate-fullscreen-box");
    const panel = view.getByTestId("artifacts-panel");
    await view.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(panel, { key: "c" });
    const pick = async () => {
      const paragraph = view.getByText("Revenue grew 12% this quarter.");
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 8);
      range.setEnd(paragraph.firstChild!, 16);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.mouseUp(paragraph);
      await view.findByTestId("artifact-annotation-popover");
    };

    await pick();
    fireEvent.click(view.getByRole("button", { name: "Fullscreen" }));
    await view.findByRole("dialog", { name: "Artifact report.md" });
    expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();

    await pick();
    fireEvent.click(view.getByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();
    // Annotate mode itself stays on: only the box, tied to the old layout, goes.
    expect(view.getByRole("button", { name: "Stop annotating" })).toBeTruthy();
    // Re-entering does not bring the old box back.
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    await view.findByRole("dialog", { name: "Artifact report.md" });
    expect(view.queryByTestId("artifact-annotation-popover")).toBeNull();
  });

  test("in fullscreen, the first Esc leaves annotate mode and the second closes it", async () => {
    fake = createFakeArtifactsApi(
      {
        available: true,
        dir: "/scratch/artifacts",
        entries: [entry("report.md", 1, "markdown")],
        truncated: false,
      },
      { "report.md": textFile("report.md", "markdown", "Revenue grew 12% this quarter.") },
      { versions: { "report.md": [version(2, null, "report.md")] } }
    );
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    await view.findByRole("button", { name: "Annotate" });
    fireEvent.keyDown(panel, { key: "c" });
    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact report.md" });

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Annotate" }).getAttribute("aria-pressed")
      ).toBe("false")
    );
    expect(view.queryByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });
});

describe("appViewPickerDetails", () => {
  const view = (toolCallId: string, args: unknown, failed = false): McpAppViewRef => ({
    toolCallId,
    serverName: "dice",
    resourceUri: "ui://dice/board.html",
    toolName: "show_dice_board",
    label: "show_dice_board",
    arguments: args,
    cancelled: failed,
    failed,
  });

  test("tells apart calls that differ only by arguments or outcome", () => {
    const details = appViewPickerDetails([
      view("c", { count: 4 }, true),
      view("b", { count: 2 }),
      view("a", { count: 4 }),
    ]);
    expect(new Set(details).size).toBe(3);
    expect(details[0]).toContain("failed");
  });

  test("numbers repeats of the same call, oldest first", () => {
    const details = appViewPickerDetails([
      view("new", { count: 4 }),
      view("other", { count: 6 }),
      view("old", { count: 4 }),
    ]);
    expect(new Set(details).size).toBe(3);
    expect(details[0].endsWith("#2")).toBe(true);
    expect(details[2].endsWith("#1")).toBe(true);
    expect(details[1]).not.toContain("#");
  });

  test("shows control and bidi characters from model arguments as escapes", () => {
    const [detail] = appViewPickerDetails([view("a", { label: "safe\u202Eexe.txt\nnext" })]);
    expect(detail).not.toMatch(/[\u202E\n]/);
    expect(detail).toContain("\\u202e");
  });
});
