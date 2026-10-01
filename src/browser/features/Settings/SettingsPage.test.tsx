import { describe, expect, test } from "bun:test";

import { getSettingsSectionRedirect, getSettingsSections } from "./SettingsPage";

describe("SettingsPage", () => {
  test("keeps Goals out of settings navigation", () => {
    const labels = getSettingsSections(true, true).map((section) => section.label);

    expect(labels).not.toContain("Goals");
    expect(labels).toContain("Experiments");
  });

  test("normalizes stale Goals routes to Experiments with replace navigation", () => {
    expect(getSettingsSectionRedirect("goals", true, true)).toEqual({
      section: "experiments",
      replace: true,
    });
  });

  test("always shows Heartbeats after Agents without redirecting its route", () => {
    const ids = getSettingsSections(false, false).map((section) => section.id);
    expect(ids.indexOf("heartbeat")).toBe(ids.indexOf("tasks") + 1);
    expect(getSettingsSectionRedirect("heartbeat", false, false)).toBeNull();
  });

  test("shows the Memory section only while the memory experiment is enabled", () => {
    expect(getSettingsSections(false, true).map((section) => section.id)).toContain("memory");
    expect(getSettingsSections(false, false).map((section) => section.id)).not.toContain("memory");
  });

  test("redirects the memory route away while the memory experiment is disabled", () => {
    expect(getSettingsSectionRedirect("memory", false, false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("memory", false, true)).toBeNull();
  });

  test("always shows the Plugins section next to MCP", () => {
    const ids = getSettingsSections(false, false).map((section) => section.id);
    expect(ids.indexOf("plugins")).toBe(ids.indexOf("mcp") + 1);
    expect(getSettingsSectionRedirect("plugins", false, false)).toBeNull();
  });

  test("shows Remote Connection only when the desktop bridge is available", () => {
    expect(getSettingsSections(false, false, true).map((section) => section.id)).toContain(
      "remote-connection"
    );
    expect(getSettingsSections(true, true, false).map((section) => section.id)).not.toContain(
      "remote-connection"
    );
  });

  test("redirects an unavailable Remote Connection deep link to General", () => {
    expect(getSettingsSectionRedirect("remote-connection", true, true, false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("remote-connection", false, false, true)).toBeNull();
  });

  test("always shows the Backup section", () => {
    expect(getSettingsSections(false, false).map((section) => section.id)).toContain("backup");
    expect(getSettingsSections(true, true).map((section) => section.id)).toContain("backup");
    expect(getSettingsSectionRedirect("backup", false, false)).toBeNull();
  });
});
