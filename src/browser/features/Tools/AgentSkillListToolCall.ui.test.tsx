import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import {
  AgentSkillListToolCall,
  groupSkillsByScope,
  toSkillListView,
} from "./AgentSkillListToolCall";

const skill = (
  name: string,
  scope: AgentSkillDescriptor["scope"],
  extra: Partial<AgentSkillDescriptor> = {}
): AgentSkillDescriptor => ({ name, scope, description: `${name} description`, ...extra });

describe("groupSkillsByScope", () => {
  test("orders groups project → global → built-in regardless of input order", () => {
    const groups = groupSkillsByScope([
      skill("z-builtin", "built-in"),
      skill("a-global", "global"),
      skill("m-project", "project"),
    ]);
    expect(groups.map((group) => group.scope)).toEqual(["project", "global", "built-in"]);
  });

  test("drops empty scopes and keeps every skill in its group", () => {
    const groups = groupSkillsByScope([
      skill("one", "project"),
      skill("two", "project"),
      skill("three", "built-in"),
    ]);
    expect(groups.map((group) => group.scope)).toEqual(["project", "built-in"]);
    expect(groups[0].skills.map((skillItem) => skillItem.name)).toEqual(["one", "two"]);
    expect(groups[1].skills).toHaveLength(1);
  });

  test("returns nothing for an empty list", () => {
    expect(groupSkillsByScope([])).toEqual([]);
  });
});

describe("toSkillListView", () => {
  test("returns the skills from a success result", () => {
    const view = toSkillListView({ success: true, skills: [skill("a", "project")] });
    expect(view).toEqual({ kind: "skills", skills: [skill("a", "project")] });
  });

  test("filters malformed skill entries instead of blanking the whole list (self-healing)", () => {
    const view = toSkillListView({
      success: true,
      skills: [
        skill("valid-one", "project"),
        { name: "Has Spaces", scope: "project", description: "bad name" },
        { name: "bad-scope", scope: "nope", description: "x" },
      ],
    });
    expect(view.kind).toBe("skills");
    expect(view.kind === "skills" && view.skills.map((s) => s.name)).toEqual(["valid-one"]);
  });

  test("surfaces the thrown { success: false, error } shape", () => {
    expect(toSkillListView({ success: false, error: "EACCES" })).toEqual({
      kind: "error",
      error: "EACCES",
    });
  });

  test("surfaces a nested { error } shape with no success flag (code_execution/PTC)", () => {
    expect(toSkillListView({ error: "directory unreadable" })).toEqual({
      kind: "error",
      error: "directory unreadable",
    });
  });

  test("unwraps the SDK JSON container before parsing", () => {
    const view = toSkillListView({
      type: "json",
      value: { success: true, skills: [skill("from-container", "global")] },
    });
    expect(view.kind === "skills" && view.skills.map((s) => s.name)).toEqual(["from-container"]);
  });

  test("returns none for pending / unrecognized output", () => {
    expect(toSkillListView(undefined)).toEqual({ kind: "none" });
    expect(toSkillListView({ unexpected: "shape" })).toEqual({ kind: "none" });
  });
});

const TEST_WORKSPACE_ID = "agent-skill-list-test";

// ToolIcon renders a Radix Tooltip which requires a TooltipProvider and contexts.
function renderWithProviders(ui: ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="agent_skill_list">
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

describe("AgentSkillListToolCall", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("expanded card groups skills under scope labels", () => {
    const view = renderWithProviders(
      <AgentSkillListToolCall
        args={{ includeUnadvertised: false }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          skills: [skill("agent-browser", "project"), skill("pdf", "built-in")],
        }}
      />
    );
    // Scope group headers render only for scopes that have skills.
    expect(view.queryByText("Project")).not.toBeNull();
    expect(view.queryByText("Built-in")).not.toBeNull();
    expect(view.queryByText("Global")).toBeNull();
    expect(view.queryByText("agent-browser")).not.toBeNull();
  });

  test("a skill row reveals its invoke hint only after it is expanded", () => {
    const view = renderWithProviders(
      <AgentSkillListToolCall
        args={{ includeUnadvertised: true }}
        status="completed"
        defaultExpanded
        result={{
          success: true,
          skills: [skill("orchestrator", "project", { advertise: false })],
        }}
      />
    );
    // The unadvertised warning + invoke hint live inside the per-row disclosure.
    expect(view.queryByText(/Hidden from the skill index/)).toBeNull();

    const nameNode = view.getByText("orchestrator");
    const rowButton = nameNode.closest("button");
    expect(rowButton).not.toBeNull();
    fireEvent.click(rowButton!);

    expect(view.queryByText(/Hidden from the skill index/)).not.toBeNull();
    expect(view.queryByText("agent_skill_read")).not.toBeNull();
  });

  test("renders the shared error box and no skills box for a failed result", () => {
    const view = renderWithProviders(
      <AgentSkillListToolCall
        args={{ includeUnadvertised: false }}
        status="failed"
        defaultExpanded
        result={{ success: false, error: "Skills directory is unreadable: EACCES .mux/skills" }}
      />
    );
    expect(view.queryByText("Skills directory is unreadable: EACCES .mux/skills")).not.toBeNull();
    // No scope groups when the call failed.
    expect(view.queryByText("Project")).toBeNull();
  });

  test("distinguishes the empty state by whether unadvertised skills were requested", () => {
    const advertisedOnly = renderWithProviders(
      <AgentSkillListToolCall
        args={{ includeUnadvertised: false }}
        status="completed"
        defaultExpanded
        result={{ success: true, skills: [] }}
      />
    );
    expect(advertisedOnly.queryByText(/No advertised skills are available/)).not.toBeNull();
    cleanup();

    const allSkills = renderWithProviders(
      <AgentSkillListToolCall
        args={{ includeUnadvertised: true }}
        status="completed"
        defaultExpanded
        result={{ success: true, skills: [] }}
      />
    );
    expect(allSkills.queryByText("No skills are available in this workspace.")).not.toBeNull();
  });
});
