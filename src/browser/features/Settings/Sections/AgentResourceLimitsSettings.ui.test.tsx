import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { AgentResourceLimits } from "@/common/config/schemas/agentResourceLimits";
import type { AgentResourceLimitsStatus } from "@/common/orpc/schemas/agentResourceLimits";
import { AgentResourceLimitsSettings } from "./AgentResourceLimitsSettings";

interface LimitsState {
  limits: AgentResourceLimits;
  status: AgentResourceLimitsStatus;
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

function renderSettings(initial: LimitsState) {
  const set = mock((limits: AgentResourceLimits) =>
    Promise.resolve<LimitsState>({
      limits,
      status: { state: "active", cgroup: "/xum/xum-agents" },
    })
  );
  const api = {
    agentResourceLimits: { get: mock(() => Promise.resolve(initial)), set },
  } satisfies TestApiOverrides<APIClient>;
  const view = render(
    <APIProvider client={createTestApiClient(api)}>
      <AgentResourceLimitsSettings />
    </APIProvider>
  );
  const cpu = () => view.getByLabelText("CPU limit") as HTMLInputElement;
  const memory = () => view.getByLabelText("Memory limit") as HTMLInputElement;
  const edit = (input: HTMLInputElement, value: string) => {
    typeInto(input, value);
    fireEvent.blur(input);
  };
  return { ...view, set, cpu, memory, edit };
}

describe("AgentResourceLimitsSettings", () => {
  let restoreDom: (() => void) | undefined;
  beforeEach(() => {
    restoreDom = installDom();
  });
  afterEach(() => {
    cleanup();
    restoreDom?.();
  });

  test("shows the saved limits and saves an edited field with the other one", async () => {
    const view = renderSettings({
      limits: { cpuCores: 8 },
      status: { state: "active", cgroup: "/xum/xum-agents" },
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
      limits: { cpuCores: 8, memoryGiB: 16 },
      status: { state: "active", cgroup: "/xum/xum-agents" },
    });
    await waitFor(() => expect(view.cpu().value).toBe("8"));

    view.edit(view.cpu(), "");

    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    expect(view.set.mock.calls[0]?.[0]).toEqual({ memoryGiB: 16 });
  });

  test("names the allowed range and saves nothing for a value outside it", async () => {
    const view = renderSettings({ limits: {}, status: { state: "off" } });
    await view.findByText("No limit is set.");

    view.edit(view.cpu(), "0.05");

    await view.findByText("CPU limit must be from 0.1 to 1024 cores, or empty for no limit.");
    expect(view.set).not.toHaveBeenCalled();
  });

  test("shows why the limits are not applied and applies them again on request", async () => {
    const view = renderSettings({
      limits: { cpuCores: 2 },
      status: { state: "unavailable", reason: "xum runs in cgroup /init.scope." },
    });
    await view.findByText("Not applied: xum runs in cgroup /init.scope.");

    fireEvent.click(view.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(view.set).toHaveBeenCalledTimes(1));
    expect(view.set.mock.calls[0]?.[0]).toEqual({ cpuCores: 2 });
    await view.findByText(/Active: agents share 2 CPU cores/);
  });
});
