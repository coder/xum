// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ArtifactPinMenu } from "./ArtifactPinMenu";

afterEach(() => {
  cleanup();
});

function openMenu(projectShelfAvailable = true) {
  const onPin = mock(() => undefined);
  const view = render(
    <ArtifactPinMenu onPin={onPin} projectShelfAvailable={projectShelfAvailable} />
  );
  const trigger = view.getByRole("button", { name: "Pin to shelf" });
  fireEvent.click(trigger);
  return { view, trigger, onPin, menu: view.getByRole("menu", { name: "Pin to shelf" }) };
}

describe("ArtifactPinMenu", () => {
  test("the arrow keys stop at the first and last entry", () => {
    const { menu } = openMenu();
    const project = within(menu).getByRole("menuitem", { name: "Pin to project shelf" });
    const global = within(menu).getByRole("menuitem", { name: "Pin to global shelf" });
    expect(document.activeElement).toBe(project);
    fireEvent.keyDown(project, { key: "ArrowUp" });
    expect(document.activeElement).toBe(project);
    fireEvent.keyDown(project, { key: "ArrowDown" });
    fireEvent.keyDown(global, { key: "ArrowDown" });
    expect(document.activeElement).toBe(global);
  });

  test("Escape closes the menu, returns focus to its button and pins nothing", () => {
    const { view, trigger, menu, onPin } = openMenu();
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0], { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onPin).not.toHaveBeenCalled();
  });

  test("a click outside closes the menu, and a click inside it does not", () => {
    const { view, menu, onPin } = openMenu();
    fireEvent.mouseDown(menu);
    expect(view.queryByRole("menu")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(view.queryByRole("menu")).toBeNull();
    expect(onPin).not.toHaveBeenCalled();
  });

  test("a workspace with no project shelf offers only the global pin", () => {
    const { menu, onPin } = openMenu(false);
    expect(within(menu).queryByRole("menuitem", { name: "Pin to project shelf" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin to global shelf" }));
    expect(onPin).toHaveBeenCalledWith("global");
  });
});
