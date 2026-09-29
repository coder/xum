import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_MODEL, DEFAULT_WARM_MODELS, KNOWN_MODELS } from "@/common/constants/knownModels";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import { isValidModelFormat } from "@/common/utils/ai/models";
import { log } from "@/node/services/log";
import { encodingForModel, loadTokenizerModules } from "./tokenizer";

// Startup warms only the encodings the user's configured models need (#4992): o200k_base alone
// costs ~10 s of worker CPU and tens of MB of RSS, wasted for users who never run an OpenAI model.
// A cold encoding still loads on its first count, so a missed model costs latency, not accuracy.
//
// Deliberate boundary (#4992 perf-owner decision): only the config already in memory is read.
// Models that live elsewhere (providers.jsonc mappedToModel aliases, agent definition files,
// renderer-only picks) pay one cold start on first use instead of a disk read at startup.

// Keys whose string values (or string arrays, for `models`) select a model anywhere in the config:
// workspace aiSettings/aiSettingsByAgent/taskAiPins, agent defaults, project creation defaults,
// auto-routing tiers, refusal fallbacks, advisor and evaluation models. Walking by key instead of
// listing sources keeps new model settings covered; catalog-like fields (hiddenModels, gateway
// model lists) use other keys, so they cannot widen the set.
const MODEL_KEYS = new Set([
  "model",
  "models",
  "modelString",
  "defaultModel",
  "advisorModelString",
  "taskModelString",
  "evaluationModel",
]);
const MAX_WALK_DEPTH = 12;
const MODEL_PROVIDERS = new Set<string>(SUPPORTED_PROVIDERS);

// History truncation always counts with this fixed model (historyService), so its encoding
// (claude, ~1.3 s) stays warm whatever the user's models are.
const ALWAYS_WARM_MODEL = KNOWN_MODELS.SONNET.id;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const model = value.trim();
  // Only provider-prefixed ids: paths and URLs (e.g. "https://...") also contain a colon.
  if (!isValidModelFormat(model) || !MODEL_PROVIDERS.has(model.slice(0, model.indexOf(":")))) {
    return undefined;
  }
  return model;
}

function collectConfiguredModels(config: ProjectsConfig): string[] {
  const found: string[] = [];
  // The config can hold junk, so nothing here trusts the types.
  const stack: Array<{ value: unknown; depth: number }> = [{ value: config, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > MAX_WALK_DEPTH || !isRecord(value)) {
      continue;
    }
    const children: Iterable<[unknown, unknown]> =
      value instanceof Map
        ? value.entries()
        : Array.isArray(value)
          ? value.map((child): [unknown, unknown] => [undefined, child])
          : Object.entries(value);
    for (const [key, child] of children) {
      if (typeof key === "string" && MODEL_KEYS.has(key)) {
        for (const candidate of key === "models" && Array.isArray(child) ? child : [child]) {
          const model = asModel(candidate);
          if (model !== undefined) {
            found.push(model);
          }
        }
      }
      stack.push({ value: child, depth: depth + 1 });
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
  const candidates = [
    ALWAYS_WARM_MODEL,
    asModel(config.defaultModel) ?? DEFAULT_MODEL,
    ...configured,
  ];

  const byEncoding = new Map<string, string>();
  // A Coder gateway id's upstream type lives in providers.jsonc (instances can be custom-named
  // or named after another provider), so its encoding is only a guess; keep today's default set
  // warm too. Unknown providers need no such rule: their catch-all tokenizer is o200k_base,
  // which the id itself adds, and claude is always warm.
  let uncertain = false;
  const keep = (model: string) => {
    const encoding = encodingForModel(model);
    uncertain ||= model.startsWith("coder:");
    if (!byEncoding.has(encoding)) {
      byEncoding.set(encoding, model);
    }
  };
  for (const model of candidates) {
    try {
      keep(model);
    } catch (error) {
      log.debug(`Skipping tokenizer warm-up for '${model}':`, error);
    }
  }
  if (uncertain) {
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
