import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installDom } from "../../../../tests/ui/dom";
import { FilterList } from "./FilterList";

const BRANCHES = ["main", "develop", "feat/dev-tools", "release"].map((name) => ({
  value: name,
  label: name,
}));

describe("FilterList", () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  function renderList(selected: string | null = "main") {
    const onSelect = mock((_value: string) => undefined);
    const view = render(
      <FilterList
        items={BRANCHES}
        selected={selected}
        onSelect={onSelect}
        label="Select source branch"
        placeholder="Filter branches…"
        noun="branches"
      />
    );
    const input = view.getByRole("combobox") as HTMLInputElement;
    const options = () => view.queryAllByRole("option").map((option) => option.textContent);
    // user-event drives the input the way a keyboard does; fireEvent on an input does not reach
    // React's handlers in happy-dom.
    const user = userEvent.setup({ document: input.ownerDocument });
    return { view, input, options, onSelect, user };
  }

  test("typing narrows the rows to the matches", async () => {
    const { input, options, user } = renderList();
    await user.type(input, "dev");
    expect(options()).toEqual(["develop", "feat/dev-tools"]);
  });

  test("Enter confirms the selected row until an arrow moves off it", async () => {
    const { input, onSelect, user } = renderList("develop");
    await user.type(input, "{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("develop");

    await user.type(input, "{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("feat/dev-tools");
  });

  test("the arrows wrap around the list", async () => {
    const { input, onSelect, user } = renderList("main");
    await user.type(input, "{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("release");
  });

  test("a new filter drops the arrow position: Enter takes the first match", async () => {
    const { input, onSelect, user } = renderList("main");
    await user.type(input, "{ArrowDown}rel{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("release");
  });

  test("a click picks the row without taking focus from the filter", () => {
    const { view, input, onSelect } = renderList();
    input.focus();
    const row = view.getByRole("option", { name: "release" });
    // The row cancels mouse down, which is what keeps focus in the input.
    expect(fireEvent.mouseDown(row)).toBe(false);
    fireEvent.click(row);
    expect(onSelect).toHaveBeenLastCalledWith("release");
    expect(document.activeElement).toBe(input);
  });

  test("no match says so and Enter picks nothing", async () => {
    const { view, input, onSelect, user } = renderList();
    await user.type(input, "hotfix{Enter}");
    expect(view.getByRole("status").textContent).toBe('No branches match "hotfix"');
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("only the selected row is marked selected", () => {
    const { view } = renderList("develop");
    const selected = view
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-selected") === "true")
      .map((option) => option.textContent);
    expect(selected).toEqual(["develop"]);
  });

  describe("rows with a path, a tag, an aside and a separator", () => {
    const PROJECTS = [
      { value: "/src/coder", label: "coder", detail: "/src/coder", badge: "pinned" },
      { value: "/src/docs", label: "docs", detail: "/src/docs" },
      { value: "scratch", label: "Scratch", aside: "No project", divider: true },
    ];

    function renderProjects() {
      const view = render(
        <FilterList
          items={PROJECTS}
          selected="/src/coder"
          onSelect={() => undefined}
          label="Select project"
          placeholder="Find a project…"
          noun="projects"
          twoLine
          footer={<button type="button">Add project…</button>}
        />
      );
      const input = view.getByRole("combobox") as HTMLInputElement;
      const labels = () =>
        Array.from(view.container.querySelectorAll("[data-filter-list-label]")).map(
          (label) => label.textContent
        );
      const separators = () =>
        view.container.querySelectorAll('[role="listbox"] [role="presentation"]');
      return {
        view,
        input,
        labels,
        separators,
        user: userEvent.setup({ document: input.ownerDocument }),
      };
    }

    test("the path is searched; the tag and the aside are not", async () => {
      const { input, labels, user } = renderProjects();
      await user.type(input, "/src/d");
      expect(labels()).toEqual(["docs"]);
      await user.clear(input);
      await user.type(input, "pinned");
      expect(labels()).toEqual([]);
      await user.clear(input);
      await user.type(input, "no project");
      expect(labels()).toEqual([]);
    });

    test("the separator is drawn between rows, never above the first one shown", async () => {
      const { input, labels, separators, user } = renderProjects();
      expect(separators().length).toBe(1);
      await user.type(input, "scr");
      expect(labels()).toEqual(["Scratch"]);
      expect(separators().length).toBe(0);
    });

    test("the footer action stays when the filter matches nothing", async () => {
      const { view, input, user } = renderProjects();
      await user.type(input, "zzz");
      expect(view.queryAllByRole("option")).toEqual([]);
      expect(view.getByRole("button", { name: "Add project…" })).toBeTruthy();
    });
  });
});
