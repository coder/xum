import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSettingsSections } from "./SettingsPage";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { TYPESAFE_PROVIDER_KEY } from "@/constants/autoModelRouting";
import {
  SETTING_DEFINITIONS,
  SETTINGS_SECTION_META,
  experimentAnchorId,
  type SettingDefinition,
} from "./settingsRegistry";
import {
  buildSettingsSearchIndex,
  groupSettingsSearchResults,
  searchSettings,
  splitHighlights,
} from "./settingsSearch";

interface SearchOptions {
  memory?: boolean;
  platform?: "desktop" | "browser";
  experiments?: ExperimentId[];
  providers?: Array<{ id: string; label: string }>;
  customProviderIds?: string[];
}

function search(query: string, options: SearchOptions = {}) {
  const sections = getSettingsSections(options.memory ?? false, false);
  const enabled = new Set(options.experiments ?? []);
  const index = buildSettingsSearchIndex(sections, {
    platform: options.platform ?? "desktop",
    isExperimentEnabled: (id) => enabled.has(id),
    providers: options.providers ?? [{ id: "anthropic", label: "Anthropic" }],
    customProviderIds: new Set(options.customProviderIds ?? []),
  });
  return searchSettings(index, sections, query);
}

const ids = (results: ReturnType<typeof search>) => results.map((result) => result.entry.id);

/** Every Settings source file, read once: the registry test checks ids against them. */
function settingsSources(): string {
  const root = join(import.meta.dir);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.tsx?$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file)
  );
  return files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
}

describe("settings registry", () => {
  test("every setting search can open has a row or mark to scroll to", () => {
    const sources = settingsSources();
    const definitions: Record<string, SettingDefinition> = SETTING_DEFINITIONS;
    const missing = Object.entries(definitions)
      // Provider fields scroll to their provider's card, which marks itself by provider id.
      .filter(([, definition]) => definition.anchor == null)
      .map(([id]) => id)
      .filter(
        (id) =>
          !new RegExp(
            `(SettingRow|SettingsMark|SettingsAnchor)\\s+id="${id}"|markId: "${id}"`
          ).test(sources)
      );
    expect(missing).toEqual([]);
  });

  test("every setting row belongs to a section the nav can show", () => {
    const sectionIds = new Set(SETTINGS_SECTION_META.map((section) => section.id));
    for (const [id, definition] of Object.entries(SETTING_DEFINITIONS)) {
      expect({ id, section: sectionIds.has(definition.section) }).toEqual({ id, section: true });
    }
  });

  test("a sub-option's parent is a setting in the same section", () => {
    const definitions: Record<string, SettingDefinition> = SETTING_DEFINITIONS;
    for (const [id, definition] of Object.entries(definitions)) {
      if (!definition.parent) continue;
      expect({ id, parentSection: definitions[definition.parent]?.section }).toEqual({
        id,
        parentSection: definition.section,
      });
    }
  });
});

