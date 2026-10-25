import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { ArtifactEntry, ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import {
  isStatusPageEntryShowable,
  isStatusPageReadShowable,
  resolveAgentInterfaceView,
  toggledAgentInterfaceView,
  type AgentInterfaceView,
} from "./agentInterfaceView";

describe("resolveAgentInterfaceView", () => {
  test.each<[string, boolean, boolean, AgentInterfaceView | null, AgentInterfaceView]>([
    ["defaults to the status page when it exists", true, true, null, "status"],
    ["an explicit chat choice wins over the default", true, true, "chat", "chat"],
    ["an explicit status choice is kept", true, true, "status", "status"],
    // Never a blank pane: without a page the transcript shows, whatever was chosen.
    ["a missing status page shows the transcript", true, false, null, "chat"],
    ["a status choice without a page shows the transcript", true, false, "status", "chat"],
    ["the experiment off shows the transcript", false, true, "status", "chat"],
  ])("%s", (_name, enabled, statusExists, stored, expected) => {
    expect(resolveAgentInterfaceView({ enabled, statusExists, stored })).toBe(expected);
  });
});

describe("toggledAgentInterfaceView", () => {
  test("the user's chord flips both ways; a frame's chord only leaves the status page", () => {
    expect(toggledAgentInterfaceView("status", false)).toBe("chat");
    expect(toggledAgentInterfaceView("chat", false)).toBe("status");
    expect(toggledAgentInterfaceView("status", true)).toBe("chat");
    expect(toggledAgentInterfaceView("chat", true)).toBeNull();
  });
});

describe("status page fallback to the transcript", () => {
  const meta = { path: "status.html", kind: "html", size: 12, modifiedMs: 1000 } as const;
  const html = { ...meta, status: "ok", encoding: "utf8" } as const;
  // DOMParser, for the HTML checks.
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test.each<[string, ArtifactReadResult, boolean]>([
    ["an HTML page shows", { ...meta, status: "ok", encoding: "utf8", content: "<p>hi</p>" }, true],
    ["a blank page does not", { ...meta, status: "ok", encoding: "utf8", content: " \n\t" }, false],
    [
      "an empty HTML skeleton does not",
      { ...html, content: "<!doctype html><html><head></head><body></body></html>" },
      false,
    ],
    ["a comment-only page does not", { ...html, content: "<!-- filled in later -->" }, false],
    [
      "a page its script builds shows",
      { ...html, content: "<script>document.write('hi')</script>" },
      true,
    ],
    ["a binary file does not", { ...meta, status: "binary" }, false],
    ["a file over the read cap does not", { ...meta, status: "too_large", maxBytes: 1 }, false],
  ])("%s", (_name, read, expected) => {
    expect(isStatusPageReadShowable(read)).toBe(expected);
  });

  test("an empty file never shows, and an unshowable version shows again once the file changes", () => {
    const entry: ArtifactEntry = { ...meta };
    expect(isStatusPageEntryShowable(null, undefined)).toBe(false);
    expect(isStatusPageEntryShowable({ ...entry, size: 0 }, undefined)).toBe(false);
    expect(isStatusPageEntryShowable(entry, undefined)).toBe(true);
    // A read of this very version found nothing to show (a binary or blank page).
    expect(isStatusPageEntryShowable(entry, entry)).toBe(false);
    expect(isStatusPageEntryShowable({ ...entry, modifiedMs: 2000 }, entry)).toBe(true);
    expect(isStatusPageEntryShowable({ ...entry, size: 40 }, entry)).toBe(true);
  });
});
