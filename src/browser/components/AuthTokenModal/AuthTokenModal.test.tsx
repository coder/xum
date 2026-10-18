import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installDom } from "../../../../tests/ui/dom";
import { AuthTokenModal } from "./AuthTokenModal";

/**
 * #6878: a submission connects only after the service worker cache cleanup (#6848). Each cleanup
 * starts with one `caches.keys()` call; this fake hands out promises that the test settles in
 * any order.
 */
function installControlledCaches() {
  const pending: Array<(names: string[]) => void> = [];
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      keys: () => new Promise<string[]>((resolve) => pending.push(resolve)),
      open: () => Promise.reject(new Error("not used")),
      delete: () => Promise.resolve(true),
    },
  });
  return pending;
}

let cleanupDom: (() => void) | null = null;
let originalFetch: typeof fetch;

describe("AuthTokenModal token submission", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    originalFetch = globalThis.fetch;
    // The GitHub login options request: answer "not enabled".
    globalThis.fetch = ((_input: RequestInfo | URL) =>
      Promise.resolve(new Response("", { status: 404 }))) as typeof globalThis.fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "caches");
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a stale submission whose cleanup settles last never connects (#6878)", async () => {
    const cleanups = installControlledCaches();
    const submitted: string[] = [];
    const view = render(<AuthTokenModal isOpen onSubmit={(token) => submitted.push(token)} />);
    const input = view.getByPlaceholderText("Enter auth token");
    const user = userEvent.setup({ document: input.ownerDocument });
    const submit = async (token: string) => {
      await user.clear(input);
      await user.type(input, `${token}{Enter}`);
    };

    await submit("token-a");
    await submit("token-b");
    expect(cleanups).toHaveLength(2);

    // The newer cleanup ends first, then the older one.
    await act(async () => {
      cleanups[1]([]);
      await Promise.resolve();
    });
    // token-b also waits for token-a's cleanup, which is still running.
    expect(submitted).toEqual([]);
    await act(async () => {
      cleanups[0]([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(submitted).toEqual(["token-b"]);
  });

  test("a repeated token waits for the cleanup the first submit started (#6878)", async () => {
    const cleanups = installControlledCaches();
    const submitted: string[] = [];
    const view = render(<AuthTokenModal isOpen onSubmit={(token) => submitted.push(token)} />);
    const input = view.getByPlaceholderText("Enter auth token");
    const user = userEvent.setup({ document: input.ownerDocument });

    await user.type(input, "token-a{Enter}");
    // The token is already stored, so this submit starts no cleanup of its own.
    await user.type(input, "{Enter}");
    expect(cleanups).toHaveLength(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(submitted).toEqual([]);

    await act(async () => {
      cleanups[0]([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(submitted).toEqual(["token-a"]);
  });
});
