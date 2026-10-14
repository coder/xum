import * as crypto from "node:crypto";

import { judgeHolder, parseProcessIdentity } from "@/node/utils/concurrency/processLiveness";

/**
 * Owner tokens of this process's WorkspaceService instances, named in the pendingRemoval (#4478)
 * and pendingArchive (#4928) markers they write. A marker naming this pid is live only while its
 * instance is listed here: any other same-pid marker was written by an earlier process that had
 * our pid (judgeHolder's same-pid rule). Tests run two backends in one process, which this keeps
 * distinct as well.
 */
const liveOwnerInstanceIds = new Set<string>();

export function registerLifecycleMarkerOwner(): string {
  const instanceId = crypto.randomUUID();
  liveOwnerInstanceIds.add(instanceId);
  return instanceId;
}

export function retireLifecycleMarkerOwner(instanceId: string): void {
  liveOwnerInstanceIds.delete(instanceId);
}

/** judgeHolder's verdict on the process (and instance) that wrote a lifecycle marker. */
export function judgeLifecycleMarkerOwner(marker: {
  instanceId: string;
  pid: number;
  identity: Record<string, unknown>;
}): ReturnType<typeof judgeHolder> {
  return judgeHolder(
    { pid: marker.pid, identity: parseProcessIdentity(marker.identity) },
    liveOwnerInstanceIds.has(marker.instanceId)
  );
}
