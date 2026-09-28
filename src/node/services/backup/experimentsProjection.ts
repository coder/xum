import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { isPlainObject } from "@/common/utils/isPlainObject";

/**
 * Whether a backup carries each experiment. A new experiment fails typecheck until it is
 * classified here. Local experiments are never exported and never applied, even when a
 * repository-controlled document names them, because enabling them grants something a
 * backup must not grant on another machine.
 */
const EXPERIMENT_BACKUP_CLASSES = {
  [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: "portable",
  [EXPERIMENT_IDS.RLM]: "portable",
  [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: "portable",
  [EXPERIMENT_IDS.AGENT_BROWSER]: "portable",
  [EXPERIMENT_IDS.ADVISOR_TOOL]: "portable",
  [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: "portable",
  [EXPERIMENT_IDS.DYNAMIC_WORKFLOWS]: "portable",
  [EXPERIMENT_IDS.MEMORY]: "portable",
  [EXPERIMENT_IDS.MEMORY_HOT_SET]: "portable",
  [EXPERIMENT_IDS.MEMORY_INTUITION]: "portable",
  [EXPERIMENT_IDS.MEMORY_CONSOLIDATION]: "portable",
  [EXPERIMENT_IDS.TOOL_SEARCH]: "portable",
  [EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT]: "portable",
  [EXPERIMENT_IDS.TIMELINE]: "portable",
  [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: "portable",
  [EXPERIMENT_IDS.TOKEN_BUDGET]: "portable",
  [EXPERIMENT_IDS.AUTO_MODEL_ROUTING]: "portable",
  // Executes repository-controlled shell commands when a skill loads; ExperimentsService
  // treats this flag as deliberate local consent, which only a local toggle may give.
  [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: "local",
  // Gates discovering, installing, and running third-party plugin code and MCP servers.
  [EXPERIMENT_IDS.AGENT_PLUGINS]: "local",
  // Consent to read Claude Code credentials; its state is owned by a backend stream.
  [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: "local",
  // Exposes the API server beyond localhost.
  [EXPERIMENT_IDS.CONFIGURABLE_BIND_URL]: "local",
  // Enterprise policy enrollment, which is per machine.
  [EXPERIMENT_IDS.MUX_GOVERNOR]: "local",
  // Platform-restricted virtual desktop sessions.
  [EXPERIMENT_IDS.PORTABLE_DESKTOP]: "local",
} as const satisfies Record<ExperimentId, "portable" | "local">;

type PortableExperimentId = {
  [K in ExperimentId]: (typeof EXPERIMENT_BACKUP_CLASSES)[K] extends "portable" ? K : never;
}[ExperimentId];

const PORTABLE_EXPERIMENT_IDS = (Object.keys(EXPERIMENT_BACKUP_CLASSES) as ExperimentId[]).filter(
  (id): id is PortableExperimentId => EXPERIMENT_BACKUP_CLASSES[id] === "portable"
);

/**
 * A backup's experiments block. An export writes every portable experiment: `true` or
 * `false` for an explicit override and `null` for none, so an experiment reset to its default
 * on the source restores as reset. An experiment the block lacks, as in a backup an older
 * build wrote, keeps the local override.
 */
export type BackupExperiments = Partial<Record<PortableExperimentId, boolean | null>>;

export interface BackupExperimentsRead {
  /** The overrides this build applies; undefined when the document carries no block. */
  experiments: BackupExperiments | undefined;
  /** Entries this build cannot apply, labeled `experiments.<id>` for the restore notice. */
  unsupported: string[];
}

export function projectBackupExperiments(
  overrides: Partial<Record<ExperimentId, boolean>>
): BackupExperiments {
  const projected: BackupExperiments = {};
  for (const id of PORTABLE_EXPERIMENT_IDS) {
    projected[id] = overrides[id] ?? null;
  }
  return projected;
}

function isPortableExperimentId(id: string): id is PortableExperimentId {
  return (
    Object.hasOwn(EXPERIMENT_BACKUP_CLASSES, id) &&
    EXPERIMENT_BACKUP_CLASSES[id as ExperimentId] === "portable"
  );
}

/** Reads the `experiments` block of a preferences document. */
export function readBackupExperiments(document: unknown): BackupExperimentsRead {
  if (!isPlainObject(document) || document.experiments === undefined) {
    return { experiments: undefined, unsupported: [] };
  }
  const block = document.experiments;
  if (!isPlainObject(block)) {
    return { experiments: undefined, unsupported: ["experiments (not an object)"] };
  }
  const experiments: BackupExperiments = {};
  const unsupported: string[] = [];
  for (const [id, value] of Object.entries(block)) {
    // Silently, like a settings key this build does not project: the backup may name it,
    // but it never decides it here.
    if (Object.hasOwn(EXPERIMENT_BACKUP_CLASSES, id) && !isPortableExperimentId(id)) continue;
    if (isPortableExperimentId(id) && (typeof value === "boolean" || value === null)) {
      experiments[id] = value;
    } else {
      // An experiment a newer build added (or this build removed), or a damaged value.
      unsupported.push(`experiments.${id}`);
    }
  }
  return { experiments, unsupported };
}

/** True when applying the block would change a local override. */
export function backupExperimentsDiffer(
  local: Partial<Record<ExperimentId, boolean>>,
  experiments: BackupExperiments
): boolean {
  return PORTABLE_EXPERIMENT_IDS.some(
    (id) => id in experiments && (local[id] ?? null) !== experiments[id]
  );
}
