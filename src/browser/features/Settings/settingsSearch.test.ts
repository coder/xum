import { describe, expect, test } from "bun:test";
import { getSettingsSections } from "./SettingsPage";
import { SETTING_DEFINITIONS, SETTINGS_SECTION_META } from "./settingsRegistry";
import {
  buildSettingsSearchIndex,
  groupSettingsSearchResults,
  searchSettings,
  splitHighlights,
} from "./settingsSearch";

function search(
  query: string,
  options: { memory?: boolean; platform?: "desktop" | "browser" } = {}
) {
  const sections = getSettingsSections(options.memory ?? false, false);
  const index = buildSettingsSearchIndex(sections, options.platform ?? "desktop");
  return searchSettings(index, sections, query);
}

const ids = (results: ReturnType<typeof search>) => results.map((result) => result.entry.id);

describe("settings registry", () => {
  test("every setting row belongs to a section the nav can show", () => {
    const sectionIds = new Set(SETTINGS_SECTION_META.map((section) => section.id));
    for (const [id, definition] of Object.entries(SETTING_DEFINITIONS)) {
      expect({ id, section: sectionIds.has(definition.section) }).toEqual({ id, section: true });
    }
  });

  test("a sub-option's parent is a setting in the same section", () => {
    const definitions: Record<string, { section: string; parent?: string }> = SETTING_DEFINITIONS;
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
    const result = search("anthropic").find((r) => r.entry.kind === "provider");
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
