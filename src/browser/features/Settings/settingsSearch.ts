import { EXPERIMENTS, type ExperimentId } from "@/common/constants/experiments";
import { KEYBINDS, formatKeybind, isKeybindDeprecated } from "@/browser/utils/ui/keybinds";
import { KEYBIND_GROUPS, KEYBIND_LABELS } from "./Sections/KeybindsSection";
import {
  SETTING_DEFINITIONS,
  SETTINGS_GROUPS,
  experimentAnchorId,
  keybindAnchorId,
  providerAnchorId,
  SUB_EXPERIMENT_PARENTS,
  type SettingDefinition,
  type SettingsSectionMeta,
} from "./settingsRegistry";

export type SettingsSearchEntryKind = "section" | "setting" | "experiment" | "keybind" | "provider";

export interface SettingsSearchEntry {
  /** Unique across the index. */
  id: string;
  kind: SettingsSearchEntryKind;
  sectionId: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  /** `data-setting-id` to scroll to once the section is open. */
  anchorId?: string;
  /** Anchor to highlight instead when anchorId is a hidden sub-option. */
  fallbackAnchorId?: string;
  /** Formatted shortcut, for keybind entries. */
  shortcut?: string;
  /** Provider to expand when the result opens Providers. */
  expandProvider?: string;
}

export interface SettingsSearchResult {
  entry: SettingsSearchEntry;
  section: SettingsSectionMeta;
  score: number;
}

function sectionEntries(sections: readonly SettingsSectionMeta[]): SettingsSearchEntry[] {
  return sections.map((section) => ({
    id: `section:${section.id}`,
    kind: "section",
    sectionId: section.id,
    label: section.label,
    description: section.description,
    keywords: section.keywords,
  }));
}

/** What decides which settings exist here, beyond which sections are visible. */
export interface SettingsSearchContext {
  platform: "desktop" | "browser";
  isExperimentEnabled: (experimentId: ExperimentId) => boolean;
  /** The providers the Providers section lists (built-in, then configured custom ones). */
  providers: ReadonlyArray<{ id: string; label: string }>;
  /**
   * Configured custom providers. One whose id shadows a built-in renders its own card, which
   * lacks the built-in card's `builtInCardOnly` rows, so those rows are not listed.
   */
  customProviderIds: ReadonlySet<string>;
}

/** The row is on a built-in card that a custom provider with the same id replaces. */
function isOnHiddenBuiltInCard(definition: SettingDefinition, context: SettingsSearchContext) {
  const provider = definition.builtInCardOnly ? definition.expandProvider : undefined;
  return provider != null && context.customProviderIds.has(provider);
}

function isDefinitionListed(definition: SettingDefinition, context: SettingsSearchContext) {
  if ((definition.platform ?? context.platform) !== context.platform) return false;
  if (isOnHiddenBuiltInCard(definition, context)) return false;
  return definition.experiment == null || context.isExperimentEnabled(definition.experiment);
}

/** A hidden sub-option highlights its parent row; a hidden provider field, its provider card. */
function fallbackAnchorOf(definition: SettingDefinition): string | undefined {
  if (definition.parent) return definition.parent;
  return definition.expandProvider ? providerAnchorId(definition.expandProvider) : undefined;
}

function settingEntries(
  visible: ReadonlySet<string>,
  context: SettingsSearchContext
): SettingsSearchEntry[] {
  const definitions: Array<[string, SettingDefinition]> = Object.entries(SETTING_DEFINITIONS);
  return definitions
    .filter(([, definition]) => visible.has(definition.section))
    .filter(([, definition]) => isDefinitionListed(definition, context))
    .map(([id, definition]) => ({
      id: `setting:${id}`,
      kind: "setting",
      sectionId: definition.section,
      label: definition.label,
      description: definition.description,
      keywords: definition.keywords,
      anchorId: definition.anchor ?? id,
      fallbackAnchorId: fallbackAnchorOf(definition),
      expandProvider: definition.expandProvider,
    }));
}

