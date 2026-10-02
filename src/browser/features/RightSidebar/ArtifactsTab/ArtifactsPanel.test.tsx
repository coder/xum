// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
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
import { closeMcpAppView, openMcpAppView } from "./mcpAppViewsStore";
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
    /** Version contents keyed by `${artifactId}@${version}`. */
    versionFiles?: Record<string, ArtifactReadResult>;
    pinned?: PinnedArtifactFile[];
    pinnedFiles?: Record<string, ArtifactReadResult>;
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
      listVersions: (input: { workspaceId: string; path: string }) =>
        Promise.resolve(
          extra.listVersionsError != null
            ? { success: false as const, error: extra.listVersionsError }
            : {
                success: true as const,
                data: {
                  artifactId: idFor(input.path),
                  path: input.path,
                  pin: null,
                  versions: extra.versions?.[input.path] ?? [],
                },
              }
        ),
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

function renderPanel(workspaceId = "ws-artifacts") {
  return render(<ArtifactsPanel workspaceId={workspaceId} />, { wrapper: ApiWrapper });
}

describe("ArtifactsPanel", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    // Desktop mode, so app views mount their frame (executableFrames.ts).
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

  test("J/K/R do nothing while the picker list or the version menu is open", async () => {
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
    const view = renderPanel();
    const panel = view.getByTestId("artifacts-panel");
    expect(await view.findByText("alpha")).toBeTruthy();

    fireEvent.keyDown(panel, { key: "j" });
    expect(await view.findByText("beta")).toBeTruthy();
    fireEvent.keyDown(panel, { key: "k" });
    expect(await view.findByText("alpha")).toBeTruthy();

    fireEvent.keyDown(panel, { key: "F", shiftKey: true });
    const dialog = await view.findByRole("dialog", { name: "Artifact a.txt" });
    // Modal: the app behind it is hidden from assistive tech (and focus is trapped inside).
    expect(view.container.closest("[aria-hidden='true']")).not.toBeNull();
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
    // Focus returns to the panel, so J/K keep working without another click.
    await waitFor(() => expect(document.activeElement).toBe(panel));
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
            invocation: null,
          },
        });
      },
    };
    openMcpAppView("ws-app-reload", {
      toolCallId: "call-1",
      serverName: "charts",
      resourceUri: "ui://charts/view",
      toolName: "show_chart",
      label: "Show chart",
      arguments: {},
      cancelled: false,
    });
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
      closeMcpAppView("ws-app-reload", "call-1");
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
      closeMcpAppView("ws-app-close", "call-a");
      closeMcpAppView("ws-app-close", "call-b");
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
});
