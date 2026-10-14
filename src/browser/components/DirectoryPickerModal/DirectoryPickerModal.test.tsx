import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";

restoreModulesAfterSuite([["@/browser/components/Dialog/Dialog", { ...RealDialogModule }]]);

// Radix portals do not render in happy-dom: render the dialog inline.
void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { DirectoryPickerModal } from "./DirectoryPickerModal";

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

/** Children per directory path; a path in `held` answers only once its promise settles. */
let tree: Record<string, string[]>;
let held: Record<string, Promise<void>>;
let listed: string[];

function listDirectory({ path }: { path: string }) {
  listed.push(path);
  const children = (tree[path] ?? []).map((name) => ({
    name,
    path: `${path}/${name}`,
    isDirectory: true,
    children: [],
  }));
  return Promise.resolve(held[path]).then(() => ({
    success: true as const,
    data: { name: path, path, isDirectory: true, children },
  }));
}

function isSelectedRow(view: ReturnType<typeof render>, name: string): boolean {
  return view.getByText(name).closest("li")?.className.includes("bg-white/10") ?? false;
}

// #6383: a reconnect must not reset the open picker to its initial path.
describe.each([...GAP_MODES])("DirectoryPickerModal across a reconnect (%s)", (mode) => {
  let harness: ReturnType<typeof createConnectionHarness>;

  beforeEach(() => {
    tree = { "/home": ["b"], "/home/b": ["inner"] };
    held = {};
    listed = [];
    harness = createConnectionHarness(mode, () => ({ general: { listDirectory } }));
  });

  function renderPicker(initialPath = "/home") {
    const picker = (path: string) => (
      <DirectoryPickerModal
        isOpen
        initialPath={path}
        onClose={() => undefined}
        onSelectPath={() => undefined}
      />
    );
    const view = render(picker(initialPath), { wrapper: harness.Wrapper });
    const input = view.getByPlaceholderText("Enter path...");
    if (!(input instanceof HTMLInputElement)) throw new Error("the path field is an input");
    return { view, input, rerender: (path: string) => view.rerender(picker(path)) };
  }

  test("keeps the typed path and reloads the shown directory", async () => {
    tree["/home/a"] = [];
    const { view, input } = renderPicker();
    await waitFor(() => expect(listed).toEqual(["/home"]));

    const user = userEvent.setup({ document: input.ownerDocument });
    await user.clear(input);
    await user.type(input, "/home/a{Enter}");
    await waitFor(() => expect(listed).toEqual(["/home", "/home/a"]));
    await waitFor(() => expect(input.value).toBe("/home/a"));
    await user.type(input, "/typed");

    await harness.drop();
    harness.reconnect();
    await waitFor(() => expect(listed).toEqual(["/home", "/home/a", "/home/a"]));
    expect(input.value).toBe("/home/a/typed");
    expect(view.queryByText("Not connected to server")).toBeNull();
  });

  // A directory added during the outage must not move the selection to another row.
  test("keeps the selected directory when the reload lists another one before it", async () => {
    const { view } = renderPicker();
    await view.findByText("b");
    const treeContainer = view.container.querySelector("[tabindex]");
    if (!treeContainer) throw new Error("the directory tree is focusable");
    // Row 0 is "..", so ArrowDown selects "b".
    fireEvent.keyDown(treeContainer, { key: "ArrowDown" });
    await waitFor(() => expect(isSelectedRow(view, "b")).toBe(true));

    tree["/home"] = ["a", "b"];
    await harness.drop();
    harness.reconnect();
    await view.findByText("a");
    expect(isSelectedRow(view, "b")).toBe(true);
  });

  test("a navigation during the reconnect reload wins over the reload", async () => {
    const { view, input } = renderPicker();
    await view.findByText("b");

    let release: (() => void) | null = null;
    held["/home"] = new Promise<void>((resolve) => (release = resolve));
    await harness.drop();
    harness.reconnect();
    await waitFor(() => expect(listed).toEqual(["/home", "/home"]));
    fireEvent.click(view.getByText("b"));
    await view.findByText("inner");

    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.queryByText("inner")).not.toBeNull();
    expect(input.value).toBe("/home/b");
  });

  // Add Project loads its default clone directory after a reconnect, which changes initialPath.
  test("a new initialPath while open keeps the typed path", async () => {
    const { input, rerender } = renderPicker("~");
    await waitFor(() => expect(listed).toEqual(["~"]));
    const user = userEvent.setup({ document: input.ownerDocument });
    await user.type(input, "/typed");

    rerender("/projects");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(input.value).toBe("~/typed");
    expect(listed).not.toContain("/projects");
  });
});

describe("DirectoryPickerModal selection", () => {
  test("showing hidden folders keeps the selected directory", async () => {
    tree = { "/home": [".a", "b"] };
    held = {};
    listed = [];
    const harness = createConnectionHarness("kept-gap", () => ({ general: { listDirectory } }));
    const view = render(
      <DirectoryPickerModal
        isOpen
        initialPath="/home"
        onClose={() => undefined}
        onSelectPath={() => undefined}
      />,
      { wrapper: harness.Wrapper }
    );
    await view.findByText("b");
    const treeContainer = view.container.querySelector("[tabindex]");
    if (!treeContainer) throw new Error("the directory tree is focusable");
    fireEvent.keyDown(treeContainer, { key: "ArrowDown" });
    await waitFor(() => expect(isSelectedRow(view, "b")).toBe(true));

    fireEvent.click(view.getByRole("checkbox"));
    await view.findByText(".a");
    expect(isSelectedRow(view, "b")).toBe(true);
  });
});
