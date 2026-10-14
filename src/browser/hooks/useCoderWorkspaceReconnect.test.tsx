// Bootstrap Happy DOM before react-dom evaluates.
import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { CoderPreset, CoderTemplate, CoderWorkspace } from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";
import { useCoderWorkspace } from "./useCoderWorkspace";

const template = (name: string): CoderTemplate => ({
  name,
  displayName: name,
  organizationName: "org",
});
const preset = (name: string): CoderPreset => ({ id: name, name, isDefault: false });
const workspace = (name: string): CoderWorkspace => ({
  name,
  templateName: "t1",
  templateDisplayName: "t1",
  status: "running",
});

interface ServerLists {
  templates: CoderTemplate[];
  presets: CoderPreset[];
  workspaces: CoderWorkspace[];
}

let harness: ConnectionHarness;
/** What the next server lists, or a promise that answers later. */
let serverLists: ServerLists | Promise<ServerLists>;

function serverOverrides(): TestApiOverrides<APIClient> {
  const lists = Promise.resolve(serverLists);
  return {
    coder: {
      getInfo: () => Promise.resolve({ state: "available" as const, version: "2.0.0" }),
      listTemplates: () => lists.then((l) => ({ ok: true as const, templates: l.templates })),
      listPresets: () => lists.then((l) => ({ ok: true as const, presets: l.presets })),
      listWorkspaces: () => lists.then((l) => ({ ok: true as const, workspaces: l.workspaces })),
    },
  };
}

function renderCoder(config: CoderWorkspaceConfig, onChange = mock(() => undefined)) {
  const view = renderHook(
    (props: { config: CoderWorkspaceConfig }) =>
      useCoderWorkspace({
        coderConfig: props.config,
        onCoderConfigChange: onChange,
        coderInfoRefreshPolicy: "mount-and-focus",
      }),
    { wrapper: harness.Wrapper, initialProps: { config } }
  );
  return { view, onChange };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const CONFIG: CoderWorkspaceConfig = {
  existingWorkspace: false,
  template: "t1",
  templateOrg: "org",
};

// A reconnect reloads the Coder lists through the new client: the pickers keep what they show
// (no spinner) until the reload answers, and a lost connection never clears the Coder config.
describe.each([...GAP_MODES])("useCoderWorkspace across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverLists = {
      templates: [template("t1")],
      presets: [preset("p1"), preset("p2")],
      workspaces: [workspace("w1")],
    };
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the shown lists until the reload answers", async () => {
    const { view } = renderCoder(CONFIG);
    await waitFor(() =>
      expect(view.result.current.presets.map((p) => p.name)).toEqual(["p1", "p2"])
    );
    expect(view.result.current.templates.map((t) => t.name)).toEqual(["t1"]);
    expect(view.result.current.existingWorkspaces.map((w) => w.name)).toEqual(["w1"]);

    let answer: ((lists: ServerLists) => void) | null = null;
    serverLists = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    harness.reconnect();
    await settle();

    const shown = view.result.current;
    expect(shown.loadingTemplates || shown.loadingWorkspaces).toBe(false);
    // ChatInput blocks a Coder send on loadingPresets: the reload must hold it.
    expect(shown.loadingPresets).toBe(true);
    expect(shown.templates.map((t) => t.name)).toEqual(["t1"]);
    expect(shown.presets.map((p) => p.name)).toEqual(["p1", "p2"]);
    expect(shown.existingWorkspaces.map((w) => w.name)).toEqual(["w1"]);

    act(() =>
      answer?.({
        templates: [template("t1"), template("t2")],
        presets: [preset("p1"), preset("p2"), preset("p3")],
        workspaces: [workspace("w2")],
      })
    );
    await waitFor(() =>
      expect(view.result.current.existingWorkspaces.map((w) => w.name)).toEqual(["w2"])
    );
    expect(view.result.current.templates.map((t) => t.name)).toEqual(["t1", "t2"]);
    expect(view.result.current.presets.map((p) => p.name)).toEqual(["p1", "p2", "p3"]);
    expect(view.result.current.loadingPresets).toBe(false);
  });

  test("another template shows loading presets", async () => {
    const { view } = renderCoder(CONFIG);
    await waitFor(() => expect(view.result.current.presets.length).toBe(2));

    serverLists = new Promise(() => undefined);
    await harness.drop();
    harness.reconnect();
    view.rerender({ config: { ...CONFIG, template: "t2" } });
    await settle();
    expect(view.result.current.loadingPresets).toBe(true);
  });

  // Offline no reload can replace them: the old template's presets must not stay selectable.
  test("another template while offline clears the shown presets", async () => {
    const { view } = renderCoder(CONFIG);
    await waitFor(() => expect(view.result.current.presets.length).toBe(2));

    await harness.drop();
    view.rerender({ config: { ...CONFIG, template: "t2" } });
    await settle();
    expect(view.result.current.presets).toEqual([]);
    expect(view.result.current.loadingPresets).toBe(false);
  });

  // The selected preset can be removed on the server while offline: the reload must replace it.
  test("a reload that no longer lists the selected preset selects a listed one", async () => {
    const lists = (presets: CoderPreset[]): ServerLists => ({
      templates: [template("t1")],
      presets,
      workspaces: [workspace("w1")],
    });
    serverLists = lists([preset("gone"), preset("p1")]);
    harness = createConnectionHarness(mode, serverOverrides);
    const { view, onChange } = renderCoder({ ...CONFIG, preset: "gone" });
    await waitFor(() => expect(view.result.current.presets.length).toBe(2));
    expect(onChange).not.toHaveBeenCalled();

    serverLists = lists([preset("p1"), preset("p2")]);
    await harness.drop();
    harness.reconnect();
    await waitFor(() =>
      expect((onChange.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toEqual({
        ...CONFIG,
        preset: "p1",
      })
    );
  });

  test("a window focus while offline keeps the Coder info and config", async () => {
    const { view, onChange } = renderCoder(CONFIG);
    await waitFor(() => expect(view.result.current.coderInfo?.state).toBe("available"));

    await harness.drop();
    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await settle();

    expect(view.result.current.coderInfo?.state).toBe("available");
    expect(onChange.mock.calls.some((call: unknown[]) => call[0] === null)).toBe(false);
  });
});
