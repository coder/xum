import { z } from "zod";

import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_STORAGE_MAX,
} from "@/common/constants/ui";
import {
  BASH_COLLAPSED_SUMMARY_MODES,
  EDITOR_TYPES,
  GIT_STATUS_INDICATOR_MODES,
  TERMINAL_BADGE_POSITIONS,
  TRANSCRIPT_DENSITIES,
  normalizeEditorConfig,
  normalizeTerminalBadgeConfig,
} from "@/common/constants/storage";
import { MuxProviderOptionsSchema } from "@/common/schemas/providerOptions";
import { REVIEW_FILE_TREE_VIEW_MODES, REVIEW_SORT_ORDERS } from "@/common/types/review";
import { ThinkingLevelSchema, coerceThinkingLevel } from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { isValidModelFormat, normalizeSelectedModel } from "@/common/utils/ai/models";
import { isPlainObject } from "@/common/utils/isPlainObject";

export const ThemePreferenceSchema = z.enum([
  "auto",
  "light",
  "dark",
  "flexoki-light",
  "flexoki-dark",
]);
export type ThemePreferenceConfig = z.infer<typeof ThemePreferenceSchema>;

export const LaunchBehaviorSchema = z.enum(["dashboard", "new-chat", "last-workspace"]);

const loadRepairs = new WeakMap<z.core.$ZodType, z.core.$ZodType>();

// Patches must match `strict`; a stored value is repaired the way clients read it, so the API
// never reports a value the clients would render differently.
function repairOnLoad<T extends z.core.$ZodType>(
  strict: T,
  repair: (value: unknown) => z.output<T> | undefined
): T {
  loadRepairs.set(strict, z.unknown().transform(repair));
  return strict;
}

const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;
const trimmedNonBlank = (value: unknown) => nonBlank(value)?.trim();
const repairAgentId = (value: unknown) => normalizeAgentId(value, "") || undefined;
const repairFontSize = (value: unknown) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
// A fresh schema per field, since each one registers its own repair.
const nonBlankString = () => z.string().refine((value) => value.trim().length > 0);
const BranchSchema = repairOnLoad(nonBlankString(), trimmedNonBlank);

function repairModelString(value: unknown): string | undefined {
  const model = trimmedNonBlank(value);
  if (!model || (model.startsWith("mux-gateway:") && !model.includes("/"))) return undefined;
  const normalized = normalizeSelectedModel(model);
  return isValidModelFormat(normalized) ? normalized : undefined;
}

function repairStringArray(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.flatMap((item) => trimmedNonBlank(item) ?? []) : [];
  return items.length > 0 ? [...new Set(items)] : undefined;
}

const USAGE_VIEW_MODES = ["session", "last-request"] as const;
export type UsageViewMode = (typeof USAGE_VIEW_MODES)[number];
const OUTPUT_LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type OutputLogLevel = (typeof OUTPUT_LOG_LEVELS)[number];
const ANALYTICS_TIME_RANGES = ["7d", "30d", "90d", "all"] as const;
export type AnalyticsTimeRange = (typeof ANALYTICS_TIME_RANGES)[number];
const ANALYTICS_TIMING_METRICS = ["ttft", "duration", "tps"] as const;
const ANALYTICS_TIME_ZONE_MODES = ["local", "utc"] as const;

