import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI, useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  isCoderWorkspaceArchiveBehavior,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  isWorktreeArchiveBehavior,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";
import {
  SETTING_SELECT_TRIGGER_CLASS,
  SettingRow,
  SettingsGroup,
} from "../Components/SettingsLayout";

const ARCHIVE_BEHAVIOR_OPTIONS = [
  { value: "keep", label: "Keep running" },
  { value: "stop", label: "Stop workspace" },
  { value: "delete", label: "Delete workspace" },
] as const;
const WORKTREE_ARCHIVE_BEHAVIOR_OPTIONS: Array<{
  value: WorktreeArchiveBehavior;
  label: string;
}> = [
  { value: "keep", label: "Keep checkout" },
  { value: "delete", label: "Delete checkout" },
  { value: "snapshot", label: "Snapshot and delete" },
];

interface ArchiveBehaviors {
  coder: CoderWorkspaceArchiveBehavior;
  worktree: WorktreeArchiveBehavior;
}

// Backend config: default to the safest archive behavior until config finishes loading.
const DEFAULT_ARCHIVE_BEHAVIORS: ArchiveBehaviors = {
  coder: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  worktree: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
};

function readArchiveBehaviors(cfg: {
  coderWorkspaceArchiveBehavior?: unknown;
  worktreeArchiveBehavior?: unknown;
}): ArchiveBehaviors {
  return {
    coder: isCoderWorkspaceArchiveBehavior(cfg.coderWorkspaceArchiveBehavior)
      ? cfg.coderWorkspaceArchiveBehavior
      : DEFAULT_CODER_ARCHIVE_BEHAVIOR,
    worktree: isWorktreeArchiveBehavior(cfg.worktreeArchiveBehavior)
      ? cfg.worktreeArchiveBehavior
      : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  };
}

/**
 * updateCoderPrefs writes config.json on the backend and takes both values together. Serialize
 * and coalesce writes so rapid selections can't race and persist a stale value through
 * out-of-order writes: changes made while a write is in flight become one more write with the
 * latest pair.
 */
interface ArchiveWriter {
  chain: Promise<void>;
  pending: { api: APIClient; behaviors: ArchiveBehaviors } | null;
}

async function drainArchiveWrites(writer: ArchiveWriter) {
  for (let next = writer.pending; next; next = writer.pending) {
    // Clear before awaiting so rapid changes coalesce into a new pending value.
    writer.pending = null;
    try {
      await next.api.config.updateCoderPrefs({
        coderWorkspaceArchiveBehavior: next.behaviors.coder,
        worktreeArchiveBehavior: next.behaviors.worktree,
      });
    } catch {
      // Best-effort only. Swallow errors so the queue doesn't get stuck.
    }
  }
}

function queueArchiveWrite(writer: ArchiveWriter, api: APIClient, behaviors: ArchiveBehaviors) {
  writer.pending = { api, behaviors };
  writer.chain = writer.chain.then(() => drainArchiveWrites(writer)).catch(() => undefined);
}

type ArchiveState = ArchiveWriter & { loadNonce: number; latest: ArchiveBehaviors };

function useArchiveBehaviorsLoad(
  api: APIClient | null,
  writer: ArchiveState,
  setBehaviors: (behaviors: ArchiveBehaviors) => void,
  setLoaded: (loaded: boolean) => void
) {
  useEffect(() => {
    if (!api) return;
    // The two selects are written together, so they stay disabled (showing the kept values)
    // until this read answers: a change before it would send a stale value for the other.
    setLoaded(false);
    const nonce = ++writer.loadNonce;
    api.config
      .getConfig()
      .then((cfg) => {
        // If the user changed a setting while this request was in flight, keep their selection.
        if (nonce !== writer.loadNonce) return;
        writer.latest = readArchiveBehaviors(cfg);
        setBehaviors(writer.latest);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        // A lost connection is no read failure: the reconnect reads again. The defaults must
        // not become editable (and saved) in the meantime. Any other failure falls back to the
        // safe defaults already shown, so the next change can persist a fresh value.
        if (!isConnectionLostError(error) && nonce === writer.loadNonce) setLoaded(true);
      });
  }, [api, writer, setBehaviors, setLoaded]);
}

/** Archive behavior for Coder workspaces and worktrees (moved from General to Runtimes). */
export function ArchiveBehaviorSettings() {
  const { api } = useAPI();
  // Offline the selects are disabled: their write could not reach the server.
  const offline = useLiveAPI() == null;
  const [behaviors, setBehaviors] = useState(DEFAULT_ARCHIVE_BEHAVIORS);
  const [loaded, setLoaded] = useState(false);
  // One mutable record per mount (a lazy state initializer, so it is never re-created).
  const [writer] = useState<ArchiveState>(() => ({
    chain: Promise.resolve(),
    pending: null,
    loadNonce: 0,
    latest: DEFAULT_ARCHIVE_BEHAVIORS,
  }));
  useArchiveBehaviorsLoad(api, writer, setBehaviors, setLoaded);

  const canWrite = loaded && api?.config?.updateCoderPrefs != null;
  const change = (patch: Partial<ArchiveBehaviors>) => {
    if (!canWrite || !api) return;
    // Invalidate any in-flight load so it doesn't overwrite the user's selection.
    writer.loadNonce++;
    writer.latest = { ...writer.latest, ...patch };
    setBehaviors(writer.latest);
    queueArchiveWrite(writer, api, writer.latest);
  };
  const disabled = offline || !canWrite;

  return (
    <SettingsGroup title="Archiving" description="Applies to every project.">
      <SettingRow id="coder-archive">
        <Select
          value={behaviors.coder}
          onValueChange={(value) => change({ coder: value as CoderWorkspaceArchiveBehavior })}
          disabled={disabled}
        >
          <SelectTrigger className={SETTING_SELECT_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ARCHIVE_BEHAVIOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow id="worktree-archive">
        <Select
          value={behaviors.worktree}
          onValueChange={(value) => change({ worktree: value as WorktreeArchiveBehavior })}
          disabled={disabled}
        >
          <SelectTrigger className={SETTING_SELECT_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKTREE_ARCHIVE_BEHAVIOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingsGroup>
  );
}
