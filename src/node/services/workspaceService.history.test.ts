import { describe, expect, test, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok } from "@/common/types/result";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { InitStateManager } from "./initStateManager";
import { createMuxMessage } from "@/common/types/message";
import { buildStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import {
  mockInitStateManager,
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
} from "./workspaceService.testHarness";

describe("WorkspaceService.getHistoryLoadMore", () => {
  test("rejects on a failed page read instead of reporting an exhausted empty page", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "load-more-read-failure";
    try {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "first", { historySequence: 0, timestamp: 1 })
      );
      const workspaceService = createWorkspaceServiceForTest({ config, historyService });
      // A legitimately empty read (nothing older) is still an exhausted page...
      expect(
        await workspaceService.getHistoryLoadMore(workspaceId, { beforeHistorySequence: 0 })
      ).toEqual({ messages: [], nextCursor: null, hasOlder: false });
      // ...but a read failure must not look like one: the client would take `hasOlder: false`
      // as authoritative coverage (and edit-conflict recovery would report the row deleted).
      spyOn(historyService, "getHistoryBoundaryWindow").mockResolvedValueOnce(
        Err("EIO: disk unreadable")
      );
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(
        workspaceService.getHistoryLoadMore(workspaceId, { beforeHistorySequence: 0 })
      ).rejects.toThrow(/disk unreadable/);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService.stageAttachment", () => {
  test("waits for workspace init before writing into the workspace", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "stage-attachment-init";
    // Local runtime resolves the execution path to the project dir itself.
    const projectPath = path.join(config.rootDir, "project");
    const workspacePath = projectPath;
    try {
      await fsPromises.mkdir(workspacePath, { recursive: true });
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "stage-attachment-init",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
        namedWorkspacePath: workspacePath,
      });

      let releaseInit: () => void = () => undefined;
      const initGate = new Promise<void>((resolve) => {
        releaseInit = resolve;
      });
      let barrierReached: () => void = () => undefined;
      const barrierReachedGate = new Promise<void>((resolve) => {
        barrierReached = resolve;
      });
      const waitForInit = mock(() => {
        barrierReached();
        return initGate;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        initStateManager: {
          ...mockInitStateManager,
          waitForInit,
        } as unknown as InitStateManager,
      });

      const stagePromise = workspaceService.stageAttachment({
        workspaceId,
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        dataBase64: Buffer.from("markdown").toString("base64"),
      });

      // Staging must block on the init barrier before any workspace write.
      await barrierReachedGate;
      expect(waitForInit).toHaveBeenCalledWith(workspaceId);
      const entriesBeforeInit = await fsPromises.readdir(workspacePath);
      expect(entriesBeforeInit).toEqual([]);

      releaseInit();
      const result = await stagePromise;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      await fsPromises.access(path.join(workspacePath, result.data.stagedPath));
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService.setActiveTurnThinkingLevel", () => {
  test("returns accepted:false when the workspace has no session", async () => {
    await using harness = await createWorkspaceServiceHarness();
    const workspaceService = harness.service;
    // No session was ever created for this workspace: nothing is running, so
    // the mid-turn override is a no-op and persisted settings cover the next turn.
    const result = workspaceService.setActiveTurnThinkingLevel("unknown-workspace", "high");
    expect(result).toEqual(Ok({ accepted: false }));
  });
});

describe("WorkspaceService.getLastUserPrompt", () => {
  async function withService(
    seed: (historyService: HistoryService, workspaceId: string) => Promise<void>
  ): Promise<string | null> {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "last-user-prompt";
    try {
      await seed(historyService, workspaceId);
      const workspaceService = createWorkspaceServiceForTest({ config, historyService });
      const result = await workspaceService.getLastUserPrompt(workspaceId);
      return result?.text ?? null;
    } finally {
      await cleanup();
    }
  }

  test("returns a typed prompt that predates the latest compaction boundary", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the prompt before compaction", { historySequence: 1 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary", "assistant", "Compacted summary", {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
        })
      );
    });

    expect(prompt).toBe("the prompt before compaction");
  });

  test("skips synthetic and empty user turns", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "typed by the user", { historySequence: 1 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", "   ", { historySequence: 2 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u3", "user", "injected turn", { historySequence: 3, synthetic: true })
      );
    });

    expect(prompt).toBe("typed by the user");
  });

  test("returns null when the workspace has no typed prompt", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("a1", "assistant", "hello", { historySequence: 1 })
      );
    });

    expect(prompt).toBeNull();
  });

  test("prefers the raw slash command over its expanded provider text", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded skill body sent to the model", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: { ...message.metadata, muxMetadata: { rawCommand: "/compact" } },
      } as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("reconstructs a compaction command's follow-up text", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent: { text: "then rerun the failing test" } },
          },
        },
      } as typeof message);
    });

    expect(prompt).toBe("/compact\nthen rerun the failing test");
  });

  test("keeps the bare compaction command when the follow-up is the resume sentinel", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent: { text: "Continue" } },
          },
        },
      } as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("keeps scanning past a staged-attachment notice", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "summarize the attached data", { historySequence: 1 })
      );
      const notice = buildStagedAttachmentNotice([
        {
          kind: "staged",
          id: "csv-1",
          filename: "data.csv",
          mediaType: "text/csv",
          sizeBytes: 34,
          stagedPath: ".mux/user-attachments/id/data.csv",
        },
      ]);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", notice.trimStart(), { historySequence: 2 })
      );
    });

    expect(prompt).toBe("summarize the attached data");
  });

  test("survives a compaction row whose parsed metadata is missing", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: { type: "compaction-request", rawCommand: "/compact" },
        },
      } as unknown as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("keeps scanning past a user row with primitive muxMetadata", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the older valid prompt", { historySequence: 1 })
      );
      const broken = createMuxMessage("u2", "user", "   ", { historySequence: 2 });
      await historyService.appendToHistory(workspaceId, {
        ...broken,
        metadata: { ...broken.metadata, muxMetadata: "corrupted" },
      } as unknown as typeof broken);
    });

    expect(prompt).toBe("the older valid prompt");
  });

  test("keeps scanning past a user row with malformed parts", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the older valid prompt", { historySequence: 1 })
      );
      const broken = createMuxMessage("u2", "user", "ignored", { historySequence: 2 });
      await historyService.appendToHistory(workspaceId, {
        ...broken,
        parts: undefined,
      } as unknown as typeof broken);
    });

    expect(prompt).toBe("the older valid prompt");
  });

  test("returns the newest prompt when several share one reverse-read chunk", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      for (const [index, text] of ["oldest prompt", "middle prompt", "newest prompt"].entries()) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`u${index}`, "user", text, { historySequence: index + 1 })
        );
      }
    });

    expect(prompt).toBe("newest prompt");
  });
});
