import { describe, expect, test } from "bun:test";
import { filterCommandsByPrefix } from "@/browser/utils/commandPaletteFiltering";
import { CommandIds, CommandIdMatchers } from "@/browser/utils/commandIds";
import { rankByPaletteQuery } from "@/browser/utils/commandPaletteRanking";

/**
 * Tests for command palette filtering logic
 * Property-based tests that verify behavior regardless of specific command data
 */

describe("CommandPalette filtering", () => {
  describe("property: default mode shows only ws:switch:* commands", () => {
    test("all results start with ws:switch:", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceSwitch("2") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.navToggleSidebar() },
      ];

      const result = filterCommandsByPrefix("", actions);

      expect(result.every((a) => CommandIdMatchers.isWorkspaceSwitch(a.id))).toBe(true);
    });

    test("excludes all non-switching commands", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.workspaceRemove() },
        { id: CommandIds.navToggleSidebar() },
      ];

      const result = filterCommandsByPrefix("", actions);

      expect(result.some((a) => !CommandIdMatchers.isWorkspaceSwitch(a.id))).toBe(false);
    });
  });

  describe("property: > mode shows all EXCEPT ws:switch:* commands", () => {
    test("no results start with ws:switch:", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.navToggleSidebar() },
        { id: CommandIds.chatClear() },
      ];

      const result = filterCommandsByPrefix(">", actions);

      expect(result.every((a) => !CommandIdMatchers.isWorkspaceSwitch(a.id))).toBe(true);
    });

    test("includes all non-switching commands", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.workspaceRemove() },
        { id: CommandIds.navToggleSidebar() },
      ];

      const result = filterCommandsByPrefix(">", actions);

      // Should include workspace mutations
      expect(result.some((a) => a.id === CommandIds.workspaceNew())).toBe(true);
      expect(result.some((a) => a.id === CommandIds.workspaceRemove())).toBe(true);
      // Should include navigation
      expect(result.some((a) => a.id === CommandIds.navToggleSidebar())).toBe(true);
      // Should NOT include switching
      expect(result.some((a) => a.id === CommandIds.workspaceSwitch("1"))).toBe(false);
    });
  });

  describe("property: modes partition the command space", () => {
    test("default + > modes cover all commands (no overlap, no gaps)", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceSwitch("2") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.workspaceRemove() },
        { id: CommandIds.navToggleSidebar() },
        { id: CommandIds.chatClear() },
      ];

      const defaultResult = filterCommandsByPrefix("", actions);
      const commandResult = filterCommandsByPrefix(">", actions);

      // No overlap - disjoint sets
      const defaultIds = new Set(defaultResult.map((a) => a.id));
      const commandIds = new Set(commandResult.map((a) => a.id));
      const intersection = [...defaultIds].filter((id) => commandIds.has(id));
      expect(intersection).toHaveLength(0);

      // No gaps - covers everything
      expect(defaultResult.length + commandResult.length).toBe(actions.length);
    });
  });

  describe("property: / prefix always returns empty", () => {
    test("returns empty array regardless of actions", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.navToggleSidebar() },
      ];

      expect(filterCommandsByPrefix("/", actions)).toHaveLength(0);
      expect(filterCommandsByPrefix("/help", actions)).toHaveLength(0);
      expect(filterCommandsByPrefix("/ ", actions)).toHaveLength(0);
    });
  });

  describe("property: query with > prefix applies to all non-switching", () => {
    test(">text shows same set as > (cmdk filters further)", () => {
      const actions = [
        { id: CommandIds.workspaceSwitch("1") },
        { id: CommandIds.workspaceNew() },
        { id: CommandIds.navToggleSidebar() },
      ];

      // Our filter doesn't care about text after >, just the prefix
      const resultEmpty = filterCommandsByPrefix(">", actions);
      const resultWithText = filterCommandsByPrefix(">abc", actions);

      expect(resultEmpty).toEqual(resultWithText);
    });
  });
});

describe("CommandPalette ranking", () => {
  test("no-prefix query ranks exact workspace name above weaker match", () => {
    const workspaces = [
      { id: "ws:switch:my-app", title: "my-app", section: "Workspaces" },
      { id: "ws:switch:my-app-legacy", title: "my-app-legacy", section: "Workspaces" },
      { id: "ws:switch:some-project", title: "some-project", section: "Workspaces" },
    ];

    const result = rankByPaletteQuery({
      items: workspaces,
      query: "my-app",
      toSearchDoc: (workspace) => ({ primaryText: workspace.title }),
      tieBreak: (a, b) => a.title.localeCompare(b.title),
    });

    expect(result[0]?.title).toBe("my-app");
  });

  test(">output ranks Show Output above false positives", () => {
    const commands = [
      {
        id: "nav:output",
        title: "Show Output",
        section: "Navigation",
        keywords: ["output", "panel"],
      },
      { id: "ws:new", title: "New Workspace", section: "Workspaces", keywords: ["create"] },
      { id: "layout:toggle", title: "Toggle Layout", section: "Appearance", keywords: [] },
    ];

    const result = rankByPaletteQuery({
      items: commands,
      query: "output",
      toSearchDoc: (command) => ({
        primaryText: command.title,
        secondaryText: command.keywords,
      }),
      tieBreak: (a, b) => a.title.localeCompare(b.title),
    });

    expect(result[0]?.title).toBe("Show Output");
    expect(result.some((command) => command.title === "Toggle Layout")).toBe(false);
  });

  test("workspace with long metadata still ranks exact title first", () => {
    const workspaces = [
      {
        id: "ws:switch:my-app",
        title: "my-app",
        section: "Workspaces",
        keywords: ["my-app", "my-project", "/home/user/very/long/path/to/project/my-app"],
      },
      {
        id: "ws:switch:my-app-legacy",
        title: "my-app-legacy",
        section: "Workspaces",
        keywords: ["my-app-legacy", "other-project"],
      },
    ];

    const result = rankByPaletteQuery({
      items: workspaces,
      query: "my-app",
      toSearchDoc: (workspace) => ({
        primaryText: workspace.title,
        secondaryText: workspace.keywords,
      }),
      tieBreak: (a, b) => a.title.localeCompare(b.title),
    });

    expect(result[0]?.title).toBe("my-app");
  });
});