/** One result per listed provider; it opens Providers with that provider's card expanded. */
function providerEntries(context: SettingsSearchContext): SettingsSearchEntry[] {
  return context.providers.map((provider) => ({
    id: `provider:${provider.id}`,
    kind: "provider",
    sectionId: "providers",
    label: provider.label,
    description: "API key, endpoint and provider options",
    keywords: ["provider", "api key", provider.id],
    anchorId: providerAnchorId(provider.id),
    expandProvider: provider.id,
  }));
}

/**
 * A sub-experiment renders only while its parent is on: its result falls back to the parent row,
 * so opening it always lands on a visible control.
 */
function experimentEntries(): SettingsSearchEntry[] {
  return Object.values(EXPERIMENTS)
    .filter((experiment) => experiment.showInSettings !== false)
    .map((experiment) => {
      const parent = SUB_EXPERIMENT_PARENTS[experiment.id];
      return {
        id: `experiment:${experiment.id}`,
        kind: "experiment",
        sectionId: "experiments",
        label: experiment.name,
        description: experiment.description,
        anchorId: experimentAnchorId(experiment.id),
        fallbackAnchorId: parent ? experimentAnchorId(parent) : undefined,
      };
    });
}

/** Only the shortcuts the Keybinds section lists, so a result always has a row to land on. */
function keybindEntries(): SettingsSearchEntry[] {
  return KEYBIND_GROUPS.flatMap((group) =>
    group.keys
      .filter((key) => !isKeybindDeprecated(KEYBINDS[key]))
      .map((key) => ({
        id: `keybind:${key}`,
        kind: "keybind" as const,
        sectionId: "keybinds",
        label: KEYBIND_LABELS[key],
        keywords: ["shortcut", group.label],
        anchorId: keybindAnchorId(key),
        shortcut: formatKeybind(KEYBINDS[key]),
      }))
  );
}

/** Sections whose rows come from another registry rather than SETTING_DEFINITIONS. */
const SECTION_ENTRY_SOURCES: Partial<
  Record<string, (context: SettingsSearchContext) => SettingsSearchEntry[]>
> = {
  providers: providerEntries,
  experiments: experimentEntries,
  keybinds: keybindEntries,
};

/**
 * Build the search index for the sections the user can see. Gated sections that are hidden
 * (Memory without its experiment, Remote connection without the desktop bridge) contribute no
 * entries, so search never offers a place the nav does not have.
 */
export function buildSettingsSearchIndex(
  sections: readonly SettingsSectionMeta[],
  context: SettingsSearchContext
): SettingsSearchEntry[] {
  const visible = new Set(sections.map((section) => section.id));
  return [
    ...sectionEntries(sections),
    ...settingEntries(visible, context),
    ...sections.flatMap((section) => SECTION_ENTRY_SOURCES[section.id]?.(context) ?? []),
  ];
}

const KEYBIND_RANK_PENALTY = 6;

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function startsWord(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(token, from);
    if (index < 0) return false;
    if (index === 0 || !/[a-z0-9]/.test(text[index - 1] ?? "")) return true;
    from = index + 1;
  }
}

/**
 * Weight of the best field a token matches, or 0. Labels beat keywords beat the section name
 * beat descriptions, so typing a setting's name lists that setting first.
 */
function tokenWeight(
  token: string,
  label: string,
  keywords: string,
  sectionLabel: string,
  description: string
): number {
  if (startsWord(label, token)) return 8;
  if (label.includes(token)) return 5;
  if (startsWord(keywords, token)) return 4;
  if (startsWord(sectionLabel, token)) return 3;
  if (keywords.includes(token)) return 2;
  if (startsWord(description, token)) return 2;
  if (description.includes(token)) return 1;
  return 0;
}

const GROUP_LABELS = new Map<string, string>(SETTINGS_GROUPS.map((g) => [g.id, g.label]));

