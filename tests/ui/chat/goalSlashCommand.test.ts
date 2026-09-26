import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { act, fireEvent, waitFor } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  lockInitialStaging,
  unlockInitialStaging,
} from "@/browser/features/ChatInput/initialStagingLock";
import { getInputAttachmentsKey } from "@/common/constants/storage";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

describe("Goal slash command", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("sets a new goal from a completed goal when Enter follows a stale /goal suggestion", async () => {
    const app = await createAppHarness({
      branchPrefix: "goal-slash",
    });

    try {
      const completed = await app.env.orpc.workspace.setGoal({
        workspaceId: app.workspaceId,
        objective: "old completed goal",
        status: "complete",
        completionSummary: "Done.",
        budgetCents: null,
      });
      expect(completed.success).toBe(true);

      await app.chat.typeWithoutSending("/goal");
      await waitFor(() => {
        const suggestions = app.view.container.querySelector("[data-command-suggestions]");
        expect(suggestions).not.toBeNull();
      });

      await app.chat.typeWithoutSending("/goal this is your new goal,");
      const textarea = app.view.container.querySelector(
        'textarea[aria-label="Message Claude"]'
      );
      expect(textarea).not.toBeNull();
      fireEvent.keyDown(textarea!, { key: "Enter" });

      await waitFor(async () => {
        const { goal } = await app.env.orpc.workspace.getGoal({ workspaceId: app.workspaceId });
        expect(goal?.objective).toBe("this is your new goal,");
        expect(goal?.status).toBe("active");
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("sends /goal with staged attachments as a normal message instead of a command", async () => {
    // Simulates a transferred staging-failure draft: raw /goal text plus a
    // staged attachment chip persisted under the workspace draft keys.
    // Seeded before render because attachments load once at ChatInput mount.
    const app = await createAppHarness({
      branchPrefix: "goal-staged",
      beforeRender: (workspaceId) => {
        updatePersistedState(getInputAttachmentsKey(workspaceId), [
          {
            kind: "staged",
            id: "s1",
            filename: "notes.md",
            mediaType: "text/markdown",
            sizeBytes: 8,
            stagedPath: ".mux/user-attachments/uuid/notes.md",
          },
        ]);
      },
    });

    try {
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("notes.md");
      });

      await app.chat.send("/goal review the attached files");

      // The bypass sends the raw text as a normal message; the command guard
      // would otherwise block staged files with an error toast and no send.
      await app.chat.expectTranscriptContains("Mock response:");
      await app.chat.expectTranscriptContains("/goal review the attached files");

      const { goal } = await app.env.orpc.workspace.getGoal({ workspaceId: app.workspaceId });
      expect(goal).toBeNull();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("shows attachment chips written to the draft key after the composer mounted", async () => {
    const app = await createAppHarness({
      branchPrefix: "late-attach",
    });

    try {
      // Simulates a creation-flow draft transfer that lands after navigation:
      // staging on deferred runtimes can finish minutes after the workspace
      // composer mounted, so the write must sync into the mounted composer.
      act(() => {
        updatePersistedState(getInputAttachmentsKey(app.workspaceId), [
          {
            kind: "staged",
            id: "s1",
            filename: "late-transfer.md",
            mediaType: "text/markdown",
            sizeBytes: 8,
            stagedPath: ".mux/user-attachments/uuid/late-transfer.md",
          },
        ]);
      });

      await waitFor(() => {
        expect(app.view.container.textContent).toContain("late-transfer.md");
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("disables the composer while the initial staging lock is held", async () => {
    const app = await createAppHarness({
      branchPrefix: "staging-lock",
    });

    try {
      const getTextarea = () =>
        app.view.container.querySelector(
          'textarea[aria-label="Message Claude"]'
        );

      await waitFor(() => {
        const textarea = getTextarea();
        expect(textarea).not.toBeNull();
        expect(textarea!.disabled).toBe(false);
      });

      act(() => {
        lockInitialStaging(app.workspaceId);
      });
      await waitFor(() => {
        expect(getTextarea()!.disabled).toBe(true);
      });

      act(() => {
        unlockInitialStaging(app.workspaceId);
      });
      await waitFor(() => {
        expect(getTextarea()!.disabled).toBe(false);
      });
    } finally {
      unlockInitialStaging(app.workspaceId);
      await app.dispose();
    }
  }, 60_000);
});
