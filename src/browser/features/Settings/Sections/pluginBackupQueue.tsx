import React, { useEffect, useRef } from "react";
import { Button } from "@/browser/components/Button/Button";
import type { APIClient } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  AgentPluginGitSource,
  AgentPluginImportedComponents,
} from "@/common/config/schemas/agentPluginInstalls";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
} from "@/common/orpc/schemas/agentPlugins";
import type { BackupPluginEntry } from "@/common/orpc/schemas/backup";
import { methodKey } from "./PluginInstallMethods";

/**
 * Reinstalling the plugins a settings backup lists, one install review at a time. The backup
 * carries where each plugin came from and the commit it was pinned to, never consent: every
 * plugin goes through the normal preview and the user installs each one (or skips it). Nothing
 * here installs on its own.
 */

/** What the Add plugin form sends to a preview. */
export interface PluginPreviewRequest {
  input: string;
  ref: string | null;
  subpath: string | null;
  method: AgentPluginInstallMethod | null;
}

/**
 * The preview that rebuilds a backed-up install. It asks for the pinned commit, not the branch
 * the plugin tracks, so the review shows the code that was backed up. It names no install method:
 * the preview takes the first one that fits, and the Install as picker offers the others.
 */
export function backupPreviewRequest(entry: BackupPluginEntry): PluginPreviewRequest {
  return {
    input: entry.source.url,
    ref: entry.lockedSha,
    subpath: entry.source.subpath ?? null,
    method: null,
  };
}

/** What the Add plugin form starts with: the backed-up plugin's source and pinned commit, or nothing. */
export function seededForm(seed: BackupPluginEntry | undefined): {
  input: string;
  ref: string;
  subpath: string;
} {
  if (seed === undefined) return { input: "", ref: "", subpath: "" };
  const request = backupPreviewRequest(seed);
  return { input: request.input, ref: request.ref ?? "", subpath: request.subpath ?? "" };
}

export type PreviewResult = Awaited<ReturnType<APIClient["agentPlugins"]["preview"]>>;

/**
 * Previews a backed-up plugin once the API is there (it can arrive after mount). A newer run, or an
 * unmount (Skip moves on), drops the result of an older one: StrictMode mounts twice, and an API
 * that reconnects runs again. The request is fixed for the mounted panel (a new plugin remounts it
 * by key), so only the API decides when to run.
 */
export function usePreviewOnMount(
  api: APIClient | null,
  seed: BackupPluginEntry | undefined,
  handlers: {
    onStart: () => void;
    onResult: (result: PreviewResult, method: AgentPluginInstallMethod | null) => void;
    onError: (message: string) => void;
    onEnd: () => void;
  }
): void {
  useEffect(() => {
    if (!api || seed === undefined) return;
    const request = backupPreviewRequest(seed);
    let ignore = false;
    handlers.onStart();
    void api.agentPlugins
      .preview(request)
      .then(
        (result) => !ignore && handlers.onResult(result, request.method),
        (error: unknown) => !ignore && handlers.onError(getErrorMessage(error))
      )
      .finally(() => !ignore && handlers.onEnd());
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: only the API decides when to run
  }, [api]);
}

/**
 * Which previews of a backed-up plugin the backup still describes: those with the install method
 * the first preview resolved (the first that fits, since the backup names none). Another method of
 * the Install as picker offers other components and tracks its source another way, so its preview
 * starts from its own defaults. Switching back to the first method brings the backup's choices
 * back. Gives the backup's plugin for a preview that keeps the method, and undefined for another.
 * Call it from handlers only: the first preview it sees fixes the method.
 */
export function useSeedForPreview(
  seed: BackupPluginEntry | undefined
): (preview: Pick<AgentPluginInstallPreview, "method">) => BackupPluginEntry | undefined {
  const firstMethod = useRef<string | null>(null);
  return (preview) => {
    const method = methodKey(preview.method);
    firstMethod.current ??= method;
    return firstMethod.current === method ? seed : undefined;
  };
}

/**
 * Whether this preview is the backup's plugin: it resolved the commit the backup pinned. A preview
 * of anything else (the user edited the URL's ref, or fixed it to another repository) is a
 * different checkout, so nothing the backup recorded about the plugin applies to it.
 */
function isBackedUpCommit(
  preview: AgentPluginInstallPreview,
  seed: BackupPluginEntry | undefined
): seed is BackupPluginEntry {
  return (
    seed !== undefined &&
    preview.source.refType === "commit" &&
    preview.lockedSha === seed.lockedSha
  );
}

/**
 * The source an install records. A commit-pinned preview resolves to a bare commit, which would
 * stop the plugin from tracking its branch or tag. When the preview is the backup's pinned
 * commit, and the backup tracked a branch or tag, that ref goes back in, so the plugin sits at the
 * pinned commit and still offers updates from where it came from. That holds when the user fixed
 * the URL (ssh to https) for the same commit. A backup that pinned a commit has no ref to track,
 * and anything else the user previewed keeps what it resolved.
 */
export function installSource(
  preview: AgentPluginInstallPreview,
  seed: BackupPluginEntry | undefined
): AgentPluginGitSource {
  if (!isBackedUpCommit(preview, seed) || seed.source.refType === "commit") return preview.source;
  return { ...preview.source, ref: seed.source.ref, refType: seed.source.refType };
}

/**
 * The components a new preview starts with selected: everything it offers, or, for the backup's
 * plugin that recorded a choice, only what that choice names and the preview still offers.
 */
export function selectedComponents(
  preview: AgentPluginInstallPreview,
  seed: BackupPluginEntry | undefined
): AgentPluginImportedComponents {
  const offered = {
    skills: preview.skills.map((skill) => skill.name),
    mcpServers: preview.mcpServers.map((server) => server.serverName),
  };
  const backed = isBackedUpCommit(preview, seed) ? seed.importedComponents : undefined;
  if (backed === undefined) return offered;
  return {
    skills: offered.skills.filter((name) => backed.skills.includes(name)),
    mcpServers: offered.mcpServers.filter((name) => backed.mcpServers.includes(name)),
  };
}

/** "From backup: 2 of 5 · name" with a Skip button. */
export const BackupQueueHeader: React.FC<{
  position: number;
  total: number;
  name: string;
  busy: boolean;
  onSkip: () => void;
}> = (props) => (
  <div className="flex items-center justify-between gap-2">
    <p className="text-muted min-w-0 text-xs break-words">
      From backup: {props.position} of {props.total} ·{" "}
      <span className="text-foreground font-medium">{props.name}</span>
    </p>
    <Button variant="ghost" size="sm" onClick={props.onSkip} disabled={props.busy}>
      Skip
    </Button>
  </div>
);
