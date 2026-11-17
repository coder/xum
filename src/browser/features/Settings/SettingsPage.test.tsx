import { describe, expect, test } from "bun:test";

import { getSettingsSectionRedirect, getSettingsSections, isMobileListOpen } from "./SettingsPage";

describe("SettingsPage", () => {
  test("phones keep the list/section pick only on the section it was made on", () => {
    // Plain open lands on the list; a deep link on its section.
    expect(isMobileListOpen(null, "general", true)).toBe(true);
    expect(isMobileListOpen(null, "providers", false)).toBe(false);
    // Picking Providers from the list, then browser Back to the sectionless entry: the list again.
    const picked = { view: "section" as const, section: "providers" };
    expect(isMobileListOpen(picked, "providers", false)).toBe(false);
    expect(isMobileListOpen(picked, "general", true)).toBe(true);
    // The back button on the open section shows the list over it.
    expect(isMobileListOpen({ view: "list", section: "providers" }, "providers", false)).toBe(true);
    // Choosing the section the plain open already shows still leaves the list.
    expect(isMobileListOpen({ view: "section", section: "general" }, "general", true)).toBe(false);
  });

  test("keeps Goals out of settings navigation", () => {
    const ids = getSettingsSections(true).map((section) => section.id);

    expect(ids).not.toContain("goals");
    expect(ids).toContain("experiments");
  });

  test("normalizes stale Goals routes to Experiments with replace navigation", () => {
    expect(getSettingsSectionRedirect("goals", true)).toEqual({
      section: "experiments",
      replace: true,
    });
  });

  test("every section in the registry has a component, gated ones included", () => {
    expect(() => getSettingsSections(true, true)).not.toThrow();
  });

  test("keeps the existing route ids so old deep links still open their section", () => {
    const ids = getSettingsSections(true, true).map((section) => section.id);
    for (const id of ["general", "tasks", "runtimes", "security", "server-access", "providers"]) {
      expect(ids).toContain(id);
      expect(getSettingsSectionRedirect(id, true, true)).toBeNull();
    }
  });

  test.each(["governor", "layouts"])("replaces the removed %s route with General", (section) => {
    expect(getSettingsSectionRedirect(section, false)).toEqual({
      section: "general",
      replace: true,
    });
  });

  test("always shows Heartbeats after Agents without redirecting its route", () => {
    const ids = getSettingsSections(false).map((section) => section.id);
    expect(ids.indexOf("heartbeat")).toBe(ids.indexOf("tasks") + 1);
    expect(getSettingsSectionRedirect("heartbeat", false)).toBeNull();
  });

  test("shows the Memory section only while the memory experiment is enabled", () => {
    expect(getSettingsSections(true).map((section) => section.id)).toContain("memory");
    expect(getSettingsSections(false).map((section) => section.id)).not.toContain("memory");
  });

  test("redirects the memory route away while the memory experiment is disabled", () => {
    expect(getSettingsSectionRedirect("memory", false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("memory", true)).toBeNull();
  });

  test("always shows the Plugins section next to MCP", () => {
    const ids = getSettingsSections(false).map((section) => section.id);
    expect(ids.indexOf("plugins")).toBe(ids.indexOf("mcp") + 1);
    expect(getSettingsSectionRedirect("plugins", false)).toBeNull();
  });

  test("shows Remote Connection only when the desktop bridge is available", () => {
    expect(getSettingsSections(false, true).map((section) => section.id)).toContain(
      "remote-connection"
    );
    expect(getSettingsSections(true, false).map((section) => section.id)).not.toContain(
      "remote-connection"
    );
  });

  test("redirects an unavailable Remote Connection deep link to General", () => {
    expect(getSettingsSectionRedirect("remote-connection", true, false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("remote-connection", false, true)).toBeNull();
  });

  test("always shows the Backup section", () => {
    expect(getSettingsSections(false).map((section) => section.id)).toContain("backup");
    expect(getSettingsSections(true).map((section) => section.id)).toContain("backup");
    expect(getSettingsSectionRedirect("backup", false)).toBeNull();
  });
});
