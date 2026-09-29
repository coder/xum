import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_MODEL, DEFAULT_WARM_MODELS } from "@/common/constants/knownModels";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { log } from "@/node/services/log";
import { encodingForModel, loadTokenizerModules } from "./tokenizer";

// Startup warms only the encodings the user's configured models need (#4992): o200k_base alone
// costs ~10 s of worker CPU and tens of MB of RSS, wasted for users who never run an OpenAI model.
// A cold encoding still loads on its first count, so a missed model costs latency, not accuracy.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function collectConfiguredModels(config: ProjectsConfig): string[] {
  const found: string[] = [];
  const add = (value: unknown) => {
    const model = nonEmptyModel(value);
    if (model !== undefined) {
      found.push(model);
    }
  };
  // The config can hold junk, so every access is guarded instead of trusting the types.
  const recordValues = (value: unknown): unknown[] => (isRecord(value) ? Object.values(value) : []);

  add(config.defaultModel);
  add(config.advisorModelString);
  // Per-project creation defaults: a new workspace in that project starts on this model.
  const ai: unknown = isRecord(config.userPreferences) ? config.userPreferences.ai : undefined;
  for (const defaults of recordValues(isRecord(ai) ? ai.projectDefaults : undefined)) {
    if (isRecord(defaults)) {
      add(defaults.model);
    }
  }
  for (const entry of recordValues(config.agentAiDefaults)) {
    if (isRecord(entry)) {
      add(entry.modelString);
      if (isRecord(entry.subagent)) {
        add(entry.subagent.modelString);
      }
    }
  }

  // Same workspace model sources ProviderService.repairRemovedCustomProviderReferences walks.
  const projects: unknown = config.projects;
  if (projects instanceof Map) {
    for (const project of projects.values()) {
      const workspaces: unknown = isRecord(project) ? project.workspaces : undefined;
      if (!Array.isArray(workspaces)) {
        continue;
      }
      for (const workspace of workspaces) {
        if (!isRecord(workspace)) {
          continue;
        }
        if (isRecord(workspace.aiSettings)) {
          add(workspace.aiSettings.model);
        }
        for (const settings of recordValues(workspace.aiSettingsByAgent)) {
          if (isRecord(settings)) {
            add(settings.model);
          }
        }
        if (isRecord(workspace.taskAiPins)) {
          add(workspace.taskAiPins.model);
        }
        add(workspace.taskModelString);
      }
    }
  }
  return found;
}

/** One model id per encoding the configured models need; DEFAULT_WARM_MODELS when none is known. */
export function deriveWarmModels(config: ProjectsConfig): string[] {
  const configured = collectConfiguredModels(config);
  if (configured.length === 0) {
    // Fresh install: nothing to go on, so keep the default warm set.
    return Array.from(DEFAULT_WARM_MODELS);
  }
  // New workspaces start on the default model, so its encoding is always warmed.
  const candidates = [nonEmptyModel(config.defaultModel) ?? DEFAULT_MODEL, ...configured];

  const byEncoding = new Map<string, string>();
  let guessed = false;
  const keep = (model: string) => {
    // No providers config: reading providers.jsonc would cost disk I/O at startup, and
    // coder:<provider>/<model> gateway ids still resolve by provider name without it.
    const metadataModel = resolveModelForMetadata(model, null);
    const resolved = encodingForModel(metadataModel);
    guessed ||= resolved.guessed;
    if (!byEncoding.has(resolved.encoding)) {
      byEncoding.set(resolved.encoding, metadataModel);
    }
  };
  for (const model of candidates) {
    try {
      keep(model);
    } catch (error) {
      log.debug(`Skipping tokenizer warm-up for '${model}':`, error);
    }
  }
  if (guessed) {
    // Without providers.jsonc an unknown provider's encoding is only a guess (e.g. a
    // custom-named Coder instance), so keep today's default set warm as well.
    for (const model of DEFAULT_WARM_MODELS) {
      keep(model);
    }
  }
  return Array.from(byEncoding.values());
}

/** Warms the encodings the in-memory config needs; never throws on a bad config. */
export async function warmConfiguredTokenizers(
  loadConfig: () => ProjectsConfig
): Promise<Array<PromiseSettledResult<string>>> {
  let models: string[];
  try {
    models = deriveWarmModels(loadConfig());
  } catch (error) {
    log.debug("Tokenizer warm-set derivation failed; warming defaults:", error);
    models = Array.from(DEFAULT_WARM_MODELS);
  }
  log.debug(`Warming tokenizers for: ${models.join(", ")}`);
  return loadTokenizerModules(models);
}
