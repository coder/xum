// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { SETTINGS_SECTION_META } from "../settingsRegistry";
import type { SettingsSearchEntry, SettingsSearchResult } from "../settingsSearch";
import { SettingsSearchResults } from "./SettingsSearchResults";

const appearance = SETTINGS_SECTION_META.find((section) => section.id === "general");
const keybinds = SETTINGS_SECTION_META.find((section) => section.id === "keybinds");
if (!appearance || !keybinds) throw new Error("registry lost a section these tests use");

function result(
  entry: Partial<SettingsSearchEntry> & Pick<SettingsSearchEntry, "id" | "kind" | "label">,
  section = appearance!
): SettingsSearchResult {
  return { entry: { sectionId: section.id, ...entry }, section, score: 1 };
}

const sectionResult = result({ id: "section:general", kind: "section", label: "Appearance" });
const settingResult = result({
  id: "setting:theme",
  kind: "setting",
  label: "Theme",
  description: "Color theme for the whole app.",
});
const experimentResult = result({ id: "experiment:x", kind: "experiment", label: "Agent memory" });
const keybindResult = result(
  { id: "keybind:palette", kind: "keybind", label: "Open command palette", shortcut: "Ctrl+P" },
  keybinds
);

function renderResults(activeIndex = 0, query = "theme") {
  const onOpen = mock((_result: SettingsSearchResult) => undefined);
  const onHover = mock((_index: number) => undefined);
  const view = render(
    <SettingsSearchResults
      query={query}
      groups={[
        { section: appearance!, results: [sectionResult, settingResult, experimentResult] },
        { section: keybinds!, results: [keybindResult] },
      ]}
      activeIndex={activeIndex}
      onOpen={onOpen}
      onHover={onHover}
    />
  );
  const options = within(view.getByRole("listbox")).getAllByRole("option");
  return { view, options, onOpen, onHover };
}

describe("SettingsSearchResults", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("rows number across groups, so the keyboard index names the same row the DOM shows", () => {
    const { options } = renderResults(3);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "false",
      "true",
    ]);
    // The combobox points aria-activedescendant at these ids.
    expect(options[3]?.id).toBe("settings-search-result-3");
  });

  test("labels each kind of result and shows a keybind's shortcut", () => {
    const { options } = renderResults();
    expect(within(options[0]).getByText("Section")).toBeTruthy();
    expect(within(options[1]).queryByText("Section")).toBeNull();
    expect(within(options[2]).getByText("Experiment")).toBeTruthy();
    expect(options[3]?.querySelector("kbd")?.textContent).toBe("Ctrl+P");
    expect(options[1]?.querySelector("kbd")).toBeNull();
  });

  test("highlights the query in the label and description", () => {
    const { options } = renderResults(0, "theme");
    const marks = [...(options[1]?.querySelectorAll("mark") ?? [])].map((m) => m.textContent);
    expect(marks).toEqual(["Theme", "theme"]);
  });

  test("clicking opens the row's result; hovering moves the active row only when it changes", () => {
    const { options, onOpen, onHover } = renderResults(1);
    fireEvent.click(options[2]);
    expect(onOpen).toHaveBeenCalledWith(experimentResult);

    fireEvent.mouseMove(options[1]);
    expect(onHover).not.toHaveBeenCalled();
    fireEvent.mouseMove(options[3]);
    expect(onHover).toHaveBeenCalledWith(3);
  });

  test("with no results the listbox stays (empty) and the status names the query", () => {
    const view = render(
      <SettingsSearchResults
        query="  zzz "
        groups={[]}
        activeIndex={0}
        onOpen={() => undefined}
        onHover={() => undefined}
      />
    );
    expect(within(view.getByRole("listbox")).queryAllByRole("option")).toEqual([]);
    expect(view.getByRole("status").textContent).toContain("“zzz”");
  });
});
