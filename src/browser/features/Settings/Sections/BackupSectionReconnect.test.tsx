// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { TestApiOverrides } from "@/browser/testUtils";
import { BackupSection } from "./BackupSection";

interface BackupSettings {
  repoUrl: string;
  branch: string;
  path: string;
}

let harness: ConnectionHarness;
/** The settings the next server returns, or a promise of them. */
let serverSettings: BackupSettings | Promise<BackupSettings>;

function serverOverrides(): TestApiOverrides<APIClient> {
  const settings = serverSettings;
  return {
    backup: { getSettings: () => Promise.resolve(settings) },
    config: {
      // A live config stream that sends nothing.
      onConfigChanged: () =>
        Promise.resolve(
          (async function* () {
            await new Promise(() => undefined);
            yield undefined;
          })()
        ),
    },
  };
}

// A reconnect reloads the backup settings through the new client. The form stays on screen
// ("Loading backup settings..." replaces it only before the first load).
describe.each([...GAP_MODES])("BackupSection across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverSettings = { repoUrl: "git@example.com:old.git", branch: "main", path: "mux/" };
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the form until the reload answers", async () => {
    const view = render(
      <harness.Wrapper>
        <ThemeProvider forcedTheme="dark">
          <TooltipProvider>
            <BackupSection />
          </TooltipProvider>
        </ThemeProvider>
      </harness.Wrapper>
    );
    await waitFor(() => expect(view.queryByDisplayValue("git@example.com:old.git")).not.toBeNull());

    let answer: ((settings: BackupSettings) => void) | null = null;
    serverSettings = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.queryByText("Loading backup settings...")).toBeNull();
    expect(view.queryByDisplayValue("git@example.com:old.git")).not.toBeNull();

    act(() => answer?.({ repoUrl: "git@example.com:new.git", branch: "main", path: "mux/" }));
    await waitFor(() => expect(view.queryByDisplayValue("git@example.com:new.git")).not.toBeNull());
  });
});
