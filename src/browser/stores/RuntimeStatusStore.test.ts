import { afterEach, describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeStatusEvent } from "@/common/types/stream";
import { RuntimeStatusStore, type RuntimeStatus } from "./RuntimeStatusStore";

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

function createMetadata(
  id: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: "test-project",
    projectPath: "/home/user/test-project",
    namedWorkspacePath: `/home/user/.xum/src/test-project/${id}`,
    runtimeConfig: DEVCONTAINER_RUNTIME,
    ...overrides,
  };
}

/** Lets a started refresh run its RPC and settle; no debounce timer is involved. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RuntimeStatusStore refresh triggers (#5573)", () => {
  let store: RuntimeStatusStore;
  const getRuntimeStatuses = mock((input: { workspaceIds: string[] }) =>
    Promise.resolve(
      Object.fromEntries(input.workspaceIds.map((id): [string, RuntimeStatus] => [id, "running"]))
    )
  );
  const client = createTestApiClient({ workspace: { getRuntimeStatuses } });

  /** A connected store that displays devcontainer workspace ws-1, after its first status fetch. */
  async function setupDisplayed(metadata = new Map([["ws-1", createMetadata("ws-1")]])) {
    getRuntimeStatuses.mockClear();
    store = new RuntimeStatusStore();
    store.setClient(client);
    store.syncWorkspaces(metadata);
    await settle();
    store.subscribeKey("ws-1", () => undefined);
    await settle();
    expect(getRuntimeStatuses).toHaveBeenCalledTimes(1);
    return metadata;
  }

  afterEach(() => {
    store.dispose();
  });

  test("re-applying the same client does not refetch", async () => {
    await setupDisplayed();

    store.setClient(client);
    await settle();

    expect(getRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  test("a metadata event that changes only the title does not refetch", async () => {
    await setupDisplayed();

    store.syncWorkspaces(new Map([["ws-1", createMetadata("ws-1", { title: "Renamed" })]]));
    await settle();

    expect(getRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  test("a runtime config change of a displayed devcontainer workspace refetches", async () => {
    await setupDisplayed();

    store.syncWorkspaces(
      new Map([
        [
          "ws-1",
          createMetadata("ws-1", {
            runtimeConfig: { ...DEVCONTAINER_RUNTIME, configPath: "b.json" },
          }),
        ],
      ])
    );
    await settle();

    expect(getRuntimeStatuses).toHaveBeenCalledTimes(2);
  });

  test("a task status change of a displayed devcontainer workspace refetches", async () => {
    await setupDisplayed();

    // Launching or resuming a task starts a stopped container; only taskStatus changes.
    store.syncWorkspaces(new Map([["ws-1", createMetadata("ws-1", { taskStatus: "starting" })]]));
    await settle();

    expect(getRuntimeStatuses).toHaveBeenCalledTimes(2);
  });

  test("a displayed devcontainer workspace that appears in metadata is fetched", async () => {
    const metadata = await setupDisplayed();
    // Rendered (subscribed) before its metadata arrived: the subscribe-time fetch skips it.
    store.subscribeKey("ws-2", () => undefined);
    await settle();
    expect(getRuntimeStatuses).toHaveBeenLastCalledWith({ workspaceIds: ["ws-1"] });

    store.syncWorkspaces(new Map(metadata).set("ws-2", createMetadata("ws-2")));
    await settle();

    expect(getRuntimeStatuses).toHaveBeenLastCalledWith({ workspaceIds: ["ws-1", "ws-2"] });
  });

  test("a runtime config change of a displayed non-devcontainer workspace does not refetch", async () => {
    const local = createMetadata("ws-local", { runtimeConfig: DEFAULT_RUNTIME_CONFIG });
    const metadata = await setupDisplayed(
      new Map([
        ["ws-1", createMetadata("ws-1")],
        ["ws-local", local],
      ])
    );
    store.subscribeKey("ws-local", () => undefined);
    await settle();
    const calls = getRuntimeStatuses.mock.calls.length;

    store.syncWorkspaces(
      new Map(metadata).set("ws-local", {
        ...local,
        runtimeConfig: { type: "worktree", srcBaseDir: "/elsewhere" },
      })
    );
    await settle();

    expect(getRuntimeStatuses).toHaveBeenCalledTimes(calls);
  });

  test("a turn that starts a displayed Daytona sandbox refetches when the start begins and ends", async () => {
    await setupDisplayed(
      new Map([
        [
          "ws-1",
          createMetadata("ws-1", {
            runtimeConfig: {
              type: "ssh",
              host: "sb-1.xum--daytona",
              srcBaseDir: "~/mux",
              daytona: { sandboxId: "sb-1" },
            },
          }),
        ],
      ])
    );
    let emit: (event: RuntimeStatusEvent) => void = () => undefined;
    store.subscribeToRuntimeStatusEvents((listener) => {
      emit = listener;
      return () => undefined;
    });
    const runtimeEvent = (phase: RuntimeStatusEvent["phase"]): RuntimeStatusEvent => ({
      type: "runtime-status",
      workspaceId: "ws-1",
      phase,
      runtimeType: "ssh",
      source: "runtime",
    });

    // A turn on a running sandbox: nothing changed.
    emit(runtimeEvent("checking"));
    emit(runtimeEvent("ready"));
    await settle();
    expect(getRuntimeStatuses).toHaveBeenCalledTimes(1);

    emit(runtimeEvent("starting"));
    await settle();
    expect(getRuntimeStatuses).toHaveBeenCalledTimes(2);

    emit(runtimeEvent("ready"));
    await settle();
    expect(getRuntimeStatuses).toHaveBeenCalledTimes(3);
  });
});
