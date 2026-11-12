import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { environmentArrowTarget, environmentOpenFocusTarget } from "./environmentPanelKeys";

const PANEL_HTML = `
  <div data-environment-column>
    <button role="radio" aria-checked="true" id="local">Local</button>
    <button role="radio" aria-checked="false" id="ssh">SSH</button>
    <button role="radio" aria-checked="false" id="coder" disabled>Coder</button>
  </div>
  <div data-environment-column>
    <button role="radio" aria-checked="false" id="none">None</button>
    <button role="radio" aria-checked="true" id="worktree">Worktree</button>
    <input id="image" value="" />
  </div>
  <div data-environment-column>
    <input role="combobox" id="filter" value="" />
  </div>
`;

describe("environment panel keys", () => {
  let originalDocument: typeof globalThis.document;
  let panel: HTMLElement;
  const el = (id: string): HTMLElement => {
    const found = panel.querySelector<HTMLElement>(`#${id}`);
    if (!found) throw new Error(`#${id} not in the panel`);
    return found;
  };

  beforeEach(() => {
    originalDocument = globalThis.document;
    const dom = new GlobalWindow();
    globalThis.document = dom.document as unknown as Document;
    panel = document.createElement("div");
    panel.innerHTML = PANEL_HTML;
    document.body.appendChild(panel);
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  test("Up and Down move between the enabled rows of a column and wrap", () => {
    expect(environmentArrowTarget(el("local"), panel, "ArrowDown")).toBe(el("ssh"));
    // Coder is disabled, so Down from SSH wraps to Local instead of landing on it.
    expect(environmentArrowTarget(el("ssh"), panel, "ArrowDown")).toBe(el("local"));
    expect(environmentArrowTarget(el("local"), panel, "ArrowUp")).toBe(el("ssh"));
  });

  test("Up and Down are left to a field", () => {
    expect(environmentArrowTarget(el("filter"), panel, "ArrowDown")).toBeNull();
  });

  test("Left and Right land on the neighbouring column's checked row", () => {
    expect(environmentArrowTarget(el("ssh"), panel, "ArrowRight")).toBe(el("worktree"));
    expect(environmentArrowTarget(el("none"), panel, "ArrowLeft")).toBe(el("local"));
  });

  test("a column with no rows takes focus on its filter", () => {
    expect(environmentArrowTarget(el("worktree"), panel, "ArrowRight")).toBe(el("filter"));
  });

  test("Left and Right stay in a field that holds text, and leave an empty one", () => {
    const filter = el("filter") as HTMLInputElement;
    expect(environmentArrowTarget(filter, panel, "ArrowLeft")).toBe(el("worktree"));
    filter.value = "ma";
    expect(environmentArrowTarget(filter, panel, "ArrowLeft")).toBeNull();
  });

  test("there is nothing past the first and last column, or outside a column", () => {
    expect(environmentArrowTarget(el("local"), panel, "ArrowLeft")).toBeNull();
    expect(environmentArrowTarget(el("filter"), panel, "ArrowRight")).toBeNull();
    expect(environmentArrowTarget(panel, panel, "ArrowDown")).toBeNull();
    expect(environmentArrowTarget(el("local"), panel, "Enter")).toBeNull();
  });

  test("opening focuses the invalid field, else the first checked row", () => {
    expect(environmentOpenFocusTarget(panel)).toBe(el("local"));
    el("image").setAttribute("aria-invalid", "true");
    expect(environmentOpenFocusTarget(panel)).toBe(el("image"));
    expect(environmentOpenFocusTarget(null)).toBeNull();
  });
});
