// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { installDom } from "../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import { AboutDialogProvider, useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { UpdateStatus } from "@/common/orpc/types";
import { AboutDialog } from "./AboutDialog";

let status: UpdateStatus;

function serverOverrides(): TestApiOverrides<APIClient> {
  const current = status;
  return {
    update: {
      // Sends the current status, then stays open until the consumer aborts.
      onStatus: (_input: unknown, options?: { signal?: AbortSignal }) =>
        Promise.resolve(
          (async function* (): AsyncGenerator<UpdateStatus, void, unknown> {
            yield current;
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true })
            );
          })()
        ),
      getChannel: () =>
        Promise.resolve({ channel: "stable", supportedChannels: ["stable", "nightly"] }),
    },
  };
}

function OpenAbout() {
  const about = useAboutDialog();
  useEffect(() => about.open(), [about]);
  return <AboutDialog />;
}

/** Disabled directly, or through a disabled fieldset (happy-dom does not apply the latter). */
function isDisabled(control: HTMLElement): boolean {
  return (control as HTMLButtonElement).disabled || control.closest("fieldset")?.disabled === true;
}

/**
 * The names of the enabled update actions on screen (none while the dialog shows "Connecting…").
 * Names, not elements: a failed match on happy-dom elements prints their whole object graph.
 */
function enabledActions(names: readonly string[]): string[] {
  return actionButtons(names)
    .filter((control) => !isDisabled(control))
    .map((control) => control.textContent ?? "");
}

function actionButtons(names: readonly string[]): HTMLElement[] {
  const dialog = within(document.body.querySelector<HTMLElement>("[role=dialog]")!);
  return names.flatMap((name) => [
    ...dialog.queryAllByRole("radio", { name }),
    ...dialog.queryAllByRole("button", { name }),
  ]);
}

// Offline an update call cannot reach the server: a click would do nothing. The actions are
// disabled while the shown update state stays, and they return after the reconnect.
describe.each([...GAP_MODES])("AboutDialog while offline (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;
  let harness: ConnectionHarness;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const cases = [
    {
      status: { type: "available", info: { version: "9.9.9" } },
      actions: ["Stable", "Nightly", "Check for Updates", "Download"],
    },
    {
      status: { type: "install-blocked", info: { version: "9.9.9" }, blockers: [] },
      actions: ["Install & restart", "Restart anyway"],
    },
  ] as const satisfies ReadonlyArray<{ status: UpdateStatus; actions: readonly string[] }>;

  test.each(cases.map((testCase) => [testCase.status.type, testCase] as const))(
    "disables the %s actions while offline",
    async (_type, testCase) => {
      status = testCase.status;
      harness = createConnectionHarness(mode, serverOverrides);
      render(
        <harness.Wrapper>
          <ThemeProvider forcedTheme="dark">
            <AboutDialogProvider>
              <OpenAbout />
            </AboutDialogProvider>
          </ThemeProvider>
        </harness.Wrapper>
      );
      await waitFor(() =>
        expect(enabledActions(testCase.actions)).toHaveLength(testCase.actions.length)
      );

      await harness.drop();
      expect(enabledActions(testCase.actions)).toEqual([]);
      if (mode === "kept-gap") {
        expect(document.body.textContent).toContain("9.9.9");
      }

      harness.reconnect();
      await waitFor(() =>
        expect(enabledActions(testCase.actions)).toHaveLength(testCase.actions.length)
      );
    }
  );
});
