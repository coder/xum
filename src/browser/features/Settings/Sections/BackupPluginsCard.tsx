import { useRef, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { displayRepoUrl } from "@/common/utils/agentPluginSource";
import type {
  BackupOperationError,
  BackupPluginInstall,
  BackupPluginRemoval,
} from "@/common/orpc/schemas/backup";
import { publishPluginsSectionIntent } from "./pluginsSectionIntents";

/** What a preview or restore says about the backup's plugin list. */
export interface PluginBackupReport {
  pluginInstalls?: readonly BackupPluginInstall[];
  pluginListSkipped?: boolean;
  pluginListWarnings?: readonly string[];
}

export const NO_PLUGIN_BACKUP: PluginBackupReport = {};

/** The plugins this machine lacks: the only ones a reinstall offers. */
function missingPlugins(report: PluginBackupReport): BackupPluginInstall[] {
  return (report.pluginInstalls ?? []).filter((plugin) => plugin.status === "missing");
}

/**
 * Hands the missing plugins to Settings → Plugins and opens it. Nothing installs here: the
 * Plugins section previews each plugin and the user confirms each install (a backup never
 * carries consent). `enabled` is false while a backup action runs, so a shortcut cannot leave
 * the section mid-restore.
 */
export function reviewBackedUpPlugins(options: {
  report: PluginBackupReport;
  enabled: boolean;
  openPlugins: () => void;
}): void {
  const missing = missingPlugins(options.report);
  if (!options.enabled || missing.length === 0) return;
  publishPluginsSectionIntent({ type: "install-from-backup", plugins: missing });
  options.openPlugins();
}

const STATUS_BADGE: Record<BackupPluginInstall["status"], { label: string; tone: string }> = {
  missing: { label: "Not installed", tone: "text-accent-text border-accent/40" },
  installed: { label: "Installed", tone: "text-success-text border-success/40" },
  conflict: { label: "Name in use", tone: "text-warning border-warning/40" },
};

function PluginRow(props: { plugin: BackupPluginInstall }) {
  const { plugin } = props;
  const badge = STATUS_BADGE[plugin.status];
  const folder = plugin.source.subpath === undefined ? "" : `/${plugin.source.subpath}`;
  // Every string here comes from the repository, so each wraps instead of widening the card.
  return (
    <li className="min-w-0 text-xs">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="text-foreground min-w-0 font-medium break-all">{plugin.name}</span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${badge.tone}`}>
          {badge.label}
        </span>
      </div>
      <span className="text-muted block break-all">
        {displayRepoUrl(plugin.source.url)}
        {folder}
      </span>
      <span className="text-muted block font-mono break-all">
        {plugin.source.ref} · {plugin.lockedSha.slice(0, 12)}
      </span>
    </li>
  );
}

/**
 * The removal a push refused until the user approves it. The backup decides (a push rewrites its
 * plugin list from this machine's installs, and a restore installs nothing), so this holds only
 * the digest the user confirmed: `confirm` pushes with the digest of the removal on screen, a
 * backup that changed since asks again, and the digest rides along on later pushes (a secret
 * refusal can follow) until a push succeeds.
 */
export function usePluginRemovalPrompt(options: { busy: boolean; push: () => Promise<void> }) {
  const [removal, setRemoval] = useState<BackupPluginRemoval | null>(null);
  const approved = useRef<string | undefined>(undefined);
  return {
    removal,
    /** Shows what a refused push would remove; any other outcome leaves the card as it is. */
    record: (error: BackupOperationError) => {
      if (error.code === "PLUGIN_REMOVAL_APPROVAL_REQUIRED")
        setRemoval(error.pluginRemoval ?? null);
    },
    clear: () => {
      approved.current = undefined;
      setRemoval(null);
    },
    /** The digest the next push carries. */
    approvedDigest: () => approved.current,
    confirm: () => {
      if (removal === null || options.busy) return undefined;
      approved.current = removal.approval;
      return options.push();
    },
  };
}

/** Names the plugins a push removes from the backup, with the one way to go ahead. */
export function PluginRemovalCard(props: {
  removal: BackupPluginRemoval | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { removal } = props;
  if (removal === null) return null;
  return (
    <div className="border-border-light space-y-2 rounded-md border p-3">
      <h4 className="text-foreground text-xs font-medium">Remove plugins from the backup?</h4>
      <p className="text-muted text-xs">
        {removal.wholeList
          ? "The backup has a plugin list, and backing up now writes none (plugin backup is off here, or this machine has no managed plugin). The whole list is removed from the backup."
          : "Backing up now writes the plugins installed on this machine. These plugins are in the backup but not installed here, so they are removed from it:"}
      </p>
      {removal.names.length > 0 ? (
        <ul className="text-foreground list-disc space-y-0.5 pl-4 text-xs">
          {removal.names.map((name) => (
            <li key={name} className="break-all">
              {name}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        size="sm"
        variant="destructive"
        onClick={props.onConfirm}
        disabled={props.busy}
        tooltip={`Back up and remove (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_CONFIRM_PLUGIN_REMOVAL)})`}
        className="w-full sm:w-auto"
      >
        Back up and remove
      </Button>
    </div>
  );
}

/** What this build could not read of the list. The rows it could read still show. */
function PluginListWarnings(props: { warnings: readonly string[] }) {
  if (props.warnings.length === 0) return null;
  return (
    <div className="text-warning text-xs">
      <p>Part of the plugin list could not be read and was left out:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {props.warnings.map((warning) => (
          <li key={warning} className="break-words">
            {warning}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The backup's plugin list after a preview or restore, with the one way forward: review each
 * missing plugin through the normal install preview. Also says so when a list was skipped.
 */
export function BackupPluginsCard(props: {
  report: PluginBackupReport;
  busy: boolean;
  onReview: () => void;
}) {
  const plugins = props.report.pluginInstalls ?? [];
  const warnings = props.report.pluginListWarnings ?? [];
  const missing = missingPlugins(props.report);
  if (props.report.pluginListSkipped === true) {
    return (
      <div className="border-border-light text-muted rounded-md border p-3 text-xs">
        This backup carries a plugin list, but plugin backup is disabled here, so it was skipped.
        Enable “Agent plugins” and save to see it.
      </div>
    );
  }
  if (plugins.length === 0 && warnings.length === 0) return null;
  return (
    <div className="border-border-light space-y-3 rounded-md border p-3">
      <div>
        <h4 className="text-foreground text-xs font-medium">Plugins in this backup</h4>
        <p className="text-muted mt-1 text-xs">
          A restore never installs a plugin. Reviewing opens each missing plugin&apos;s install
          preview at the commit the backup pinned, and nothing installs until you confirm it.
        </p>
      </div>
      <PluginListWarnings warnings={warnings} />
      <ul className="space-y-2">
        {plugins.map((plugin) => (
          <PluginRow key={plugin.name} plugin={plugin} />
        ))}
      </ul>
      {plugins.some((plugin) => plugin.status === "conflict") ? (
        <p className="text-muted text-xs">
          A plugin marked “Name in use” is not offered: this machine already has a different
          version, or a folder Xum does not manage, under that name.
        </p>
      ) : null}
      {missing.length > 0 ? (
        <Button
          size="sm"
          onClick={props.onReview}
          disabled={props.busy}
          tooltip={`Review and install plugins (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_REVIEW_PLUGINS)})`}
          className="w-full sm:w-auto"
        >
          Review and install ({missing.length})
        </Button>
      ) : null}
    </div>
  );
}
