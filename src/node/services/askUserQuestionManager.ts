import assert from "node:assert/strict";

import type { AskUserQuestionQuestion } from "@/common/types/tools";

export interface PendingAskUserQuestion {
  toolCallId: string;
  questions: AskUserQuestionQuestion[];
}

interface PendingAskUserQuestionInternal extends PendingAskUserQuestion {
  createdAt: number;
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
}

export class AskUserQuestionManager {
  private pendingByWorkspace = new Map<string, Map<string, PendingAskUserQuestionInternal>>();

  registerPending(
    workspaceId: string,
    toolCallId: string,
    questions: AskUserQuestionQuestion[]
  ): Promise<Record<string, string>> {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");
    assert(Array.isArray(questions) && questions.length > 0, "questions must be a non-empty array");

    const workspaceMap = this.getOrCreateWorkspaceMap(workspaceId);
    assert(
      !workspaceMap.has(toolCallId),
      `ask_user_question already pending for toolCallId=${toolCallId}`
    );

    return new Promise<Record<string, string>>((resolve, reject) => {
      const entry: PendingAskUserQuestionInternal = {
        toolCallId,
        questions,
        createdAt: Date.now(),
        resolve,
        reject,
      };

      workspaceMap.set(toolCallId, entry);
    }).finally(() => {
      // Ensure cleanup no matter how the promise resolves.
      this.deletePending(workspaceId, toolCallId);
    });
  }

  answer(workspaceId: string, toolCallId: string, answers: Record<string, string>): void {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");
    assert(answers && typeof answers === "object", "answers must be an object");

    const entry = this.getPending(workspaceId, toolCallId);
    entry.resolve(answers);
  }

  cancel(workspaceId: string, toolCallId: string, reason: string): void {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");
    assert(reason.length > 0, "reason must be non-empty");

    const entry = this.getPending(workspaceId, toolCallId);
    entry.reject(new Error(reason));
  }

  cancelAll(workspaceId: string, reason: string): void {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(reason.length > 0, "reason must be non-empty");

    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (!workspaceMap) {
      return;
    }

    for (const toolCallId of workspaceMap.keys()) {
      // cancel() will delete from map via finally cleanup
      this.cancel(workspaceId, toolCallId, reason);
    }
  }

  getLatestPending(workspaceId: string): PendingAskUserQuestion | null {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");

    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (!workspaceMap || workspaceMap.size === 0) {
      return null;
    }

    let latest: PendingAskUserQuestionInternal | null = null;
    for (const entry of workspaceMap.values()) {
      if (!latest || entry.createdAt > latest.createdAt) {
        latest = entry;
      }
    }

    assert(latest !== null, "Expected latest pending entry to be non-null");

    return {
      toolCallId: latest.toolCallId,
      questions: latest.questions,
    };
  }

  private getOrCreateWorkspaceMap(
    workspaceId: string
  ): Map<string, PendingAskUserQuestionInternal> {
    let workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (!workspaceMap) {
      workspaceMap = new Map();
      this.pendingByWorkspace.set(workspaceId, workspaceMap);
    }
    return workspaceMap;
  }

  private getPending(workspaceId: string, toolCallId: string): PendingAskUserQuestionInternal {
    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    assert(workspaceMap, `No pending ask_user_question entries for workspaceId=${workspaceId}`);

    const entry = workspaceMap.get(toolCallId);
    assert(entry, `No pending ask_user_question entry for toolCallId=${toolCallId}`);

    return entry;
  }

  private deletePending(workspaceId: string, toolCallId: string): void {
    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (!workspaceMap) {
      return;
    }

    workspaceMap.delete(toolCallId);
    if (workspaceMap.size === 0) {
      this.pendingByWorkspace.delete(workspaceId);
    }
  }
}

export const askUserQuestionManager = new AskUserQuestionManager();