export const UserPreferencesSchema = z.object({
  appearance: z
    .object({
      theme: ThemePreferenceSchema.optional(),
      transcriptDensity: z.enum(TRANSCRIPT_DENSITIES).optional(),
      bashCollapsedSummaryMode: z.enum(BASH_COLLAPSED_SUMMARY_MODES).optional(),
      // Independent fields, so an invalid or cleared family does not drop the size.
      terminalFontConfig: z
        .object({
          fontFamily: repairOnLoad(nonBlankString(), nonBlank).optional(),
          fontSize: repairOnLoad(z.number().positive(), repairFontSize).optional(),
        })
        .optional(),
      terminalBadgeConfig: repairOnLoad(
        z.object({
          enabled: z.boolean(),
          template: z.string(),
          position: z.enum(TERMINAL_BADGE_POSITIONS),
          opacity: z.number().positive().max(1),
          fontSize: z.number().positive(),
        }),
        (value) => (isPlainObject(value) ? normalizeTerminalBadgeConfig(value) : undefined)
      ).optional(),
      editorConfig: repairOnLoad(
        z.object({
          editor: z.enum(EDITOR_TYPES),
          customCommand: nonBlankString().optional(),
        }),
        (value) => (isPlainObject(value) ? normalizeEditorConfig(value) : undefined)
      ).optional(),
      vimEnabled: z.boolean().optional(),
      powerModeEnabled: z.boolean().optional(),
      gitStatusIndicatorMode: z.enum(GIT_STATUS_INDICATOR_MODES).optional(),
    })
    .optional(),
  navigation: z
    .object({
      launchBehavior: LaunchBehaviorSchema.optional(),
      projectOrder: repairOnLoad(z.array(nonBlankString()), repairStringArray).optional(),
    })
    .optional(),
  ai: z
    .object({
      globalDefaults: z
        .object({
          agentId: repairOnLoad(nonBlankString(), repairAgentId).optional(),
          thinkingLevel: repairOnLoad(ThinkingLevelSchema, coerceThinkingLevel).optional(),
        })
        .optional(),
      projectDefaults: z
        .record(
          z.string(),
          z.object({
            agentId: repairOnLoad(nonBlankString(), repairAgentId).optional(),
            model: repairOnLoad(
              z.string().refine((model) => repairModelString(model) !== undefined),
              repairModelString
            ).optional(),
            thinkingLevel: repairOnLoad(ThinkingLevelSchema, coerceThinkingLevel).optional(),
          })
        )
        .optional(),
      providerOptions: z
        .object({
          anthropic: MuxProviderOptionsSchema.shape.anthropic,
          google: MuxProviderOptionsSchema.shape.google,
        })
        .optional(),
      autoCompactionThresholdByModel: z
        .record(
          z.string(),
          z.number().min(AUTO_COMPACTION_THRESHOLD_MIN).max(AUTO_COMPACTION_THRESHOLD_STORAGE_MAX)
        )
        .optional(),
    })
    .optional(),
  workspaceCreation: z
    .object({
      byProject: z
        .record(
          z.string(),
          z.object({
            trunkBranch: BranchSchema.optional(),
            lastRuntimeConfig: z.record(z.string(), z.unknown()).optional(),
            notifyOnResponseAutoEnable: z.boolean().optional(),
          })
        )
        .optional(),
    })
    .optional(),
  notifications: z
    .object({
      notifyOnResponseByWorkspace: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  review: z
    .object({
      includeUncommitted: z.boolean().optional(),
      defaultBaseByProject: z.record(z.string(), BranchSchema).optional(),
      sortOrder: z.enum(REVIEW_SORT_ORDERS).optional(),
      fileTreeViewMode: z.enum(REVIEW_FILE_TREE_VIEW_MODES).optional(),
      showRead: z.boolean().optional(),
    })
    .optional(),
  ui: z
    .object({
      tutorialState: z
        .object({
          disabled: z.boolean().optional(),
          completed: z
            .object({
              creation: z.literal(true).optional(),
              workspace: z.literal(true).optional(),
              review: z.literal(true).optional(),
            })
            .optional(),
        })
        .optional(),
      sidebarAgeGrouping: z.boolean().optional(),
      sidebarFlatMode: z.boolean().optional(),
      sidebarHideSubAgents: z.boolean().optional(),
      artifactsAllowCdnScripts: z.boolean().optional(),
      statsTabViewMode: z.enum(USAGE_VIEW_MODES).optional(),
      statsTabShowModeBreakdown: z.boolean().optional(),
      costsTabViewMode: z.enum(USAGE_VIEW_MODES).optional(),
      outputTabLevel: z.enum(OUTPUT_LOG_LEVELS).optional(),
      analyticsTimeRange: z.enum(ANALYTICS_TIME_RANGES).optional(),
      analyticsTimingMetric: z.enum(ANALYTICS_TIMING_METRICS).optional(),
      // "local" means the viewing client's time zone, resolved at render time.
      analyticsTimeZoneMode: z.enum(ANALYTICS_TIME_ZONE_MODES).optional(),
    })
    .optional(),
});

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/**
 * An object whose fields are all optional is a group of independent preferences, so each
 * field (and each record value) parses on its own and an invalid one drops only itself.
 * Any other schema is one value and is dropped whole when invalid.
 */
function lenient<T extends z.core.$ZodType>(schema: T): z.ZodType<z.output<T> | undefined> {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  let parsed: z.core.$ZodType = loadRepairs.get(inner) ?? inner;
  if (
    inner instanceof z.ZodObject &&
    Object.values(inner.shape).every((field) => field instanceof z.ZodOptional)
  ) {
    parsed = z.object(
      Object.fromEntries(Object.entries(inner.shape).map(([key, field]) => [key, lenient(field)]))
    );
  } else if (inner instanceof z.ZodRecord) {
    parsed = z.record(inner.keyType, lenient(inner.valueType));
  }
  return z.optional(parsed).catch(undefined) as z.ZodType<z.output<T> | undefined>;
}

const LenientUserPreferencesSchema = lenient(UserPreferencesSchema);

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = pruneEmpty(child);
    if (pruned !== undefined) {
      out[key] = pruned;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function pruneUserPreferences(
  value: UserPreferences | undefined
): UserPreferences | undefined {
  const pruned = pruneEmpty(value);
  return isPlainObject(pruned) ? (pruned as UserPreferences) : undefined;
}

export function normalizeUserPreferences(value: unknown): UserPreferences | undefined {
  return pruneUserPreferences(LenientUserPreferencesSchema.parse(value));
}
