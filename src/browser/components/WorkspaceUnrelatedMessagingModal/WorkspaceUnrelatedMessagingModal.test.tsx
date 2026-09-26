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
  DialogDescription: (props: { children: ReactNode; className?: string }) => (
    <p className={props.className}>{props.children}</p>
  ),
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

import { WorkspaceUnrelatedMessagingModal } from "./WorkspaceUnrelatedMessagingModal";

let cleanupDom: (() => void) | null = null;

const CONSENT_NAME = /allow messages from unrelated workspaces/i;
const HOLD_NAME = /hold agent messages/i;

function consentSwitch(view: ReturnType<typeof render>): HTMLElement {
  return view.getByRole("switch", { name: CONSENT_NAME });
}

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
        consentSupported={true}
        enabled={false}
        onSetEnabled={onSetEnabled}
        holdUntilTurnEnd={false}
        onSetHoldUntilTurnEnd={() => Promise.resolve(Ok(undefined))}
      />
    );

    const toggle = consentSwitch(view);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    expect(onSetEnabled).toHaveBeenCalledTimes(1);
    expect(onSetEnabled.mock.calls[0]?.[0]).toBe(true);
    // Pending: the control is locked and still reports the persisted (off) state.
    await waitFor(() => {
      expect((consentSwitch(view) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(consentSwitch(view).getAttribute("aria-checked")).toBe("false");
    expect(view.queryByRole("status")).not.toBeNull();

    pending.resolve(Ok(undefined));
    await waitFor(() => {
      expect((consentSwitch(view) as HTMLButtonElement).disabled).toBe(false);
    });
    // Ack alone does not flip the switch; only the republished metadata does.
    expect(consentSwitch(view).getAttribute("aria-checked")).toBe("false");
    expect(view.queryByRole("status")).toBeNull();

    view.rerender(
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        consentSupported={true}
        enabled={true}
        onSetEnabled={onSetEnabled}
        holdUntilTurnEnd={false}
        onSetHoldUntilTurnEnd={() => Promise.resolve(Ok(undefined))}
      />
    );
    expect(consentSwitch(view).getAttribute("aria-checked")).toBe("true");

    // Turning off sends the revocation and again waits for metadata.
    fireEvent.click(consentSwitch(view));
    expect(onSetEnabled.mock.calls[1]?.[0]).toBe(false);
    await waitFor(() => {
      expect((consentSwitch(view) as HTMLButtonElement).disabled).toBe(false);
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
        consentSupported={true}
        enabled={false}
        onSetEnabled={onSetEnabled}
        holdUntilTurnEnd={false}
        onSetHoldUntilTurnEnd={() => Promise.resolve(Ok(undefined))}
      />
    );

    fireEvent.click(consentSwitch(view));
    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("Workspace not found");
    expect((consentSwitch(view) as HTMLButtonElement).disabled).toBe(false);
    expect(consentSwitch(view).getAttribute("aria-checked")).toBe("false");

    // A later successful attempt clears the stale error.
    onSetEnabled.mockImplementation(() => Promise.resolve(Ok(undefined) as Result<void, string>));
    fireEvent.click(consentSwitch(view));
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
        consentSupported={true}
        enabled={false}
        onSetEnabled={onSetEnabled}
        holdUntilTurnEnd={false}
        onSetHoldUntilTurnEnd={() => Promise.resolve(Ok(undefined))}
      />
    );

    fireEvent.click(consentSwitch(view));
    // The control is locked while a request is in flight, so a second request can only start
    // once the first settles; resolving the first with an error, then starting the second,
    // must leave the UI reflecting the latest request only.
    first.resolve(Err("first failed"));
    await waitFor(() => view.getByRole("alert"));
    fireEvent.click(consentSwitch(view));
    await waitFor(() => {
      expect((consentSwitch(view) as HTMLButtonElement).disabled).toBe(true);
    });
    // Starting a new request clears the previous error immediately.
    expect(view.queryByRole("alert")).toBeNull();
    second.resolve(Ok(undefined));
    await waitFor(() => {
      expect((consentSwitch(view) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("renders nothing while closed", () => {
    const view = render(
      <WorkspaceUnrelatedMessagingModal
        open={false}
        onOpenChange={() => undefined}
        consentSupported={true}
        enabled={true}
        onSetEnabled={() => Promise.resolve(Ok(undefined))}
        holdUntilTurnEnd={false}
        onSetHoldUntilTurnEnd={() => Promise.resolve(Ok(undefined))}
      />
    );
    expect(view.queryByRole("switch", { name: CONSENT_NAME })).toBeNull();
  });

  test("the hold switch sends the new preference and mirrors metadata only", async () => {
    const onSetHoldUntilTurnEnd = mock((_hold: boolean) =>
      Promise.resolve(Ok(undefined) as Result<void, string>)
    );
    const renderModal = (hold: boolean) => (
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        consentSupported={true}
        // Consent off must not block the delivery preference: it also covers same-tree senders.
        enabled={false}
        onSetEnabled={() => Promise.resolve(Ok(undefined))}
        holdUntilTurnEnd={hold}
        onSetHoldUntilTurnEnd={onSetHoldUntilTurnEnd}
      />
    );
    const view = render(renderModal(false));
    const hold = () => view.getByRole("switch", { name: HOLD_NAME });

    fireEvent.click(hold());
    expect(onSetHoldUntilTurnEnd.mock.calls[0]?.[0]).toBe(true);
    await waitFor(() => {
      expect((hold() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(hold().getAttribute("aria-checked")).toBe("false");

    view.rerender(renderModal(true));
    expect(hold().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(hold());
    expect(onSetHoldUntilTurnEnd.mock.calls[1]?.[0]).toBe(false);
    await waitFor(() => {
      expect((hold() as HTMLButtonElement).disabled).toBe(false);
    });
  });

  test("remote runtimes get only the hold switch, since consent could never be honoured there", () => {
    const view = render(
      <WorkspaceUnrelatedMessagingModal
        open={true}
        onOpenChange={() => undefined}
        consentSupported={false}
        enabled={false}
        onSetEnabled={() => Promise.resolve(Ok(undefined))}
        holdUntilTurnEnd={false}
        onSetHoldUntilTurnEnd={() => Promise.resolve(Ok(undefined))}
      />
    );
    expect(view.queryByRole("switch", { name: CONSENT_NAME })).toBeNull();
    expect(view.getByRole("switch", { name: HOLD_NAME })).not.toBeNull();
  });
});
