import {
  EXPERIMENT_IDS,
  LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID,
  PROMOTED_EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import { ExperimentsService } from "@/node/services/experimentsService";
import { TelemetryService } from "@/node/services/telemetryService";

/**
 * Experiments `xum run` and `xum workflow` can enable with `-e`. Deliberately
 * absent: MEMORY, because MemoryService derives its storage from the CLI's
 * ephemeral config root, so memories under the user's Xum home would be
 * invisible and new writes deleted on process exit.
 */
const HEADLESS_EXPERIMENT_IDS: readonly ExperimentId[] = [
  EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
  EXPERIMENT_IDS.RLM,
];

export function collectHeadlessExperiments(
  value: string,
  previous: ExperimentId[]
): ExperimentId[] {
  let experimentId = value.trim().toLowerCase();
  if (PROMOTED_EXPERIMENT_IDS.has(experimentId)) {
    return previous;
  }
  // Hidden compat alias: "PTC Exclusive Mode" merged into PTC, and the merged
  // flag activates exactly the old exclusive posture.
  if (experimentId === LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID) {
    experimentId = EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING;
  }
  const id = HEADLESS_EXPERIMENT_IDS.find((candidate) => candidate === experimentId);
  if (id === undefined) {
    throw new Error(
      `Unknown or unsupported experiment "${value}". Valid experiments: ${HEADLESS_EXPERIMENT_IDS.join(", ")}`
    );
  }
  return previous.includes(id) ? previous : [...previous, id];
}

/** Experiments for a headless run, persisted on its private temporary root. */
export async function createHeadlessExperimentsService(
  rootDir: string,
  experimentIds: readonly ExperimentId[]
): Promise<ExperimentsService> {
  const service = new ExperimentsService({
    telemetryService: new TelemetryService(rootDir),
    xumHome: rootDir,
  });
  const enabled = new Set(experimentIds);
  // RLM only takes effect under PTC, which Settings expresses by nesting it.
  if (enabled.has(EXPERIMENT_IDS.RLM)) {
    enabled.add(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  }
  for (const experimentId of enabled) {
    await service.setOverride(experimentId, true);
  }
  return service;
}
