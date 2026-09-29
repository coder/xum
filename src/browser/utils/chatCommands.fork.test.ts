import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { createTestApiClient } from "@/browser/testUtils";
import type { DraftEvent, DraftUpdateInput } from "@/common/orpc/schemas/drafts";
import { installDom } from "../../../tests/ui/dom";
import { forkWorkspace } from "./chatCommands";

const SOURCE_ID = "fork-source-ws";

let cleanupDom: (() => void) | undefined;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  getDraftStore().setClient(null);
  cleanupDom?.();
});

describe("forkWorkspace", () => {
  test("saves the source's latest draft before the backend copies it into the fork", async () => {
    let savedText = "";
    let revision = 0;
    let textSeenByFork: string | undefined;
    const client = createTestApiClient({
      drafts: {
        subscribe: (_input: void, opts?: { signal?: AbortSignal }) =>
          Promise.resolve(
            (async function* (): AsyncGenerator<DraftEvent> {
              yield { type: "snapshot", drafts: [], list: { entries: [], revision: 0 } };
              await new Promise<void>((resolve) =>
                opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
              );
            })()
          ),
        update: (input: DraftUpdateInput) => {
          if (input.text !== undefined) savedText = input.text;
          return Promise.resolve({ revision: ++revision });
        },
      },
      workspace: {
        fork: () => {
          // The backend copies <sessionDir>/draft.json at this point.
          textSeenByFork = savedText;
          return Promise.resolve({ success: false as const, error: "stop after the copy" });
        },
      },
    });
    const store = getDraftStore();
    store.setClient(client);
    await store.whenReady();
    // Typed just now: still inside the store's write debounce.
    store.setText({ kind: "workspace", workspaceId: SOURCE_ID }, "typed just before forking");

    await forkWorkspace({ client, sourceWorkspaceId: SOURCE_ID });

    expect(textSeenByFork).toBe("typed just before forking");
  });
});
