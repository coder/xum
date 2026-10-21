import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import { CONNECTION_LOST_MESSAGE } from "@/browser/contexts/connectionLink";
import {
  createControllableAsyncIterable,
  createTestApiClient,
  type ControllableAsyncIterable,
  type TestApiOverrides,
} from "@/browser/testUtils";
import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type {
  AgentResourceLimitsState,
  AgentResourceLimitsStatus,
  AgentResourceLimitsSupport,
} from "@/common/orpc/schemas/agentResourceLimits";
import { AgentResourceLimitsSettings } from "./AgentResourceLimitsSettings";

const ACTIVE: AgentResourceLimitsStatus = { state: "active", cgroup: "/xum/xum-agents" };
const OFF: AgentResourceLimitsStatus = { state: "off" };
const READY: AgentResourceLimitsSupport = { state: "ready", cgroup: "/xum" };

/** The server's saved limits, the saves it receives, and its config change subscriptions. */
function createServer(initial: AgentResourceLimitsState) {
  let saved = initial;
  const subscriptions: Array<ControllableAsyncIterable<undefined>> = [];
  const set = mock((limits: AgentResourceLimits) => {
    saved = { ...saved, limits, status: saved.enabled ? ACTIVE : OFF };
    return Promise.resolve(saved);
  });
  const setEnabled = mock(({ enabled }: { enabled: boolean }) => {
    saved = { ...saved, enabled, status: enabled ? ACTIVE : OFF };
    return Promise.resolve(saved);
  });
  const overrides = (): TestApiOverrides<APIClient> => ({
    agentResourceLimits: { get: () => Promise.resolve(saved), set, setEnabled },
    config: {
      onConfigChanged: () => {
        const subscription = createControllableAsyncIterable<undefined>();
        subscriptions.push(subscription);
        return Promise.resolve(subscription.iterable);
      },
    },
  });
  /** Another window or backend saves `next`. */
  const saveElsewhere = (next: AgentResourceLimitsState) => {
    saved = next;
    for (const subscription of subscriptions) subscription.push(undefined);
  };
  return { set, setEnabled, overrides, saveElsewhere };
}

