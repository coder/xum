import { EventEmitter } from "node:events";

import type { WorkflowRunRecord } from "@/common/types/workflow";

/**
 * Process-wide pub/sub for workflow run mutations.
 *
 * `WorkflowRunStore` is constructed per workspace in many call sites (the oRPC
 * router, the CLI, the Workflow tool running inside a chat turn via aiService,
 * taskService, crash recovery, …), so there is no single service instance the
 * `workflows.subscribe` stream could listen to. Instead every store writes
 * through the one `writeRunFile` choke-point and notifies this module-level
 * hub, which the subscribe handler listens to — decoupling "who ran the
 * workflow" from "who is watching it".
 */
class WorkflowRunStreamHub extends EventEmitter {
  constructor() {
    super();
    // Each open Workflows tab adds a listener; lift Node's default 10-listener cap so
    // many concurrent subscribers don't trip a spurious leak warning.
    this.setMaxListeners(0);
  }

  private channel(workspaceId: string): string {
    return `run:${workspaceId}`;
  }

  /** Called by WorkflowRunStore after every durable run write. */
  notifyRunPersisted(run: WorkflowRunRecord): void {
    this.emit(this.channel(run.workspaceId), run);
  }

  /** Subscribe to run changes for one workspace; returns an unsubscribe fn. */
  subscribe(workspaceId: string, listener: (run: WorkflowRunRecord) => void): () => void {
    const channel = this.channel(workspaceId);
    this.on(channel, listener);
    return () => {
      this.off(channel, listener);
    };
  }
}

export const workflowRunStreamHub = new WorkflowRunStreamHub();
