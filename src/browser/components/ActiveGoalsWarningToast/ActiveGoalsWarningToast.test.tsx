import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ActiveGoalsWarningToast } from "./ActiveGoalsWarningToast";

describe("ActiveGoalsWarningToast", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("fires once on a rising edge above three active goals", async () => {
    const { queryByRole, rerender } = render(<ActiveGoalsWarningToast activeGoalCount={3} />);

    expect(queryByRole("status")).toBeNull();

    rerender(<ActiveGoalsWarningToast activeGoalCount={4} />);
    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));

    rerender(<ActiveGoalsWarningToast activeGoalCount={5} />);
    expect(queryByRole("status")?.textContent).toContain("4 active goals");
  });

  test("re-arms after the active-goal count falls to three", async () => {
    const { queryByRole, rerender } = render(<ActiveGoalsWarningToast activeGoalCount={4} />);

    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));

    rerender(<ActiveGoalsWarningToast activeGoalCount={3} />);
    await waitFor(() => expect(queryByRole("status") === null).toBe(true));

    rerender(<ActiveGoalsWarningToast activeGoalCount={4} />);
    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));
  });

  test("announces warnings politely", async () => {
    const { getByRole } = render(<ActiveGoalsWarningToast activeGoalCount={4} />);

    await waitFor(() => expect(getByRole("status").getAttribute("aria-live")).toBe("polite"));
  });
});
