import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { AvailableWorkflow } from "@/common/types/workflow";

import { WorkflowEmptyState } from "./WorkflowEmptyState";

function makeWorkflowWithInput(): AvailableWorkflow {
  return {
    descriptor: {
      name: "echo-input",
      description: "Echo structured input",
      scope: "project",
      executable: true,
    },
    scriptPath: "skill://echo-input/workflow.js",
    args: [{ name: "input", types: ["string"], required: true }],
  };
}

describe("WorkflowEmptyState", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("submits text input fields as structured args without tokenizing flag-like prose", async () => {
    const onRun = mock(() => undefined);
    const rendered = render(
      <WorkflowEmptyState scripts={[makeWorkflowWithInput()]} busyScriptPath={null} onRun={onRun} />
    );
    const user = userEvent.setup({ document: rendered.container.ownerDocument });

    fireEvent.click(rendered.getByRole("button", { name: "Run" }));
    await user.type(rendered.getByRole("textbox"), "quoted markdown: I'm testing --not-a-flag");
    await waitFor(() => {
      expect((rendered.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(
        false
      );
    });
    fireEvent.click(rendered.getByRole("button", { name: "Start" }));

    expect(onRun).toHaveBeenCalledWith(makeWorkflowWithInput(), {
      input: "quoted markdown: I'm testing --not-a-flag",
    });
  });
});
