import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { createTestApiClient } from "@/browser/testUtils";
import type { DraftEvent, DraftUpdateInput } from "@/common/orpc/schemas/drafts";
import { toDraftAttachmentMetadata } from "@/common/utils/drafts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  consumeAiSelectionIntent,
  getAiSelectionIntentForSend,
  getWorkspaceAgentId,
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
  setAutoRoutingPick,
  setWorkspaceAgentPick,
  setWorkspaceAiMetadata,
} from "@/browser/utils/aiSelectionIntent";
import { getAutoRouting, getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import { installDom } from "../../../tests/ui/dom";
import { forkWorkspace } from "./chatCommands";

const SOURCE_ID = "fork-source-ws";
const FORK_ID = "fork-child-ws";
const FORK_METADATA: FrontendWorkspaceMetadata = {
  id: FORK_ID,
  name: "fork",
  projectName: "project",
  projectPath: "/tmp/project",
  namedWorkspacePath: "/tmp/project/fork",
  runtimeConfig: { type: "local" },
};
const FORKED = {
  success: true as const,
  metadata: FORK_METADATA,
  projectPath: FORK_METADATA.projectPath,
};

let cleanupDom: (() => void) | undefined;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  getDraftStore().setClient(null);
  resetAiSelectionIntentForTests();
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
          return Promise.resolve({
            revision: ++revision,
            text: input.text ?? "",
            attachments: (input.attachments ?? []).map(toDraftAttachmentMetadata),
          });
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

  test("the fork keeps the source's unsent AI picks", async () => {
    const client = createTestApiClient({
      workspace: {
        fork: () => Promise.resolve(FORKED),
        getInfo: () => Promise.resolve(FORK_METADATA),
      },
    });
    setWorkspaceAgentPick(SOURCE_ID, "plan");
    markAiSelectionIntent(SOURCE_ID, "model", "openai:gpt-5.2");
    markAiSelectionIntent(SOURCE_ID, "thinkingLevel", "high");
    markAiSelectionIntent(SOURCE_ID, "reasoningMode", "pro");
    setAutoRoutingPick(SOURCE_ID, "plan", "thinkingLevel", true);

    const result = await forkWorkspace({ client, sourceWorkspaceId: SOURCE_ID });

    expect(result.success).toBe(true);
    expect(getWorkspaceAgentId(FORK_ID)).toBe("plan");
    expect(getWorkspaceAiSelection(FORK_ID)).toEqual({
      model: "openai:gpt-5.2",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
    expect(getAutoRouting(FORK_ID, "thinkingLevel")).toBe(true);
  });

  test("the fork keeps the picks a source send ends while the fork runs", async () => {
    const MODEL = "openai:gpt-5.2";
    const client = createTestApiClient({
      workspace: {
        fork: () => {
          const sent = getAiSelectionIntentForSend(SOURCE_ID, "exec", { model: MODEL });
          setWorkspaceAiMetadata(SOURCE_ID, {
            aiSettingsByAgent: { exec: { model: MODEL, thinkingLevel: "off" } },
          });
          consumeAiSelectionIntent(SOURCE_ID, "exec", sent.attachedTokens);
          return Promise.resolve(FORKED);
        },
        getInfo: () => Promise.resolve(FORK_METADATA),
      },
    });
    markAiSelectionIntent(SOURCE_ID, "model", MODEL);

    await forkWorkspace({ client, sourceWorkspaceId: SOURCE_ID });

    // The backend built the fork from the source's settings before that send saved them.
    expect(getWorkspaceAiSelection(FORK_ID, "exec").model).toBe(MODEL);
  });

  test("the fork's start message ends the copied picks it saves", async () => {
    const MODEL = "openai:gpt-5.2";
    const LATER_MODEL = "anthropic:claude-sonnet-4-5";
    let resolveSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      resolveSent = resolve;
    });
    const client = createTestApiClient({
      workspace: {
        fork: () => Promise.resolve(FORKED),
        getInfo: () => Promise.resolve(FORK_METADATA),
        sendMessage: () => {
          resolveSent();
          return Promise.resolve({ success: true as const, data: {} });
        },
      },
    });
    markAiSelectionIntent(SOURCE_ID, "model", MODEL);

    await forkWorkspace({
      client,
      sourceWorkspaceId: SOURCE_ID,
      startMessage: "continue here",
      sendMessageOptions: { model: MODEL, thinkingLevel: "off", agentId: "exec" },
    });
    await sent;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saveForkModel = (model: string) =>
      setWorkspaceAiMetadata(FORK_ID, {
        aiSettingsByAgent: { exec: { model, thinkingLevel: "off" } },
      });
    saveForkModel(MODEL);
    // Another window's later change shows through.
    saveForkModel(LATER_MODEL);

    expect(getWorkspaceAiSelection(FORK_ID, "exec").model).toBe(LATER_MODEL);
  });
});