/**
 * Settings also match their section's name ("terminal font" finds Terminal Font Size). A section
 * entry matches its group's name instead, so "security" lists the group's sections without
 * listing every setting inside them.
 */
function sectionLabelFor(entry: SettingsSearchEntry, section: SettingsSectionMeta): string {
  const text = entry.kind === "section" ? GROUP_LABELS.get(section.group) : section.label;
  return (text ?? "").toLowerCase();
}

/** The whole query as one phrase in the label: at its start beats anywhere in it. */
function phraseBonus(label: string, phrase: string): number {
  if (label.startsWith(phrase)) return 10;
  return label.includes(phrase) ? 5 : 0;
}

/** Score of an entry for the query words, or null when a word matches nowhere. */
function scoreEntry(
  entry: SettingsSearchEntry,
  section: SettingsSectionMeta,
  tokens: readonly string[],
  phrase: string
): number | null {
  const label = entry.label.toLowerCase();
  const keywords = (entry.keywords ?? []).join(" | ").toLowerCase();
  const sectionLabel = sectionLabelFor(entry, section);
  const description = (entry.description ?? "").toLowerCase();
  const weights = tokens.map((token) =>
    tokenWeight(token, label, keywords, sectionLabel, description)
  );
  if (weights.includes(0)) return null;
  // A shortcut is a reference, not a setting: "archive" should list the archive settings before
  // the Archive workspace shortcut that only shares the word.
  const penalty = entry.kind === "keybind" ? KEYBIND_RANK_PENALTY : 0;
  return weights.reduce((sum, weight) => sum + weight, 0) + phraseBonus(label, phrase) - penalty;
}

/**
 * Every query word must match somewhere in the entry. Results are ordered by score, then by
 * index order (nav order), so equal matches keep a stable, predictable order.
 */
export function searchSettings(
  index: readonly SettingsSearchEntry[],
  sections: readonly SettingsSectionMeta[],
  query: string
): SettingsSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const phrase = tokens.join(" ");
  const sectionById = new Map(sections.map((section) => [section.id, section]));

  const results: Array<SettingsSearchResult & { order: number }> = [];
  index.forEach((entry, order) => {
    const section = sectionById.get(entry.sectionId);
    const score = section ? scoreEntry(entry, section, tokens, phrase) : null;
    if (section && score != null) results.push({ entry, section, score, order });
  });

  results.sort((a, b) => b.score - a.score || a.order - b.order);
  return results.map(({ entry, section, score }) => ({ entry, section, score }));
}

/** Results grouped by section, sections ordered by their best result. */
export function groupSettingsSearchResults(
  results: readonly SettingsSearchResult[]
): Array<{ section: SettingsSectionMeta; results: SettingsSearchResult[] }> {
  const groups = new Map<
    string,
    { section: SettingsSectionMeta; results: SettingsSearchResult[] }
  >();
  for (const result of results) {
    let group = groups.get(result.section.id);
    if (!group) {
      group = { section: result.section, results: [] };
      groups.set(result.section.id, group);
    }
    group.results.push(result);
  }
  return [...groups.values()];
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Per character: is it inside a match of any query word? */
function matchMask(text: string, tokens: readonly string[]): boolean[] {
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    for (let index = lower.indexOf(token); index >= 0; index = lower.indexOf(token, index + 1)) {
      marked.fill(true, index, index + token.length);
    }
  }
  return marked;
}

/**
 * Split text into plain and matched segments for every query word, so results can render the
 * matches as React <mark> nodes (no HTML strings: setting copy stays escaped).
 */
export function splitHighlights(text: string, query: string): HighlightSegment[] {
  const marked = matchMask(text, tokenize(query));
  const segments: HighlightSegment[] = [];
  // UTF-16 units, the same indexes matchMask used.
  text.split("").forEach((char, index) => {
    const match = marked[index] === true;
    const last = segments.at(-1);
    if (last?.match === match) last.text += char;
    else segments.push({ text: char, match });
  });
  return segments.length > 0 ? segments : [{ text, match: false }];
}
