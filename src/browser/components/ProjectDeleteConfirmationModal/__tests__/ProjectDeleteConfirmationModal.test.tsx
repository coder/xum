import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";

restoreModulesAfterSuite([["@/browser/components/Dialog/Dialog", { ...RealDialogModule }]]);

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: {
    open: boolean;
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (props.open ? <div>{props.children}</div> : null),
  DialogContent: (props: {
    children: ReactNode;
    onKeyDown?: (event: KeyboardEvent) => void;
    onEscapeKeyDown?: (event: { preventDefault: () => void }) => void;
  }) => (
    <div
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.key === "Escape") {
          props.onEscapeKeyDown?.(event);
        }
      }}
    >
      {props.children}
    </div>
  ),
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningBox: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningTitle: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningText: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { ProjectDeleteConfirmationModal } from "../ProjectDeleteConfirmationModal";

type ModalProps = ComponentProps<typeof ProjectDeleteConfirmationModal>;

const DEFAULT_PROPS: ModalProps = {
  isOpen: true,
  projectName: "test-project",
  activeCount: 0,
  archivedCount: 2,
  onConfirm: () => undefined,
  onCancel: () => undefined,
};

function renderModal(overrides: Partial<ModalProps> = {}) {
  return render(<ProjectDeleteConfirmationModal {...DEFAULT_PROPS} {...overrides} />);
}

async function typeProjectName(input: HTMLInputElement, value: string) {
  const user = userEvent.setup({ document: input.ownerDocument });
  await user.clear(input);
  await user.type(input, value);
}

let cleanupDom: (() => void) | null = null;

describe("ProjectDeleteConfirmationModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("shows both active and archived counts when both present", () => {
    const { getByText } = renderModal({ activeCount: 3, archivedCount: 2 });

    expect(getByText(/5 workspaces/)).not.toBeNull();
    expect(getByText(/\(3 active, 2 archived\)/)).not.toBeNull();
    expect(getByText(/chat transcripts and worktrees will be lost/)).not.toBeNull();
  });

  it("shows data loss warning", () => {
    const { getByText } = renderModal({ activeCount: 0, archivedCount: 1 });

    expect(getByText(/chat transcripts and worktrees will be lost/)).not.toBeNull();
  });

  it("shows only total count when only active workspaces", () => {
    const { getByText, queryByText } = renderModal({ activeCount: 2, archivedCount: 0 });

    expect(getByText(/2 workspaces/)).not.toBeNull();
    expect(queryByText(/active/)).toBeNull();
    expect(queryByText(/archived/)).toBeNull();
  });

  it("shows only total count when only archived workspaces", () => {
    const { getByText, queryByText } = renderModal({ activeCount: 0, archivedCount: 3 });

    expect(getByText(/3 workspaces/)).not.toBeNull();
    expect(queryByText(/active/)).toBeNull();
    expect(queryByText(/archived/)).toBeNull();
  });

  it("keeps confirm button disabled until project name is typed exactly", async () => {
    const { getByRole, getByPlaceholderText } = renderModal({ projectName: "alpha" });

    const confirmButton = getByRole("button", { name: "Delete Project" }) as HTMLButtonElement;
    const confirmationInput = getByPlaceholderText('Type "alpha" to confirm') as HTMLInputElement;
    expect(confirmButton.disabled).toBe(true);

    await typeProjectName(confirmationInput, "alp");
    expect(confirmButton.disabled).toBe(true);
  });

  it("enables confirm button only on exact case-sensitive name match", async () => {
    const { getByRole, getByPlaceholderText } = renderModal({ projectName: "MyProject" });

    const confirmationInput = getByPlaceholderText(
      'Type "MyProject" to confirm'
    ) as HTMLInputElement;
    const confirmButton = getByRole("button", { name: "Delete Project" }) as HTMLButtonElement;

    await typeProjectName(confirmationInput, "myproject");
    expect(confirmButton.disabled).toBe(true);

    await typeProjectName(confirmationInput, "MyProject");
    expect(confirmButton.disabled).toBe(false);
  });

  it("calls onConfirm when delete is clicked after exact name match", async () => {
    const onConfirm = mock(() => undefined);
    const { getByRole, getByPlaceholderText } = renderModal({
      projectName: "alpha",
      onConfirm,
    });

    const confirmationInput = getByPlaceholderText('Type "alpha" to confirm') as HTMLInputElement;
    await typeProjectName(confirmationInput, "alpha");
    fireEvent.click(getByRole("button", { name: "Delete Project" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm when Enter is pressed after exact name match", async () => {
    const onConfirm = mock(() => undefined);
    const { getByPlaceholderText } = renderModal({
      projectName: "alpha",
      onConfirm,
    });

    const confirmationInput = getByPlaceholderText('Type "alpha" to confirm') as HTMLInputElement;
    await typeProjectName(confirmationInput, "alpha");
    fireEvent.keyDown(confirmationInput, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape is pressed", () => {
    const onCancel = mock(() => undefined);
    const { getByPlaceholderText } = renderModal({
      projectName: "alpha",
      onCancel,
    });

    const confirmationInput = getByPlaceholderText('Type "alpha" to confirm');
    fireEvent.keyDown(confirmationInput, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = mock(() => undefined);
    const { getByRole } = renderModal({ onCancel });

    fireEvent.click(getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clears typed input each time the modal opens", async () => {
    const onConfirm = mock(() => undefined);
    const onCancel = mock(() => undefined);

    const { getByPlaceholderText, rerender } = render(
      <ProjectDeleteConfirmationModal
        isOpen={true}
        projectName="alpha"
        activeCount={0}
        archivedCount={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    const firstOpenInput = getByPlaceholderText('Type "alpha" to confirm') as HTMLInputElement;
    await typeProjectName(firstOpenInput, "alpha");
    expect(firstOpenInput.value).toBe("alpha");

    rerender(
      <ProjectDeleteConfirmationModal
        isOpen={false}
        projectName="alpha"
        activeCount={0}
        archivedCount={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    rerender(
      <ProjectDeleteConfirmationModal
        isOpen={true}
        projectName="alpha"
        activeCount={0}
        archivedCount={1}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    const reopenedInput = getByPlaceholderText('Type "alpha" to confirm') as HTMLInputElement;
    expect(reopenedInput.value).toBe("");
  });
});
