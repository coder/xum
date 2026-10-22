import { afterEach, describe, expect, mock, test } from "bun:test";
import { useRuntimeStatusStoreRaw, type RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import { createTestApiClient } from "@/browser/testUtils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createTerminalSession } from "./terminal";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DAYTONA_WORKSPACE: FrontendWorkspaceMetadata = {
  id: "ws-day",
  name: "ws-day",
  projectName: "project",
  projectPath: "/home/user/project",
  namedWorkspacePath: "~/src/project/ws-day",
  runtimeConfig: {
    type: "ssh",
    host: "sb-1.xum--daytona",
    srcBaseDir: "~/src",
    daytona: { sandboxId: "sb-1" },
  },
};

describe("createTerminalSession", () => {
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    unsubscribe?.();
    const store = useRuntimeStatusStoreRaw();
    store.syncWorkspaces(new Map());
    store.setClient(null);
  });

  test("refreshes the runtime status of a Daytona workspace the terminal may have started", async () => {
    const getRuntimeStatuses = mock((input: { workspaceIds: string[] }) =>
      Promise.resolve(
        Object.fromEntries(input.workspaceIds.map((id): [string, RuntimeStatus] => [id, "stopped"]))
      )
    );
    const create = mock(() =>
      Promise.resolve({ sessionId: "s-1", workspaceId: "ws-day", cols: 80, rows: 24 })
    );
    const client = createTestApiClient({
      workspace: { getRuntimeStatuses },
      terminal: { create },
    });
    const store = useRuntimeStatusStoreRaw();
    store.setClient(client);
    store.syncWorkspaces(new Map([["ws-day", DAYTONA_WORKSPACE]]));
    unsubscribe = store.subscribeKey("ws-day", () => undefined);
    await settle();
    const fetchesBefore = getRuntimeStatuses.mock.calls.length;

    // The backend brought the stopped sandbox up before it opened the shell.
    await createTerminalSession(client, "ws-day");
    await settle();

    expect(getRuntimeStatuses.mock.calls.length).toBe(fetchesBefore + 1);
  });
});
