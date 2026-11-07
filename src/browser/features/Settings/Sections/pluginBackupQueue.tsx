import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import type {
  AgentPluginGitSource,
  AgentPluginImportedComponents,
} from "@/common/config/schemas/agentPluginInstalls";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
} from "@/common/orpc/schemas/agentPlugins";
import type { BackupPluginRow } from "@/common/orpc/schemas/backup";

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
 * the plugin tracks, so the review shows the code that was backed up. A marketplace entry names
 * its own folder in the marketplace, so a subpath would look for the entry inside that folder.
 */
export function backupPreviewRequest(item: BackupPluginRow): PluginPreviewRequest {
  return {
    input: item.source.url,
    ref: item.lockedSha,
    subpath: item.method?.kind === "claude-marketplace" ? null : (item.source.subpath ?? null),
    method: item.method ?? null,
  };
}

/**
 * The source an install records. A commit-pinned preview resolves to a bare commit, which would
 * stop the plugin from tracking its branch or tag. When the preview did resolve the commit the
 * backup pinned, the backup's ref goes back in, so the plugin sits at the pinned commit and still
 * offers updates from where it came from. That holds when the user fixed the URL (ssh to https)
 * for the same commit. A preview of anything else (the user edited the ref to another branch or
 * commit) keeps what it resolved, because the backup's ref would describe a different checkout.
 */
export function installSource(
  preview: AgentPluginInstallPreview,
  item: BackupPluginRow | null
): AgentPluginGitSource {
  const pinned =
    item !== null && preview.source.refType === "commit" && preview.lockedSha === item.lockedSha;
  if (!pinned) return preview.source;
  return { ...preview.source, ref: item.source.ref, refType: item.source.refType };
}

/**
 * The components a new preview starts with selected: everything it offers, or, for a backed-up
 * plugin that recorded a choice, only what that choice names and the preview still offers.
 */
export function selectedComponents(
  preview: AgentPluginInstallPreview,
  item: BackupPluginRow | null
): AgentPluginImportedComponents {
  const offered = {
    skills: preview.skills.map((skill) => skill.name),
    mcpServers: preview.mcpServers.map((server) => server.serverName),
  };
  const backed = item?.importedComponents;
  if (backed === undefined) return offered;
  return {
    skills: offered.skills.filter((name) => backed.skills.includes(name)),
    mcpServers: offered.mcpServers.filter((name) => backed.mcpServers.includes(name)),
  };
}

const NO_PLUGINS: readonly BackupPluginRow[] = [];

/** Starts the first plugin when the panel opens; StrictMode runs mount effects twice. */
function useStartFirst(
  plugins: readonly BackupPluginRow[],
  start: (item: BackupPluginRow) => Promise<void>
): void {
  const started = useRef(false);
  useEffect(() => {
    const first = plugins[0];
    if (first === undefined || started.current) return;
    started.current = true;
    void start(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mounted panel: a new backup remounts it (key), and later items start from skip/installed
  }, []);
}

export interface InstallQueue {
  /** The plugin under review; null when the panel is not reinstalling a backup. */
  item: BackupPluginRow | null;
  position: number;
  total: number;
  /** Leave this plugin out and review the next one. */
  skip: () => Promise<void>;
  /** An install succeeded: review the next plugin, or finish. */
  installed: () => Promise<void>;
  /** Stop here. Plugins installed so far still refresh the list. */
  close: () => void;
}

/**
 * The review order of a backup's plugins. `start` runs the preview of a plugin (it is
 * event-driven: the first from the panel's mount, the others from skip and installed), and
 * `onInstalled` or `onClose` ends the queue. Without plugins, `installed` ends the panel at once,
 * which is the ordinary add flow.
 */
export function useInstallQueue(options: {
  plugins: readonly BackupPluginRow[] | undefined;
  start: (item: BackupPluginRow) => Promise<void>;
  onInstalled: () => void;
  onClose: () => void;
}): InstallQueue {
  const plugins = options.plugins ?? NO_PLUGINS;
  const [index, setIndex] = useState(0);
  const installedAny = useRef(false);
  useStartFirst(plugins, options.start);

  // Skipping every plugin is a close, not an install: no "installed" notice. A close after some
  // installs still reports them, so the list shows what was added.
  const close = () => {
    if (installedAny.current) options.onInstalled();
    else options.onClose();
  };

  const next = async (): Promise<void> => {
    const following = plugins[index + 1];
    if (following === undefined) {
      close();
      return;
    }
    setIndex(index + 1);
    await options.start(following);
  };

  return {
    item: plugins[index] ?? null,
    position: index + 1,
    total: plugins.length,
    skip: next,
    installed: async () => {
      installedAny.current = true;
      if (plugins.length === 0) close();
      else await next();
    },
    close,
  };
}

/** "From backup: 2 of 5 · name" with a Skip button; nothing outside a backup reinstall. */
export const BackupQueueHeader: React.FC<{ queue: InstallQueue; busy: boolean }> = (props) => {
  const { item } = props.queue;
  if (item === null) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-muted min-w-0 text-xs break-words">
        From backup: {props.queue.position} of {props.queue.total} ·{" "}
        <span className="text-foreground font-medium">{item.name}</span>
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void props.queue.skip()}
        disabled={props.busy}
      >
        Skip
      </Button>
    </div>
  );
};
