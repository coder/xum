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
});
