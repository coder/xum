import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { UpdateStatus } from "@/common/orpc/types";
import { APIContext, type APIClient } from "@/browser/contexts/API";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "../../contexts/ThemeContext";

// SVG ?react imports don't work in happy-dom; stub them as simple svgs.
void mock.module("@/browser/assets/logos/xum-logo-dark.svg?react", () => ({
  __esModule: true,
  default: () => <svg data-testid="xum-logo-mock" />,
}));
void mock.module("@/browser/assets/logos/xum-logo-light.svg?react", () => ({
  __esModule: true,
  default: () => <svg data-testid="xum-logo-mock" />,
}));

/** Push-driven stand-in for the update.onStatus subscription. */
function createStatusStream() {
  const queue: UpdateStatus[] = [];
  let wake: (() => void) | null = null;
  const onStatus = async function* (_input: undefined, options: { signal: AbortSignal }) {
    while (!options.signal.aborted) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
  return {
    // eslint-disable-next-line local/no-unknown-cast-to-api-client -- #4627 (double needs type repair)
    api: { update: { onStatus } } as unknown as APIClient,
    push(status: UpdateStatus) {
      queue.push(status);
      wake?.();
      wake = null;
    },
  };
}

let apiState: { api: APIClient | null; status: "connected" | "reconnecting" } = {
  api: null,
  status: "reconnecting",
};

import type { UpdateRestartOverlay as UpdateRestartOverlayComponent } from "./UpdateRestartOverlay";

// Required after the mocks above so the svg stubs are in place when LoadingScreen evaluates.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const {
  UpdateRestartOverlay,
}: {
  UpdateRestartOverlay: typeof UpdateRestartOverlayComponent;
} = require("./UpdateRestartOverlay");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */

const OVERLAY = "update-restart-overlay";

// Inject `apiState` through the real context instead of mocking the API module (module
// mocks leak across suites). The wrapper reads `apiState` on every render, so rerenders
// switch between connected and reconnecting without remounting the overlay.
function MutableAPIWrapper(props: { children: React.ReactNode }) {
  const authenticate = () => undefined;
  const retry = () => undefined;
  return (
    <APIContext.Provider
      value={
        apiState.status === "connected" && apiState.api
          ? { status: "connected", api: apiState.api, error: null, authenticate, retry }
          : { status: "reconnecting", api: null, error: null, attempt: 1, authenticate, retry }
      }
    >
      {props.children}
    </APIContext.Provider>
  );
}

function renderOverlay() {
  return render(
    <ThemeProvider>
      <UpdateRestartOverlay />
    </ThemeProvider>,
    { wrapper: MutableAPIWrapper }
  );
}

async function flushStream() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let cleanupDom: (() => void) | null = null;

describe("UpdateRestartOverlay", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    apiState = { api: null, status: "reconnecting" };
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("covers the app from the restarting status until a relaunched server reports otherwise", async () => {
    const before = createStatusStream();
    apiState = { api: before.api, status: "connected" };
    const view = renderOverlay();

    before.push({ type: "downloaded", info: { version: "0.29.0" } });
    await flushStream();
    expect(view.queryByTestId(OVERLAY)).toBeNull();

    before.push({ type: "restarting", info: { version: "0.29.0" } });
    await waitFor(() => expect(view.getByTestId(OVERLAY)).toBeTruthy());

    // The server goes away while it restarts: the client has no api during reconnects.
    apiState = { api: null, status: "reconnecting" };
    view.rerender(
      <ThemeProvider>
        <UpdateRestartOverlay />
      </ThemeProvider>
    );
    await flushStream();
    expect(view.getByTestId(OVERLAY)).toBeTruthy();

    // The relaunched server's first status clears the cover.
    const after = createStatusStream();
    apiState = { api: after.api, status: "connected" };
    view.rerender(
      <ThemeProvider>
        <UpdateRestartOverlay />
      </ThemeProvider>
    );
    await flushStream();
    expect(view.getByTestId(OVERLAY)).toBeTruthy();
    after.push({ type: "idle" });
    await waitFor(() => expect(view.queryByTestId(OVERLAY)).toBeNull());
  });

  test("hides again when the install fails after restarting was announced", async () => {
    const stream = createStatusStream();
    apiState = { api: stream.api, status: "connected" };
    const view = renderOverlay();

    stream.push({ type: "restarting", info: { version: "0.29.0" } });
    await waitFor(() => expect(view.getByTestId(OVERLAY)).toBeTruthy());

    stream.push({ type: "error", phase: "install", message: "activation failed" });
    await waitFor(() => expect(view.queryByTestId(OVERLAY)).toBeNull());
  });
});
