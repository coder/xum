/**
 * Renderer → backend pin recording for reawakened sub-agents (plan I2/R2).
 *
 * The full app runs against real persistence: only a deliberate pick that is actually sent
 * pins a field on a new-style child (taskAiPins present). Plain sends and backend-driven
 * reseeds must never pin.
 */
import "../dom";

import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getThinkingLevelKey } from "@/common/constants/storage";
import { KNOWN_MODELS, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { shouldRunIntegrationTests } from "../../testUtils";
import { createWorkspace, generateBranchName } from "../../ipc/helpers";
import { createAppHarness, type AppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const SPAWN_MODEL = KNOWN_MODELS.HAIKU.id;
const BACKEND_MODEL = KNOWN_MODELS.OPUS.id;

async function selectAgent(container: HTMLElement, agentId: string): Promise<void> {
  const user = userEvent.setup({ document: container.ownerDocument });
  await user.click(within(container).getByRole("button", { name: "Select agent" }));
  const option = await waitFor(() => {
    const row = container.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`);
    if (!row) throw new Error(`Agent ${agentId} not found`);
    return row;
  });
  await user.click(option);
}

function readChild(app: AppHarness): WorkspaceConfigEntry {
  const entry = app.env.config.findWorkspace(app.workspaceId);
  if (!entry) throw new Error("Child workspace disappeared from config");
  const workspace = app.env.config
    .loadConfigOrDefault()
    .projects.get(entry.projectPath)
    ?.workspaces.find((candidate) => candidate.id === app.workspaceId);
  if (!workspace) throw new Error("Child workspace entry not found");
  return workspace;
}

async function editChild(
  app: AppHarness,
  mutate: (workspace: WorkspaceConfigEntry) => void
): Promise<void> {
  await app.env.config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      const workspace = project.workspaces.find((entry) => entry.id === app.workspaceId);
      if (workspace) mutate(workspace);
    }
    return cfg;
  });
  // Publish like a backend write (e.g. a reawakening commit) so the renderer reseeds.
  await app.env.services.workspaceService.refreshAndEmitMetadata(app.workspaceId);
}

/** The mock reply streams only after the backend persisted the send's AI settings/pins. */
async function sendAndSettle(app: AppHarness, text: string): Promise<void> {
  await app.chat.send(text);
  await app.chat.expectTranscriptContains(`Mock response: ${text}`);
  await app.chat.expectStreamComplete();
}

describeIntegration("Reawakened sub-agent pins from the renderer", () => {
  test("only a sent deliberate pick pins; plain sends and backend reseeds never do", async () => {
    const app = await createAppHarness({ branchPrefix: "reawaken-pins" });
    try {
      // Pick Exec while the workspace is still a plain chat, then turn it into a
      // new-style Exec child of a fresh parent.
      await selectAgent(app.view.container, "exec");
      const parent = await createWorkspace(
        app.env,
        app.repoPath,
        generateBranchName("reawaken-pins-parent")
      );
      if (!parent.success) throw new Error(parent.error);
      await editChild(app, (workspace) => {
        workspace.parentWorkspaceId = parent.metadata.id;
        workspace.agentId = "exec";
        workspace.agentType = "exec";
        workspace.taskStatus = "reported";
        workspace.taskModelString = SPAWN_MODEL;
        workspace.taskThinkingLevel = "high";
        workspace.aiSettingsByAgent = { exec: { model: SPAWN_MODEL, thinkingLevel: "high" } };
        workspace.taskAiPins = {};
      });
      const modelKey = getModelKey(app.workspaceId);
      const thinkingKey = getThinkingLevelKey(app.workspaceId);

      // 1. A plain send records no pins.
      await sendAndSettle(app, "plain follow-up");
      expect(readChild(app).taskAiPins).toEqual({});

      // 2. A backend bucket change reseeds the renderer (not a user pick): no pin.
      expect(readPersistedState(modelKey, "")).not.toBe(BACKEND_MODEL);
      await editChild(app, (workspace) => {
        workspace.aiSettingsByAgent = { exec: { model: BACKEND_MODEL, thinkingLevel: "high" } };
      });
      await waitFor(() => expect(readPersistedState(modelKey, "")).toBe(BACKEND_MODEL), {
        timeout: 10_000,
      });
      await sendAndSettle(app, "after backend reseed");
      // The send carried the reseeded model, yet recorded no pin.
      expect(readChild(app).aiSettingsByAgent?.exec?.model).toBe(BACKEND_MODEL);
      expect(readChild(app).taskAiPins).toEqual({});

      // 3. `/model` is a deliberate pick; a backend update before the send keeps it (the
      //    thinking reseed proves the update was applied), and the send pins exactly it.
      const picked = MODEL_ABBREVIATIONS.sonnet;
      if (!picked) throw new Error("Missing sonnet abbreviation");
      await app.chat.send("/model sonnet");
      await waitFor(() => expect(readPersistedState(modelKey, "")).toBe(picked), {
        timeout: 10_000,
      });
      await editChild(app, (workspace) => {
        workspace.aiSettingsByAgent = { exec: { model: BACKEND_MODEL, thinkingLevel: "low" } };
      });
      await waitFor(() => expect(readPersistedState(thinkingKey, "")).toBe("low"), {
        timeout: 10_000,
      });
      expect(readPersistedState(modelKey, "")).toBe(picked);
      await sendAndSettle(app, "send the pick");
      expect(readChild(app).taskAiPins).toEqual({ model: picked });

      // 4. The sent pick was consumed: the next backend reseed applies, and a later plain
      //    send leaves the recorded pin as it is.
      await editChild(app, (workspace) => {
        workspace.aiSettingsByAgent = { exec: { model: BACKEND_MODEL, thinkingLevel: "high" } };
      });
      await waitFor(() => expect(readPersistedState(modelKey, "")).toBe(BACKEND_MODEL), {
        timeout: 10_000,
      });
      await sendAndSettle(app, "plain after the pin");
      expect(readChild(app).aiSettingsByAgent?.exec?.model).toBe(BACKEND_MODEL);
      expect(readChild(app).taskAiPins).toEqual({ model: picked });
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
