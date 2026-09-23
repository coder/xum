import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { SubAgentChildTrunk, SubAgentListItem } from "./SubAgentListItem";

function renderItem(props?: Partial<Parameters<typeof SubAgentListItem>[0]>) {
  return render(
    <SubAgentListItem
      connectorPosition="single"
      sharedTrunkActiveThroughRow={false}
      sharedTrunkActiveBelowRow={false}
      ancestorTrunks={[]}
      connectorRailX={18}
      childStatusCenterX={26}
      isSelected={false}
      {...props}
    >
      <div>row</div>
    </SubAgentListItem>
  );
}

describe("SubAgentListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("draws the elbow from the parent rail into the child status center", () => {
    const view = renderItem();

    const trunk = view.getByTestId("subagent-connector-trunk");
    const elbow = view.getByTestId("subagent-connector-elbow");

    expect(trunk.getAttribute("style")).toContain("left: 18px");
    expect(elbow.getAttribute("style")).toContain("left: 18px");
    expect(elbow.getAttribute("style")).toContain("width: 8px");
    expect(elbow.getAttribute("class")).toContain("border-l");
  });

  test("supports connector elbows that bend back to the left", () => {
    const view = renderItem({ connectorRailX: 30, childStatusCenterX: 26 });

    const elbow = view.getByTestId("subagent-connector-elbow");

    expect(elbow.getAttribute("style")).toContain("left: 26px");
    expect(elbow.getAttribute("style")).toContain("width: 4px");
    expect(elbow.getAttribute("class")).toContain("border-r");
  });

  test("last child ends the trunk where the elbow curve begins", () => {
    const view = renderItem({ connectorPosition: "last" });

    const trunk = view.getByTestId("subagent-connector-trunk");

    expect(trunk.getAttribute("class")).toContain("top-0");
    expect(trunk.getAttribute("class")).not.toContain("inset-y-0");
    expect(trunk.getAttribute("style")).toContain("bottom: calc(50% + 6px)");
  });

  test("middle rows render one uninterrupted full-height trunk", () => {
    const view = renderItem({
      connectorPosition: "middle",
      sharedTrunkActiveThroughRow: true,
      sharedTrunkActiveBelowRow: true,
    });

    const trunk = view.getByTestId("subagent-connector-trunk");

    expect(trunk.getAttribute("class")).toContain("inset-y-0");
    expect(trunk.getAttribute("style")).not.toContain("bottom:");
    expect(trunk.getAttribute("class")).toContain("subagent-connector-active");
    expect(view.queryByTestId("subagent-connector-pass-through")).toBeNull();
  });

  test("ends activity at the lowest running middle child without breaking the rail", () => {
    const view = renderItem({
      connectorPosition: "middle",
      sharedTrunkActiveThroughRow: true,
      sharedTrunkActiveBelowRow: false,
    });
    const upper = view.getByTestId("subagent-connector-trunk");
    const lower = view.getByTestId("subagent-connector-inactive-tail");
    expect(upper.style.bottom).toBe("50%");
    expect(upper.classList.contains("subagent-connector-active")).toBe(true);
    expect(lower.classList.contains("subagent-connector-active")).toBe(false);
    expect(lower.classList.contains("top-1/2")).toBe(true);
    expect(lower.classList.contains("bottom-0")).toBe(true);
    expect(lower.style.left).toBe(upper.style.left);
  });

  test("inactive trunks render solid", () => {
    const view = renderItem({ connectorPosition: "middle" });

    const trunk = view.getByTestId("subagent-connector-trunk");

    expect(trunk.getAttribute("class")).not.toContain("subagent-connector-active");
  });

  test("renders the child trunk stub when this row parents visible sub-agents", () => {
    const view = renderItem({ childTrunk: { left: 26, active: true } });

    const stub = view.getByTestId("subagent-child-trunk");

    expect(stub.getAttribute("style")).toContain("left: 26px");
    expect(stub.getAttribute("class")).toContain("top-1/2");
    expect(stub.getAttribute("class")).toContain("bottom-0");
    expect(stub.getAttribute("class")).toContain("subagent-connector-active");
  });

  test("omits the child trunk stub for leaf rows", () => {
    const view = renderItem();

    expect(view.queryByTestId("subagent-child-trunk")).toBeNull();
  });
});

describe("SubAgentChildTrunk", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("spans from the row center to the row bottom at the shared rail", () => {
    const view = render(<SubAgentChildTrunk left={18} active={false} isSelected={false} />);

    const stub = view.getByTestId("subagent-child-trunk");

    expect(stub.getAttribute("style")).toContain("left: 18px");
    expect(stub.getAttribute("class")).toContain("top-1/2");
    expect(stub.getAttribute("class")).toContain("bottom-0");
    expect(stub.getAttribute("class")).not.toContain("subagent-connector-active");
  });
});
