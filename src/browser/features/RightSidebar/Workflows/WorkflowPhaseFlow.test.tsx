import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { WorkflowPhaseManifest } from "@/common/types/workflow";

import {
  WorkflowPhaseFlow,
  phaseFlowNodesFromManifest,
  phaseFlowNodesFromView,
  type WorkflowPhaseFlowNode,
} from "./WorkflowPhaseFlow";
import type { WorkflowPhaseView } from "./projectWorkflowRun";

const MANIFEST: WorkflowPhaseManifest = {
  provenance: "declared",
  phases: [
    { name: "scope", label: "Scope", description: "Pick angles" },
    { name: "verify", parallel: true },
  ],
};

function phaseView(overrides: Partial<WorkflowPhaseView>): WorkflowPhaseView {
  return {
    name: "scope",
    label: "Scope",
    steps: [],
    done: 0,
    total: 0,
    running: false,
    failed: false,
    lifecycle: "pending",
    ...overrides,
  };
}

describe("WorkflowPhaseFlow", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders every node in order with a fan-out badge for parallel phases", () => {
    const rendered = render(
      <WorkflowPhaseFlow nodes={phaseFlowNodesFromManifest(MANIFEST)} provenance="declared" />
    );
    const items = rendered.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Scope", "verify"]);
    expect(rendered.getByLabelText("Fan-out phase")).toBeTruthy();
    // Declared rails carry no provenance hint.
    expect(rendered.queryByText("inferred")).toBeNull();
  });

  test("inferred rails show the provenance hint", () => {
    const rendered = render(
      <WorkflowPhaseFlow
        nodes={[{ name: "a", label: "a", lifecycle: "not-visited" }]}
        provenance="inferred"
      />
    );
    expect(rendered.getByText("inferred")).toBeTruthy();
  });

  test("nodes are buttons only when a phase-select handler exists, and clicking selects", () => {
    const onSelect = mock(() => undefined);
    const nodes: WorkflowPhaseFlowNode[] = [
      { name: "scope", label: "Scope", lifecycle: "completed" },
    ];
    const withHandler = render(
      <WorkflowPhaseFlow nodes={nodes} provenance="declared" onPhaseSelect={onSelect} />
    );
    fireEvent.click(withHandler.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("scope");
    cleanup();

    const withoutHandler = render(<WorkflowPhaseFlow nodes={nodes} provenance="declared" />);
    expect(withoutHandler.queryByRole("button")).toBeNull();
  });

  test("renders nothing for an empty node list", () => {
    const rendered = render(<WorkflowPhaseFlow nodes={[]} provenance="declared" />);
    expect(rendered.container.textContent).toBe("");
  });

  test("phaseFlowNodesFromView drops the implicit ungrouped bucket and keeps lifecycle metadata", () => {
    const nodes = phaseFlowNodesFromView([
      phaseView({ name: "", label: "Other steps", lifecycle: "completed" }),
      phaseView({ name: "verify", label: "verify", lifecycle: "running", parallel: true }),
      phaseView({ name: "synthesize", label: "synthesize", lifecycle: "skipped" }),
    ]);
    expect(nodes).toEqual([
      { name: "verify", label: "verify", lifecycle: "running", parallel: true },
      { name: "synthesize", label: "synthesize", lifecycle: "skipped" },
    ]);
  });
});
