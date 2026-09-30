import { ErrorBoundary } from "@/browser/components/ErrorBoundary/ErrorBoundary";
import { MemoryBrowser } from "@/browser/features/Memory/MemoryBrowser";

interface MemoryTabProps {
  workspaceId: string;
}

/**
 * Memory tab (experiment: "memory"): curation UI for agent memory files in
 * all three scopes. Presentation and data live in the shared MemoryBrowser
 * (also used by Settings → Memory for global files).
 */
export function MemoryTab(props: MemoryTabProps) {
  return (
    <ErrorBoundary workspaceInfo="Memory tab">
      <MemoryBrowser workspaceId={props.workspaceId} />
    </ErrorBoundary>
  );
}
