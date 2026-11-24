import { createContext } from "react";

import type { LiveBashOutputView } from "@/browser/utils/messages/liveBashOutputBuffer";

/**
 * Where a bash tool card reads its live stdout/stderr while the tool runs.
 *
 * Desktop feeds WorkspaceStore from its own chat subscription, and `useBashToolLiveOutput`
 * reads that store by default. A host that renders the shared transcript without registering
 * workspaces in WorkspaceStore (the VS Code webview, #4750) provides its own source here, fed
 * from the chat events it already receives, instead of building a second chat pipeline in
 * the store.
 */
export interface LiveBashOutputSource {
  subscribe(workspaceId: string, listener: () => void): () => void;
  /** Must return a stable reference until the output changes (useSyncExternalStore snapshot). */
  get(workspaceId: string, toolCallId: string): LiveBashOutputView | null;
}

export const LiveBashOutputSourceContext = createContext<LiveBashOutputSource | null>(null);
