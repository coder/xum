import type { WorkspaceMetadata } from "@/common/types/workspace";

export function hasWorkspaceRepository(
  metadata: Pick<WorkspaceMetadata, "kind"> | null | undefined
): boolean {
  return metadata != null && metadata.kind !== "scratch";
}
