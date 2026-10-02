// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactReadResult,
} from "@/common/orpc/schemas/artifacts";
import {
  ARTIFACTS_SELECTION_KEY,
  ARTIFACTS_SELECTION_MAX_WORKSPACES,
} from "@/common/constants/storage";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { readArtifactSelection, writeArtifactSelection } from "./artifactSelection";

function entry(path: string, modifiedMs: number, kind: ArtifactEntry["kind"]): ArtifactEntry {
  return { path, kind, size: 10, modifiedMs };
}

function createFakeArtifactsApi(
  listing: ArtifactListing,
  files: Record<string, ArtifactReadResult>
) {
  const state = { listing, files, listCalls: 0, readCalls: [] as string[] };
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      list: () => {
        state.listCalls += 1;
        return Promise.resolve({ success: true as const, data: state.listing });
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

  test("J/K/R do nothing while the picker list is open", async () => {
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
    // Stand-in for the open Radix listbox, whose key events bubble to the panel.
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    const option = document.createElement("div");
    listbox.appendChild(option);
    panel.appendChild(listbox);
    const listsBefore = fake.state.listCalls;
    fireEvent.keyDown(option, { key: "j" });
    fireEvent.keyDown(option, { key: "r" });
    expect(view.getByRole("combobox", { name: "Artifact" }).textContent).toContain("a.txt");
    expect(fake.state.listCalls).toBe(listsBefore);
    listbox.remove();
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
});
