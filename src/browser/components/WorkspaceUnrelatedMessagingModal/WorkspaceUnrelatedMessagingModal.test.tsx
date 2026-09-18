import "../../../../tests/ui/dom";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";

import * as RealDialogModule from "@/browser/components/Dialog/Dialog";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

// Bun's module stubs outlive mock.restore(); do not alter later dialogs in the shared Unit run.
restoreModulesAfterSuite([["@/browser/components/Dialog/Dialog", { ...RealDialogModule }]]);

// Radix Dialog portals do not render in happy-dom; inline the shell (same as the heartbeat modal test).
void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode; className?: string }) => (
    <div className={props.className}>{props.children}</div>
  ),
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

import { WorkspaceUnrelatedMessagingModal } from "./WorkspaceUnrelatedMessagingModal";

let cleanupDom: (() => void) | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WorkspaceUnrelatedMessagingModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the switch mirrors metadata: no optimistic flip before the backend acknowledges", async () => {
    const pending = deferred<Result<void, string>>();
    const onSetEnabled = mock((_enabled: boolean) => pending.promise);
    const view = render(
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        enabled={false}
        onSetEnabled={onSetEnabled}
      />
    );

    const toggle = view.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    expect(onSetEnabled).toHaveBeenCalledTimes(1);
    expect(onSetEnabled.mock.calls[0]?.[0]).toBe(true);
    // Pending: the control is locked and still reports the persisted (off) state.
    await waitFor(() => {
      expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    });
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(view.queryByRole("status")).not.toBeNull();

    pending.resolve(Ok(undefined));
    await waitFor(() => {
      expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
    });
    // Ack alone does not flip the switch; only the republished metadata does.
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(view.queryByRole("status")).toBeNull();

    view.rerender(
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        enabled={true}
        onSetEnabled={onSetEnabled}
      />
    );
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("true");

    // Turning off sends the revocation and again waits for metadata.
    fireEvent.click(view.getByRole("switch"));
    expect(onSetEnabled.mock.calls[1]?.[0]).toBe(false);
    await waitFor(() => {
      expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  test("surfaces a backend refusal and unlocks the control without changing state", async () => {
    const onSetEnabled = mock((_enabled: boolean) =>
      Promise.resolve(Err("Workspace not found") as Result<void, string>)
    );
    const view = render(
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        enabled={false}
        onSetEnabled={onSetEnabled}
      />
    );

    fireEvent.click(view.getByRole("switch"));
    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("Workspace not found");
    expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");

    // A later successful attempt clears the stale error.
    onSetEnabled.mockImplementation(() => Promise.resolve(Ok(undefined) as Result<void, string>));
    fireEvent.click(view.getByRole("switch"));
    await waitFor(() => {
      expect(view.queryByRole("alert")).toBeNull();
    });
  });

  test("clears the prior error while a retry waits for its response", async () => {
    const first = deferred<Result<void, string>>();
    const second = deferred<Result<void, string>>();
    const responses = [first.promise, second.promise];
    const onSetEnabled = mock((_enabled: boolean) => responses.shift()!);
    const view = render(
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        enabled={false}
        onSetEnabled={onSetEnabled}
      />
    );

    fireEvent.click(view.getByRole("switch"));
    // The control is locked while a request is in flight, so a second request can only start
    // once the first settles; resolving the first with an error, then starting the second,
    // must leave the UI reflecting the latest request only.
    first.resolve(Err("first failed"));
    await waitFor(() => view.getByRole("alert"));
    fireEvent.click(view.getByRole("switch"));
    await waitFor(() => {
      expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    });
    // Starting a new request clears the previous error immediately.
    expect(view.queryByRole("alert")).toBeNull();
    second.resolve(Ok(undefined));
    await waitFor(() => {
      expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("renders nothing while closed", () => {
    const view = render(
      <WorkspaceUnrelatedMessagingModal
        open={false}
        onOpenChange={() => undefined}
        enabled={true}
        onSetEnabled={() => Promise.resolve(Ok(undefined))}
      />
    );
    expect(view.queryByRole("switch")).toBeNull();
  });
});
