import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";

restoreModulesAfterSuite([["@/browser/components/Dialog/Dialog", { ...RealDialogModule }]]);

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import type { SavedQuerySqlDialog as SavedQuerySqlDialogComponent } from "./SavedQuerySqlDialog";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const {
  SavedQuerySqlDialog,
}: {
  SavedQuerySqlDialog: typeof SavedQuerySqlDialogComponent;
} = require("./SavedQuerySqlDialog?real=1");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */

function renderDialog(overrides: Partial<React.ComponentProps<typeof SavedQuerySqlDialog>> = {}) {
  const onSave = overrides.onSave ?? mock(() => undefined);
  const onOpenChange = overrides.onOpenChange ?? mock(() => undefined);
  const onSqlChange = overrides.onSqlChange ?? mock(() => undefined);

  const view = render(
    <SavedQuerySqlDialog
      open
      label="Saved panel"
      sql="SELECT 1"
      saving={false}
      saveDisabled={false}
      error={null}
      onSqlChange={onSqlChange}
      onOpenChange={onOpenChange}
      onSave={onSave}
      {...overrides}
    />
  );

  return { ...view, onSave, onOpenChange, onSqlChange };
}

describe("SavedQuerySqlDialog", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("does not trigger keyboard save while saving is disabled", () => {
    const view = renderDialog({ saveDisabled: true });

    fireEvent.keyDown(view.getByRole("textbox", { name: "Saved query SQL" }), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(view.onSave).not.toHaveBeenCalled();
  });

  test("triggers keyboard save when saving is enabled", () => {
    const view = renderDialog();

    fireEvent.keyDown(view.getByRole("textbox", { name: "Saved query SQL" }), {
      key: "Enter",
      metaKey: true,
    });

    expect(view.onSave).toHaveBeenCalledTimes(1);
  });
});
