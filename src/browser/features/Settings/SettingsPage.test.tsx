import { afterEach, describe, expect, mock, test } from "bun:test";

import type React from "react";
import {
  getSettingsSectionRedirect,
  getSettingsSections,
  handleFocusSearchKey,
} from "./SettingsPage";

describe("SettingsPage", () => {
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

describe("handleFocusSearchKey", () => {
  const realRaf = globalThis.requestAnimationFrame;
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
  });

  function keyEvent(init: { key: string; ctrlKey?: boolean }) {
    const event = {
      code: "",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...init,
      preventDefault: mock(() => undefined),
      stopPropagation: mock(() => undefined),
      nativeEvent: { stopPropagation: mock(() => undefined) },
    };
    return { event, react: event as unknown as React.KeyboardEvent };
  }

  test("the shortcut shows the list, then focuses and selects the field, and stops the event", () => {
    const frames: Array<() => void> = [];
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const input = { focus: mock(() => undefined), select: mock(() => undefined) };
    const showList = mock(() => undefined);
    const { event, react } = keyEvent({ key: "f", ctrlKey: true });

    const handled = handleFocusSearchKey(react, showList, {
      current: input as unknown as HTMLInputElement,
    });
    expect(handled).toBe(true);
    expect(showList).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.nativeEvent.stopPropagation).toHaveBeenCalled();
    // The field is focused only after the list (which holds it on phones) is on screen.
    expect(input.focus).not.toHaveBeenCalled();
    frames.forEach((frame) => frame());
    expect(input.focus).toHaveBeenCalled();
    expect(input.select).toHaveBeenCalled();
  });

  test("any other key passes through untouched", () => {
    const showList = mock(() => undefined);
    const { event, react } = keyEvent({ key: "f" });
    expect(handleFocusSearchKey(react, showList, { current: null })).toBe(false);
    expect(showList).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
