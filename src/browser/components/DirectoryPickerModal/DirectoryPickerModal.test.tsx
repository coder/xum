import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
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

// #6383: a reconnect must not reset the open picker to its initial path.
describe.each([...GAP_MODES])("DirectoryPickerModal across a reconnect (%s)", (mode) => {
  test("keeps the typed path and reloads the shown directory", async () => {
    const listed: string[] = [];
    const harness = createConnectionHarness(mode, () => ({
      general: {
        listDirectory: ({ path }: { path: string }) => {
          listed.push(path);
          return Promise.resolve({
            success: true as const,
            data: { name: path, path, isDirectory: true, children: [] },
          });
        },
      },
    }));
    const view = render(
      <DirectoryPickerModal
        isOpen
        initialPath="/home"
        onClose={() => undefined}
        onSelectPath={() => undefined}
      />,
      { wrapper: harness.Wrapper }
    );
    await waitFor(() => expect(listed).toEqual(["/home"]));

    const input = view.getByPlaceholderText("Enter path...");
    if (!(input instanceof HTMLInputElement)) throw new Error("the path field is an input");
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
});