// happy-dom does not deliver React's synthetic onChange for controlled fields, so call the
// field's React onChange prop directly (same workaround as HeartbeatSection.test.tsx).
function typeInto(input: HTMLInputElement, value: string) {
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (input as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as { onChange?: (event: { target: { value: string } }) => void } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the input to expose its onChange handler");
  act(() => onChange({ target: { value } }));
}

function fields(view: ReturnType<typeof render>) {
  const cpu = () => view.getByLabelText("CPU limit") as HTMLInputElement;
  const memory = () => view.getByLabelText("Memory limit") as HTMLInputElement;
  const toggle = () => view.getByRole("switch", { name: "Resource limits" }) as HTMLButtonElement;
  const edit = (input: HTMLInputElement, value: string) => {
    typeInto(input, value);
    fireEvent.blur(input);
  };
  return { cpu, memory, toggle, edit };
}

function renderSettings(initial: AgentResourceLimitsState) {
  const server = createServer(initial);
  const view = render(
    <APIProvider client={createTestApiClient(server.overrides())}>
      <AgentResourceLimitsSettings />
    </APIProvider>
  );
  return { ...view, ...fields(view), ...server };
}

let restoreDom: (() => void) | undefined;
beforeEach(() => {
  restoreDom = installDom();
});
afterEach(() => {
  cleanup();
  restoreDom?.();
});

describe("AgentResourceLimitsSettings", () => {
  test("follows limits saved elsewhere and keeps the field that is being edited", async () => {
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 8, memoryGiB: 16 },
      projects: {},
      status: ACTIVE,
      support: READY,
    });
    await waitFor(() => expect(view.cpu().value).toBe("8"));

    typeInto(view.memory(), "32");
    view.saveElsewhere({
      enabled: true,
      limits: { cpuCores: 4, memoryGiB: 16 },
      projects: {},
      status: ACTIVE,
      support: READY,
    });

    await waitFor(() => expect(view.cpu().value).toBe("4"));
    expect(view.memory().value).toBe("32");
    view.getByText(/Active: agents share 4 CPU cores and 16 GiB of memory/);

    // The save keeps the CPU limit saved elsewhere.
    fireEvent.blur(view.memory());
    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    expect(view.set.mock.calls[0]?.[0]).toEqual({ cpuCores: 4, memoryGiB: 32 });
  });

  test("shows the saved limits and saves an edited field with the other one", async () => {
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 8 },
      projects: {},
      status: { state: "active", cgroup: "/xum/xum-agents" },
      support: READY,
    });
    await waitFor(() => expect(view.cpu().value).toBe("8"));
    expect(view.memory().value).toBe("");
    view.getByText(/Active: agents share 8 CPU cores/);

    // A blur without a change saves nothing.
    fireEvent.blur(view.cpu());
    view.edit(view.memory(), "16");

    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    expect(view.set.mock.calls[0]?.[0]).toEqual({ cpuCores: 8, memoryGiB: 16 });
    await view.findByText(/agents share 8 CPU cores and 16 GiB of memory/);
  });

  test("clears a limit when its field is emptied", async () => {
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 8, memoryGiB: 16 },
      projects: {},
      status: { state: "active", cgroup: "/xum/xum-agents" },
      support: READY,
    });
    await waitFor(() => expect(view.cpu().value).toBe("8"));

    view.edit(view.cpu(), "");

    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    expect(view.set.mock.calls[0]?.[0]).toEqual({ memoryGiB: 16 });
  });

  test("turns the limits off and on again without changing them", async () => {
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 8 },
      projects: {},
      status: ACTIVE,
      support: READY,
    });
    await waitFor(() => expect(view.cpu().value).toBe("8"));

    fireEvent.click(view.toggle());

    await waitFor(() => expect(view.toggle().getAttribute("aria-checked")).toBe("false"));
    expect(view.setEnabled.mock.calls).toEqual([[{ enabled: false }]]);
    expect(view.cpu().disabled).toBe(true);
    expect(view.cpu().value).toBe("8");
    // The status is off, but the field still shows the saved limit.
    expect(view.queryByText("No limit is set.")).toBeNull();

    fireEvent.click(view.toggle());

    await waitFor(() => expect(view.cpu().disabled).toBe(false));
    expect(view.setEnabled.mock.calls[1]?.[0]).toEqual({ enabled: true });
    view.getByText(/Active: agents share 8 CPU cores/);
  });

  test("names the allowed range and saves nothing for a value outside it", async () => {
    const view = renderSettings({
      enabled: true,
      limits: {},
      projects: {},
      status: { state: "off" },
      support: READY,
    });
    await view.findByText("No limit is set.");

    view.edit(view.cpu(), "0.05");

    await view.findByText("CPU limit must be from 0.1 to 1024 cores, or empty for no limit.");
    expect(view.set).not.toHaveBeenCalled();
  });

  test("shows why the limits are not applied and applies them again on request", async () => {
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 2 },
      projects: {},
      status: { state: "unavailable", reason: "xum runs in cgroup /init.scope." },
      support: READY,
    });
    await view.findByText("Not applied: xum runs in cgroup /init.scope.");

    fireEvent.click(view.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    expect(view.set.mock.calls[0]?.[0]).toEqual({ cpuCores: 2 });
    await view.findByText(/Active: agents share 2 CPU cores/);
  });

  test("keeps naming an invalid field after Try again applies the saved limits", async () => {
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 2 },
      status: { state: "unavailable", reason: "xum runs in cgroup /init.scope." },
      support: READY,
    });
    await view.findByText("Not applied: xum runs in cgroup /init.scope.");

    view.edit(view.cpu(), "0.05");
    view.edit(view.memory(), "-3");
    const cpuError = "CPU limit must be from 0.1 to 1024 cores, or empty for no limit.";
    const memoryError = "Memory limit must be from 0.25 to 16384 GiB, or empty for no limit.";
    await view.findByText(cpuError);
    view.getByText(memoryError);

    fireEvent.click(view.getByRole("button", { name: "Try again" }));

    await view.findByText(/Active: agents share 2 CPU cores/);
    expect(view.set.mock.calls).toEqual([[{ cpuCores: 2 }]]);
    // The fields still hold the invalid values, so their errors stay.
    expect(view.memory().value).toBe("-3");
    view.getByText(cpuError);
    view.getByText(memoryError);
  });

  const SUDO: AgentResourceLimitsSupport = { state: "sudo", cgroup: "/init.scope" };
  test.each<
    [
      string,
      Pick<AgentResourceLimitsState, "enabled" | "limits">,
      AgentResourceLimitsSupport,
      string,
    ]
  >([
    [
      "takes the cgroup with sudo",
      { enabled: false, limits: { cpuCores: 2 } },
      SUDO,
      "/init.scope/xum-app",
    ],
    [
      "takes the cgroup with sudo, also while on with no limit set",
      { enabled: true, limits: {} },
      SUDO,
      "/init.scope/xum-app",
    ],
    // Unlike an unsupported OS, the limits can apply once xum runs elsewhere.
    [
      "cannot work where xum runs now",
      { enabled: false, limits: { cpuCores: 2 } },
      { state: "unavailable", reason: "xum runs in the root cgroup." },
      "Not available: xum runs in the root cgroup.",
    ],
  ])(
    "tells before any limit applies that applying them %s, and keeps the switch usable",
    async (_name, setting, support, note) => {
      const view = renderSettings({ ...setting, projects: {}, status: OFF, support });

      await view.findByText(note);
      expect(view.toggle().disabled).toBe(false);
    }
  );

  test("keeps the limits off where none can apply, and says why", async () => {
    const reason = "Agent resource limits need Linux with cgroup v2.";
    const view = renderSettings({
      enabled: true,
      limits: { cpuCores: 2 },
      projects: {},
      status: { state: "unavailable", reason },
      support: { state: "unsupported", reason },
    });
    await view.findByText(`Not applied: ${reason}`);

    // Limits that are on can still be turned off; then the switch stays off.
    fireEvent.click(view.toggle());

    await waitFor(() => expect(view.toggle().disabled).toBe(true));
    expect(view.setEnabled.mock.calls).toEqual([[{ enabled: false }]]);
    view.getByText(new RegExp(reason.replaceAll(".", "\\.")));
  });

  test("shows a failure to remove the limits while they are off", async () => {
    const view = renderSettings({
      enabled: false,
      limits: { cpuCores: 2 },
      projects: {},
      status: { state: "unavailable", reason: "Could not remove the limits: EACCES" },
      support: READY,
    });
    await view.findByText("Not applied: Could not remove the limits: EACCES");

    fireEvent.click(view.getByRole("button", { name: "Try again" }));

    // Wait for the save first: a waitFor whose first check runs before the render polls again
    // only after about 5 s under happy-dom, which made this test time out on a busy host.
    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.queryByText(/Not applied/)).toBeNull());
    expect(view.set.mock.calls).toEqual([[{ cpuCores: 2 }]]);
  });
});

describe.each([...GAP_MODES])("AgentResourceLimitsSettings while reconnecting (%s)", (mode) => {
  test("saves no edit offline and shows the saved limits again after reconnecting", async () => {
    const server = createServer({
      enabled: true,
      limits: { cpuCores: 8 },
      projects: {},
      status: ACTIVE,
      support: READY,
    });
    const harness = createConnectionHarness(mode, server.overrides);
    const view = render(
      <harness.Wrapper>
        <AgentResourceLimitsSettings />
      </harness.Wrapper>
    );
    const { cpu, toggle } = fields(view);
    await waitFor(() => expect(cpu().value).toBe("8"));

    typeInto(cpu(), "4");
    await harness.drop();

    await waitFor(() => expect(cpu().disabled).toBe(true));
    expect(toggle().disabled).toBe(true);
    // A blur that still reaches the field cannot save.
    fireEvent.blur(cpu());
    await view.findByText(CONNECTION_LOST_MESSAGE);
    expect(server.set).not.toHaveBeenCalled();

    harness.reconnect();
    await waitFor(() => expect(cpu().value).toBe("8"));
    expect(cpu().disabled).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(view.queryByText(CONNECTION_LOST_MESSAGE)).toBeNull();
  });
});
