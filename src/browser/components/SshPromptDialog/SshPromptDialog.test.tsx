import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SshPromptEvent, SshPromptRequest } from "@/common/orpc/schemas/ssh";
import {
  createControllableAsyncIterable,
  type ControllableAsyncIterable,
} from "@/browser/testUtils";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";
import { APIContext, type APIClient } from "@/browser/contexts/API";

restoreModulesAfterSuite([["@/browser/components/Dialog/Dialog", { ...RealDialogModule }]]);

// Self-contained dialog stub — bun's mock.module is process-global, so other
// test files may register incomplete Dialog stubs that omit
// DialogDescription/DialogFooter/Warning*. Our own complete mock prevents
// Radix context errors when tests run in the same bun process.
void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  DialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningBox: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningTitle: (props: { children: ReactNode }) => <div>{props.children}</div>,
  WarningText: (props: { children: ReactNode }) => <div>{props.children}</div>,
}));

import { SshPromptDialog } from "../SshPromptDialog/SshPromptDialog";

interface ControlledSubscription<T> extends ControllableAsyncIterable<T> {
  returnSpy: ReturnType<typeof mock>;
}

function createMockIterableSubscription<T>(): ControlledSubscription<T> {
  const returnSpy = mock(() => undefined);
  return {
    ...createControllableAsyncIterable<T>({ onReturn: returnSpy }),
    returnSpy,
  };
}

interface SshPromptApi {
  ssh: {
    prompt: {
      subscribe: (
        _input?: undefined,
        _options?: { signal?: AbortSignal }
      ) => Promise<AsyncIterable<SshPromptEvent>>;
      respond: (input: { requestId: string; response: string }) => Promise<void>;
    };
  };
}

let cleanupDom: (() => void) | null = null;
let api: SshPromptApi | null = null;
let respondMock: ReturnType<typeof mock>;
let subscribeMock: ReturnType<typeof mock>;
let mockSubscription: ControlledSubscription<SshPromptEvent>;

// Inject the current `api` through the real context instead of mocking the API module
// (module mocks leak across suites). The wrapper reads `api` on every render, so a test
// that sets it to null and rerenders sees a disconnected backend without remounting.
function MutableAPIWrapper(props: { children: ReactNode }) {
  const authenticate = () => undefined;
  const retry = () => undefined;
  return (
    <APIContext.Provider
      value={
        api
          ? {
              status: "connected",
              // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (double needs type repair)
              api: api as unknown as APIClient,
              error: null,
              authenticate,
              retry,
            }
          : { status: "reconnecting", api: null, error: null, attempt: 1, authenticate, retry }
      }
    >
      {props.children}
    </APIContext.Provider>
  );
}

function renderDialog() {
  return render(<SshPromptDialog />, { wrapper: MutableAPIWrapper });
}

const MOCK_REQUEST: SshPromptRequest = {
  requestId: "req-1",
  kind: "host-key",
  host: "example.com",
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:abcdef",
  prompt: "Trust host key?",
};

const MOCK_CREDENTIAL_REQUEST: SshPromptRequest = {
  requestId: "cred-1",
  kind: "credential",
  prompt: "Enter passphrase for key '/home/user/.ssh/id_ed25519':",
  secret: true,
};

async function flushReactWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function enqueueRequest(request: SshPromptRequest): Promise<void> {
  await act(async () => {
    mockSubscription.push({ type: "request", ...request });
    await flushReactWork();
  });
}

