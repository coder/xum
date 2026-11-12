/**
 * Keyboard movement inside the creation page's environment panel. The panel marks each column
 * with `data-environment-column`; its option rows are radios and the branch filter is a combobox.
 * Kept apart from the component so the movement rules are tested on plain DOM.
 */
const COLUMN_SELECTOR = "[data-environment-column]";
const ROW_SELECTOR = '[role="radio"]:not(:disabled)';
const CHECKED_ROW_SELECTOR = '[role="radio"][aria-checked="true"]:not(:disabled)';

/** The row an Up/Down key moves to within a column; null from anything but a row. */
function verticalTarget(target: Element, column: Element, key: string): HTMLElement | null {
  // Inputs keep their own arrows (the branch filter moves its active row).
  if (target.getAttribute("role") !== "radio") return null;
  const rows = Array.from(column.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const next = rows.findIndex((row) => row === target) + (key === "ArrowDown" ? 1 : -1);
  return rows[(next + rows.length) % rows.length] ?? null;
}

/** Whether the element is a text field that still holds text. */
function holdsText(target: Element): boolean {
  return "value" in target && typeof target.value === "string" && target.value !== "";
}

/** The control a Left/Right key moves to in the neighbouring column. */
function horizontalTarget(
  target: Element,
  column: Element,
  panel: Element,
  key: string
): HTMLElement | null {
  // Left/Right move the caret while a field has text; they change column only from an empty one.
  if (holdsText(target)) return null;
  const columns = Array.from(panel.querySelectorAll(COLUMN_SELECTOR));
  const neighbor = columns[columns.indexOf(column) + (key === "ArrowRight" ? 1 : -1)];
  if (!neighbor) return null;
  return (
    neighbor.querySelector<HTMLElement>(CHECKED_ROW_SELECTOR) ??
    neighbor.querySelector<HTMLElement>(`${ROW_SELECTOR}, [role="combobox"]`)
  );
}

/** Where an arrow key moves focus inside the panel, or null when the key is not the panel's. */
export function environmentArrowTarget(
  target: Element,
  panel: Element,
  key: string
): HTMLElement | null {
  const column = target.closest(COLUMN_SELECTOR);
  if (!column) return null;
  if (key === "ArrowUp" || key === "ArrowDown") return verticalTarget(target, column, key);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return horizontalTarget(target, column, panel, key);
  }
  return null;
}

/**
 * What takes focus when the panel opens: the field a refused Send is waiting for, else the
 * selected "Run on" row.
 */
export function environmentOpenFocusTarget(panel: Element | null): HTMLElement | null {
  if (!panel) return null;
  return (
    panel.querySelector<HTMLElement>('[aria-invalid="true"]') ??
    panel.querySelector<HTMLElement>(CHECKED_ROW_SELECTOR)
  );
}
