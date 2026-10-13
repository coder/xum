// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { Secret } from "@/common/types/secrets";
import { SecretsSection, useGlobalSecretKeys } from "./SecretsSection";

let harness: ConnectionHarness;
/** The global secrets the next server returns, or a promise of them. */
let serverSecrets: Secret[] | Promise<Secret[]>;

function serverOverrides(): TestApiOverrides<APIClient> {
  const secrets = serverSecrets;
  return {
    projects: { list: () => Promise.resolve([]) },
    secrets: { get: () => Promise.resolve(secrets) },
  };
}

// happy-dom does not deliver React's synthetic onChange for controlled fields, so call the
// field's React onChange prop directly (same workaround as InstructionsSection.test.tsx).
function typeInto(field: HTMLElement, value: string) {
  const reactPropsKey = Object.keys(field).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (field as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as { onChange?: (event: { target: { value: string } }) => void } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the field to expose its onChange handler");
  act(() => onChange({ target: { value } }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderSecrets() {
  return render(
    <harness.Wrapper>
      <RouterProvider>
        <ProjectProvider>
          <SettingsProvider>
            <SecretsSection />
          </SettingsProvider>
        </ProjectProvider>
      </RouterProvider>
    </harness.Wrapper>
  );
}

// A reconnect reloads the secrets through the new client. The rows stay on screen (no "Loading
// secrets…" in their place), and rows the user edited are not replaced by the reload.
describe.each([...GAP_MODES])("SecretsSection across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverSecrets = [{ key: "OLD_KEY", value: "old" }];
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the shown rows until the reload answers", async () => {
    const view = renderSecrets();
    await waitFor(() => expect(view.queryByDisplayValue("OLD_KEY")).not.toBeNull());

    let answer: ((secrets: Secret[]) => void) | null = null;
    serverSecrets = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    await settle();
    expect(view.queryByDisplayValue("OLD_KEY")).not.toBeNull();
    harness.reconnect();
    await settle();
    expect(view.queryByDisplayValue("OLD_KEY")).not.toBeNull();
    expect(view.queryByText("Loading secrets…")).toBeNull();

    act(() => answer?.([{ key: "NEW_KEY", value: "new" }]));
    await waitFor(() => expect(view.queryByDisplayValue("NEW_KEY")).not.toBeNull());
  });

  test("keeps a row the user edited when the reload answers", async () => {
    const view = renderSecrets();
    const keyField = await waitFor(() => view.getByDisplayValue("OLD_KEY"));
    typeInto(keyField, "EDITED_KEY");
    await waitFor(() => expect(view.queryByDisplayValue("EDITED_KEY")).not.toBeNull());

    serverSecrets = [{ key: "SERVER_KEY", value: "server" }];
    await harness.drop();
    harness.reconnect();
    await settle();

    expect(view.queryByDisplayValue("EDITED_KEY")).not.toBeNull();
    expect(view.queryByDisplayValue("SERVER_KEY")).toBeNull();
  });

  // Offline the edited rows stay, but a Save could not reach the server: it must be disabled.
  test("disables Save for an edited row while offline", async () => {
    const view = renderSecrets();
    const keyField = await waitFor(() => view.getByDisplayValue("OLD_KEY"));
    typeInto(keyField, "EDITED_KEY");
    const save = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));

    await harness.drop();
    await settle();
    expect(view.queryByDisplayValue("EDITED_KEY")).not.toBeNull();
    expect(save.disabled).toBe(true);

    harness.reconnect();
    await waitFor(() => expect(save.disabled).toBe(false));
  });
});

// The Secrets and MCP sections offer the global secret keys as {secret:"KEY"} references.
describe.each([...GAP_MODES])("useGlobalSecretKeys across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverSecrets = [{ key: "OLD_KEY", value: "old" }];
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the keys while offline and until the reload answers", async () => {
    const view = renderHook(() => useGlobalSecretKeys(useAPI().api)[0], {
      wrapper: harness.Wrapper,
    });
    await waitFor(() => expect(view.result.current).toEqual(["OLD_KEY"]));

    let answer: ((secrets: Secret[]) => void) | null = null;
    serverSecrets = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    await settle();
    expect(view.result.current).toEqual(["OLD_KEY"]);
    harness.reconnect();
    await settle();
    expect(view.result.current).toEqual(["OLD_KEY"]);

    act(() => answer?.([{ key: "NEW_KEY", value: "new" }]));
    await waitFor(() => expect(view.result.current).toEqual(["NEW_KEY"]));
  });
});