describe("SshPromptDialog", () => {
  beforeEach(() => {
    cleanup();
    cleanupDom = installDom();

    mockSubscription = createMockIterableSubscription<SshPromptEvent>();
    respondMock = mock(() => Promise.resolve());
    subscribeMock = mock(() => Promise.resolve(mockSubscription.iterable));

    api = {
      ssh: {
        prompt: {
          subscribe: subscribeMock,
          respond: respondMock,
        },
      },
    };
  });

  afterEach(() => {
    mockSubscription.close();
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    api = null;
  });

  it("dequeues request on successful respond", async () => {
    const { getByRole, queryByRole } = renderDialog();

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reject" }));
      await flushReactWork();
    });

    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({ requestId: "req-1", response: "no" });
    });
    expect(respondMock).toHaveBeenCalledTimes(1);

    // Successful respond dequeues → dialog closes → no Reject button
    expect(queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("renders credential prompt with input field", async () => {
    const { container, getByRole, getByText } = renderDialog();

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_CREDENTIAL_REQUEST);

    expect(getByText("Enter passphrase for key '/home/user/.ssh/id_ed25519':")).not.toBeNull();

    const credentialInput = container.querySelector("input[type='password']");
    expect(credentialInput).not.toBeNull();

    expect(getByRole("button", { name: "Submit" })).not.toBeNull();
    expect(getByRole("button", { name: "Cancel" })).not.toBeNull();
  });

  it("credential submit sends typed response", async () => {
    const { container, getByRole, queryByRole } = renderDialog();

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_CREDENTIAL_REQUEST);

    const credentialInput = container.querySelector<HTMLInputElement>("input[type='password']");
    expect(credentialInput).not.toBeNull();
    if (!credentialInput) {
      throw new Error("Expected credential input to be present");
    }

    const reactPropsKey = Object.keys(credentialInput).find((key) =>
      key.startsWith("__reactProps")
    );
    expect(reactPropsKey).not.toBeUndefined();
    if (!reactPropsKey) {
      throw new Error("Expected credential input to expose React props");
    }

    const reactPropsRecord = credentialInput as unknown as Record<string, unknown>;
    const reactProps = reactPropsRecord[reactPropsKey];
    if (!reactProps || typeof reactProps !== "object") {
      throw new Error("Expected credential input to expose React prop object");
    }

    const onChange = (reactProps as { onChange?: (event: { target: { value: string } }) => void })
      .onChange;
    expect(onChange).toBeDefined();
    if (!onChange) {
      throw new Error("Expected credential input to expose onChange handler");
    }

    await act(async () => {
      // fireEvent.change alone does not always update controlled input state in happy-dom.
      fireEvent.change(credentialInput, { target: { value: "my-passphrase" } });
      onChange({ target: { value: "my-passphrase" } });
      await flushReactWork();
    });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Submit" }));
      await flushReactWork();
    });

    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({
        requestId: "cred-1",
        response: "my-passphrase",
      });
    });

    // Successful credential submit dequeues the request and closes the dialog.
    expect(queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("credential cancel sends empty response", async () => {
    const { getByRole } = renderDialog();

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_CREDENTIAL_REQUEST);

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Cancel" }));
      await flushReactWork();
    });

    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith({ requestId: "cred-1", response: "" });
    });
  });

  it("keeps request visible when respond fails", async () => {
    respondMock = mock(() => Promise.reject(new Error("RPC transport error")));
    subscribeMock = mock(() => Promise.resolve(mockSubscription.iterable));
    api = {
      ssh: {
        prompt: {
          subscribe: subscribeMock,
          respond: respondMock,
        },
      },
    };

    const { getByRole, queryByRole } = renderDialog();

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    // Regression guard: failed responses must leave the same prompt active so retry works.
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reject" }));
      await flushReactWork();
    });
    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(1));

    // Button still visible — user can retry
    expect(queryByRole("button", { name: "Reject" })).not.toBeNull();

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Reject" }));
      await flushReactWork();
    });
    await waitFor(() => expect(respondMock).toHaveBeenCalledTimes(2));

    expect(respondMock).toHaveBeenNthCalledWith(1, { requestId: "req-1", response: "no" });
    expect(respondMock).toHaveBeenNthCalledWith(2, { requestId: "req-1", response: "no" });
  });

  it("closes late iterator when cleanup runs before subscribe resolves", async () => {
    let resolveSubscribe: ((iterable: AsyncIterable<SshPromptEvent>) => void) | null = null;
    subscribeMock = mock(
      () =>
        new Promise<AsyncIterable<SshPromptEvent>>((resolve) => {
          resolveSubscribe = resolve;
        })
    );
    api = {
      ssh: {
        prompt: {
          subscribe: subscribeMock,
          respond: respondMock,
        },
      },
    };

    const { unmount } = renderDialog();
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));

    // Cleanup fires while subscribe() is still pending — iteratorRef is undefined.
    unmount();

    // Now resolve the subscribe promise. The abort guard should close the iterator.
    await act(async () => {
      resolveSubscribe?.(mockSubscription.iterable);
      await flushReactWork();
    });

    // The abort guard should have called return() on the late iterator.
    await waitFor(() => expect(mockSubscription.returnSpy).toHaveBeenCalledTimes(1));
  });

  it("does not double-close iterator on normal cleanup", async () => {
    const { unmount } = renderDialog();
    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    unmount();

    // Give async tasks time to settle.
    await act(async () => {
      await flushReactWork();
    });

    // Normal cleanup path: return() called exactly once.
    expect(mockSubscription.returnSpy).toHaveBeenCalledTimes(1);
  });

  it("clears pending queue when api becomes null", async () => {
    const { queryByRole, rerender } = renderDialog();

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    await enqueueRequest(MOCK_REQUEST);

    // Dialog should be visible
    expect(queryByRole("button", { name: "Reject" })).not.toBeNull();

    // Simulate disconnect — api becomes null
    api = null;
    await act(async () => {
      rerender(<SshPromptDialog />);
      await flushReactWork();
    });

    // Queue cleared → dialog dismissed
    expect(queryByRole("button", { name: "Reject" })).toBeNull();
  });
});
