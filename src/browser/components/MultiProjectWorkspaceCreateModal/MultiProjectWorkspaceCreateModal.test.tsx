import "../../../../tests/ui/dom";

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import * as ExperimentsModule from "@/browser/hooks/useExperiments";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";

// bun test shares module mocks across suites; leaking this stub would hide later dialogs.
const realDialogExports = { ...RealDialogModule };

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { MultiProjectWorkspaceCreateModal } from "./MultiProjectWorkspaceCreateModal";

let cleanupDom: (() => void) | null = null;

function renderModal() {
  return render(
    <MultiProjectWorkspaceCreateModal
      isOpen={true}
      onClose={() => undefined}
      onConfirm={() => Promise.resolve()}
      projectOptions={[
        { projectPath: "/projects/a", projectName: "a" },
        { projectPath: "/projects/b", projectName: "b" },
      ]}
    />
  );
}

describe("MultiProjectWorkspaceCreateModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    spyOn(ExperimentsModule, "useExperimentValue").mockImplementation(() => true);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  afterAll(() => {
    void mock.module("@/browser/components/Dialog/Dialog", () => realDialogExports);
  });

  test("renders when the experiment is enabled", () => {
    const view = renderModal();

    expect(view.getByText("New Multi-Project Workspace")).toBeTruthy();
  });

  test("returns null when the experiment is disabled even if a caller tries to open it", () => {
    spyOn(ExperimentsModule, "useExperimentValue").mockImplementation(() => false);

    const view = renderModal();

    expect(view.queryByText("New Multi-Project Workspace")).toBeNull();
  });
});
