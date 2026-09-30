import { describe, expect, test } from "bun:test";

import type { PendingFileChatAttachment, StagedChatAttachment } from "./ChatAttachments";
import {
  formatPendingFileStagingError,
  getPendingFileAttachments,
  replacePendingFilesWithStaged,
  stagePendingFiles,
} from "./pendingFileAttachments";

function pendingFile(id: string, filename: string): PendingFileChatAttachment {
  return {
    kind: "pending-file",
    id,
    filename,
    mediaType: "text/markdown",
    sizeBytes: 8,
    dataBase64: "bWFya2Rvd24=",
  };
}

type StagePendingFilesApi = Parameters<typeof stagePendingFiles>[0];
type StageAttachmentFn = StagePendingFilesApi["workspace"]["stageAttachment"];
type StageAttachmentInput = Parameters<StageAttachmentFn>[0];

function apiWithStageAttachment(impl: StageAttachmentFn): StagePendingFilesApi {
  return { workspace: { stageAttachment: impl } };
}

describe("stagePendingFiles", () => {
  test("stages files in order and maps results onto the pending ids", async () => {
    const calls: StageAttachmentInput[] = [];
    const api = apiWithStageAttachment((input) => {
      calls.push(input);
      return Promise.resolve({
        success: true,
        data: {
          filename: input.filename,
          mediaType: "text/markdown",
          sizeBytes: input.sizeBytes,
          stagedPath: `.mux/user-attachments/uuid/${input.filename}`,
        },
      });
    });

    const outcome = await stagePendingFiles(api, "ws-1", [
      pendingFile("a", "one.md"),
      pendingFile("b", "two.md"),
    ]);

    expect(calls.map((call) => call.filename)).toEqual(["one.md", "two.md"]);
    expect(calls.every((call) => call.workspaceId === "ws-1")).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.staged).toEqual([
      {
        kind: "staged",
        id: "a",
        filename: "one.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        stagedPath: ".mux/user-attachments/uuid/one.md",
      },
      {
        kind: "staged",
        id: "b",
        filename: "two.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        stagedPath: ".mux/user-attachments/uuid/two.md",
      },
    ]);
  });

  test("collects per-file failures without throwing and keeps successes", async () => {
    const api = apiWithStageAttachment((input) => {
      if (input.filename === "bad.md") {
        return Promise.resolve({ success: false, error: "disk full" });
      }
      if (input.filename === "boom.md") {
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.resolve({
        success: true,
        data: {
          filename: input.filename,
          mediaType: "text/markdown",
          sizeBytes: input.sizeBytes,
          stagedPath: `.mux/user-attachments/uuid/${input.filename}`,
        },
      });
    });

    const good = pendingFile("a", "good.md");
    const bad = pendingFile("b", "bad.md");
    const boom = pendingFile("c", "boom.md");
    const outcome = await stagePendingFiles(api, "ws-1", [good, bad, boom]);

    expect(outcome.staged.map((attachment) => attachment.id)).toEqual(["a"]);
    expect(outcome.failures).toEqual([
      { attachment: bad, error: "disk full" },
      { attachment: boom, error: "connection lost" },
    ]);
    expect(formatPendingFileStagingError(outcome.failures)).toContain("bad.md: disk full");
    expect(formatPendingFileStagingError(outcome.failures)).toContain("boom.md: connection lost");
  });
});

describe("replacePendingFilesWithStaged", () => {
  test("swaps pending files for staged results by id, preserving order", () => {
    const provider = {
      kind: "provider" as const,
      id: "img",
      url: "data:image/png;base64,AAA",
      mediaType: "image/png",
    };
    const stagedResult: StagedChatAttachment = {
      kind: "staged",
      id: "a",
      filename: "one.md",
      mediaType: "text/markdown",
      sizeBytes: 8,
      stagedPath: ".mux/user-attachments/uuid/one.md",
    };
    const unstaged = pendingFile("b", "two.md");

    expect(
      replacePendingFilesWithStaged(
        [provider, pendingFile("a", "one.md"), unstaged],
        [stagedResult]
      )
    ).toEqual([provider, stagedResult, unstaged]);
  });
});

describe("getPendingFileAttachments", () => {
  test("filters pending files out of a mixed attachment list", () => {
    const pending = pendingFile("a", "one.md");
    expect(
      getPendingFileAttachments([
        { kind: "provider", id: "img", url: "data:", mediaType: "image/png" },
        pending,
      ])
    ).toEqual([pending]);
  });
});
