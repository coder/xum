import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as SelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import {
  createControllableAsyncIterable,
  createTestApiClient,
  type TestApiOverrides,
} from "@/browser/testUtils";
import { patchAgentSandbox, type AgentSandboxPatch } from "@/common/config/schemas/agentSandbox";
import type { AgentSandboxState } from "@/common/orpc/schemas/agentSandbox";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import { AgentSandboxSettings } from "./AgentSandboxSettings";

// Radix Select renders its options in a portal, which happy-dom does not show: use a native select.
restoreModulesAfterSuite([
  ["@/browser/components/SelectPrimitive/SelectPrimitive", { ...SelectPrimitiveModule }],
]);
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => ({
  Select: (props: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Project picker"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onValueChange(event.currentTarget.value)}
    >
      {props.children}
    </select>
  ),
  SelectContent: (props: { children: React.ReactNode }) => <>{props.children}</>,
  SelectItem: (props: { value: string; children: React.ReactNode }) => (
    <option value={props.value}>{props.children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const PHAROS = "/home/user/src/pharos";

/** The server's saved setting and the saves it receives; it applies each save as the backend does. */
function createServer(initial: AgentSandboxState) {
  let saved = initial;
  const set = mock((patch: AgentSandboxPatch) => {
    saved = { ...saved, global: patchAgentSandbox(saved.global, patch) ?? {} };
    return Promise.resolve(saved);
  });
  const setProject = mock(
    ({ projectPath, sandbox }: { projectPath: string; sandbox: AgentSandboxPatch }) => {
      const projects = { ...saved.projects };
      const next = patchAgentSandbox(projects[projectPath], sandbox);
      if (next === undefined) delete projects[projectPath];
      else projects[projectPath] = next;
      saved = { ...saved, projects };
      return Promise.resolve(saved);
    }
  );
  const overrides = (): TestApiOverrides<APIClient> => ({
    agentSandbox: { get: () => Promise.resolve(saved), set, setProject },
    config: {
      onConfigChanged: () => Promise.resolve(createControllableAsyncIterable<undefined>().iterable),
    },
  });
  return { set, setProject, overrides };
}

function renderSettings(initial: AgentSandboxState) {
  const server = createServer(initial);
  const view = render(
    <APIProvider client={createTestApiClient(server.overrides())}>
      <AgentSandboxSettings />
    </APIProvider>
  );
  const toggle = () =>
    view.getByRole("switch", { name: "Run agent commands in a sandbox" }) as HTMLButtonElement;
  return { ...view, ...server, toggle };
}

// happy-dom does not deliver React's synthetic onChange for controlled fields, so call the
// field's React onChange prop directly (same workaround as HeartbeatSection.test.tsx).
function typeInto(field: HTMLTextAreaElement, value: string) {
  const reactPropsKey = Object.keys(field).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (field as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as { onChange?: (event: { target: { value: string } }) => void } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the field to expose its onChange handler");
  act(() => onChange({ target: { value } }));
}

let userProjects = new Map<string, { workspaces: [] }>();
let restoreDom: (() => void) | undefined;
let projectContextSpy: { mockRestore: () => void } | undefined;
beforeEach(() => {
  restoreDom = installDom();
  userProjects = new Map([[PHAROS, { workspaces: [] }]]);
  projectContextSpy = spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
    () => ({ userProjects }) as unknown as ProjectContextModule.ProjectContext
  );
});
afterEach(() => {
  cleanup();
  projectContextSpy?.mockRestore();
  restoreDom?.();
});

describe("AgentSandboxSettings", () => {
  test("a project's Global / On / Off changes only its enabled field", async () => {
    const view = renderSettings({
      global: { enabled: true },
      projects: { [PHAROS]: { extraReadPaths: ["~/.npmrc"] } },
      support: { state: "supported" },
    });
    const mode = (name: string) => view.getByRole("button", { name }) as HTMLButtonElement;
    await waitFor(() => expect(mode("Off").disabled).toBe(false));

    fireEvent.click(mode("Off"));
    await waitFor(() => expect(mode("Off").getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(mode("Global"));
    await waitFor(() => expect(view.setProject).toHaveBeenCalledTimes(2));

    expect(view.setProject.mock.calls.map(([input]) => input)).toEqual([
      { projectPath: PHAROS, sandbox: { enabled: false } },
      { projectPath: PHAROS, sandbox: { enabled: null } },
    ]);
    expect(view.set).not.toHaveBeenCalled();
  });

  test("edited hosts save one per line, and Use defaults removes the list", async () => {
    const view = renderSettings({
      global: { enabled: true, network: "allowlist" },
      projects: {},
      support: { state: "supported" },
    });
    const editHosts = async () => {
      const edit = view.getByRole("button", { name: "Edit hosts" }) as HTMLButtonElement;
      await waitFor(() => expect(edit.disabled).toBe(false));
      fireEvent.click(edit);
      return view.getByLabelText("Allowed hosts, one per line") as HTMLTextAreaElement;
    };

    typeInto(await editHosts(), " registry.npmjs.org \n\nexample.com\nregistry.npmjs.org");
    fireEvent.click(view.getByRole("button", { name: "Save hosts" }));
    await view.findByText("Edited list · 2 hosts");

    await editHosts();
    fireEvent.click(view.getByRole("button", { name: "Use defaults" }));
    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(2));

    expect(view.set.mock.calls.map(([patch]) => patch)).toEqual([
      { allowedHosts: ["registry.npmjs.org", "example.com"] },
      { allowedHosts: null },
    ]);
  });

  test("a save sends only its field, and a change made while one is pending is not sent", async () => {
    const view = renderSettings({ global: {}, projects: {}, support: { state: "supported" } });
    let finishFirstSave: (() => void) | undefined;
    view.set.mockImplementationOnce(
      (patch: AgentSandboxPatch) =>
        new Promise<AgentSandboxState>((resolve) => {
          finishFirstSave = () =>
            resolve({
              global: patchAgentSandbox({}, patch) ?? {},
              projects: {},
              support: { state: "supported" },
            });
        })
    );
    const anyHost = () => view.getByRole("radio", { name: /Any host/ }) as HTMLInputElement;
    await waitFor(() => expect(view.toggle().disabled).toBe(false));

    fireEvent.click(view.toggle());
    fireEvent.click(anyHost());
    act(() => finishFirstSave?.());
    await waitFor(() => expect(anyHost().disabled).toBe(false));
    fireEvent.click(anyHost());

    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(2));
    expect(view.set.mock.calls.map(([patch]) => patch)).toEqual([
      { enabled: true },
      { network: "open" },
    ]);
  });

  test("off macOS only a sandbox that is on can still be changed: turned off", async () => {
    const unsupported = {
      state: "unsupported",
      reason: "Available on macOS only.",
      failsClosed: false,
    } as const;
    const off = renderSettings({ global: {}, projects: {}, support: unsupported });
    await off.findByText("Available on macOS only.");
    expect(off.toggle().disabled).toBe(true);
    expect((off.getByRole("button", { name: "Edit hosts" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((off.getByRole("button", { name: "On" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const on = renderSettings({ global: { enabled: true }, projects: {}, support: unsupported });
    await waitFor(() => expect(on.toggle().disabled).toBe(false));
    fireEvent.click(on.toggle());
    await waitFor(() => expect(on.set.mock.calls).toEqual([[{ enabled: false }]]));
  });

  test("on a Mac that cannot sandbox, a project that is On can be turned off and says so", async () => {
    const view = renderSettings({
      global: {},
      projects: { [PHAROS]: { enabled: true, network: "loopback" } },
      support: { state: "unsupported", reason: "No sandbox-exec.", failsClosed: true },
    });
    await view.findByText(/No sandbox-exec\. .+ fail until you turn it off\./);
    expect(view.toggle().disabled).toBe(true);

    const off = view.getByRole("button", { name: "Off" }) as HTMLButtonElement;
    await waitFor(() => expect(off.disabled).toBe(false));
    fireEvent.click(off);
    await waitFor(() =>
      expect(view.setProject.mock.calls).toEqual([
        [{ projectPath: PHAROS, sandbox: { enabled: false } }],
      ])
    );
    // Once it is off, the project cannot be turned back on here.
    await waitFor(() =>
      expect((view.getByRole("button", { name: "On" }) as HTMLButtonElement).disabled).toBe(true)
    );
  });
});