describe("searchSettings", () => {
  test("an empty query lists nothing", () => {
    expect(search("   ")).toEqual([]);
  });

  test("every query word must match", () => {
    const results = ids(search("badge size"));
    expect(results).toContain("setting:terminal-badge-font-size");
    expect(results).not.toContain("setting:terminal-font-size");
  });

  test("matching is case-insensitive and ranks a label match above a description match", () => {
    const results = search("THEME");
    expect(results[0]?.entry.id).toBe("setting:theme");
  });

  test("keywords find settings whose copy does not use the word", () => {
    expect(ids(search("vscode"))).toContain("setting:editor");
  });

  test("a group name lists its sections, not every setting inside them", () => {
    const results = search("security");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.entry.kind === "section")).toBe(true);
    expect(ids(results)).toContain("section:sandbox");
  });

  test("a hidden section contributes no results", () => {
    expect(ids(search("global memories"))).not.toContain("section:memory");
    expect(ids(search("global memories", { memory: true }))).toContain("section:memory");
  });

  test("platform-only settings appear only where they exist", () => {
    expect(ids(search("keep screen awake", { platform: "browser" }))).not.toContain(
      "setting:keep-screen-awake"
    );
    expect(ids(search("keep screen awake", { platform: "desktop" }))).toContain(
      "setting:keep-screen-awake"
    );
    expect(ids(search("ssh host", { platform: "desktop" }))).not.toContain("setting:ssh-host");
    expect(ids(search("ssh host", { platform: "browser" }))).toContain("setting:ssh-host");
  });

  test("a hidden sub-option falls back to the setting that reveals it", () => {
    const result = search("badge opacity").find(
      (r) => r.entry.id === "setting:terminal-badge-opacity"
    );
    expect(result?.entry.fallbackAnchorId).toBe("terminal-badge");
  });

  test("a provider name opens Providers with that provider expanded", () => {
    const result = search("anthropic").find((r) => r.entry.id === "provider:anthropic");
    expect(result?.entry.sectionId).toBe("providers");
    expect(result?.entry.expandProvider).toBe("anthropic");
  });

  test("a setting outranks a shortcut that matches the same word", () => {
    const results = search("archive");
    const firstSetting = results.findIndex((r) => r.entry.kind === "setting");
    const firstShortcut = results.findIndex((r) => r.entry.kind === "keybind");
    expect(firstShortcut).toBeGreaterThan(-1);
    expect(firstSetting).toBeLessThan(firstShortcut);
  });

  test("settings of an experiment appear only while it is on", () => {
    expect(ids(search("tailscale"))).not.toContain("setting:lan-bind");
    expect(
      ids(search("tailscale", { experiments: [EXPERIMENT_IDS.CONFIGURABLE_BIND_URL] }))
    ).toContain("setting:lan-bind");
  });

  test("a configured custom provider is searchable by its display name", () => {
    const result = search("my gateway", {
      providers: [
        { id: "anthropic", label: "Anthropic" },
        { id: "corp-llm", label: "My Gateway" },
      ],
    }).find((r) => r.entry.kind === "provider");
    expect(result?.entry.expandProvider).toBe("corp-llm");
  });

  test("a field inside a provider card opens that provider expanded", () => {
    const result = search("service tier").find((r) => r.entry.id === "setting:openai-service-tier");
    expect(result?.entry.expandProvider).toBe("openai");
    // The field's own mark is the target; the card stands in while the card hides the field.
    expect(result?.entry.anchorId).toBe("openai-service-tier");
    expect(result?.entry.fallbackAnchorId).toBe("provider:openai");
  });

  test("a custom provider shadowing a built-in drops the built-in's fields", () => {
    const shadowed = { customProviderIds: ["openai", TYPESAFE_PROVIDER_KEY] };
    expect(ids(search("chatgpt oauth"))).toContain("setting:openai-oauth");
    expect(ids(search("chatgpt oauth", shadowed))).not.toContain("setting:openai-oauth");
    const evaluation = { experiments: [EXPERIMENT_IDS.AUTO_MODEL_ROUTING] };
    expect(ids(search("evaluation api key", evaluation))).toContain(
      "setting:evaluation-credential"
    );
    expect(ids(search("evaluation api key", { ...evaluation, ...shadowed }))).not.toContain(
      "setting:evaluation-credential"
    );
  });

  test("the evaluation key result expands the TypeSafe card that holds the field", () => {
    const result = search("evaluation api key", {
      experiments: [EXPERIMENT_IDS.AUTO_MODEL_ROUTING],
    }).find((r) => r.entry.id === "setting:evaluation-credential");
    expect(result?.entry.expandProvider).toBe(TYPESAFE_PROVIDER_KEY);
  });

  test("a sub-experiment falls back to its parent experiment's row", () => {
    const result = search("memory consolidation").find(
      (r) => r.entry.id === `experiment:${EXPERIMENT_IDS.MEMORY_CONSOLIDATION}`
    );
    expect(result?.entry.fallbackAnchorId).toBe(experimentAnchorId(EXPERIMENT_IDS.MEMORY));
  });

  test("experiments and shortcuts are searchable", () => {
    expect(search("agent memory").some((r) => r.entry.kind === "experiment")).toBe(true);
    const shortcut = search("command palette").find((r) => r.entry.kind === "keybind");
    expect(shortcut?.entry.shortcut).toBeTruthy();
  });

  test("results group by section, best section first", () => {
    const groups = groupSettingsSearchResults(search("font"));
    expect(groups[0]?.section.id).toBe("terminal");
    // Each section appears once.
    expect(new Set(groups.map((g) => g.section.id)).size).toBe(groups.length);
  });
});

describe("splitHighlights", () => {
  test("marks every occurrence of every query word, keeping the original case", () => {
    expect(splitHighlights("Terminal Font Size", "size font")).toEqual([
      { text: "Terminal ", match: false },
      { text: "Font", match: true },
      { text: " ", match: false },
      { text: "Size", match: true },
    ]);
  });

  test("an empty query leaves the text whole", () => {
    expect(splitHighlights("Theme", "")).toEqual([{ text: "Theme", match: false }]);
  });
});
