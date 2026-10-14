import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type { InlineSkillSnapshotMap } from "@/common/types/message";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { installDom } from "../../../../tests/ui/dom";

function createSkillSnapshot(skillName: string): InlineSkillSnapshotMap[string] {
  return {
    skillName,
    scope: "global",
    snapshot: {
      frontmatterYaml: `name: ${skillName}`,
      body: `Skill body for ${skillName}`,
    },
  };
}

function getSkillBadges(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-component="AgentSkillBadge"]'));
}

function renderMarkdown(content: string, inlineSkillSnapshots?: InlineSkillSnapshotMap) {
  return render(
    <MarkdownRenderer
      content={content}
      className="user-message-markdown"
      inlineSkillSnapshots={inlineSkillSnapshots}
      preserveLineBreaks
    />
  );
}

describe("Inline skill Markdown rendering", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders known inline skill references as badge triggers", () => {
    const view = renderMarkdown("Please perform a $deep-review and follow $tdd", {
      "deep-review": createSkillSnapshot("deep-review"),
      tdd: createSkillSnapshot("tdd"),
    });

    const badges = getSkillBadges(view.container);
    expect(badges.map((badge) => badge.textContent)).toEqual(["$deep-review", "$tdd"]);
  });

  test("badges a qualified reference, or only its bare prefix when that loaded instead", () => {
    const view = renderMarkdown("Use $pstack:tdd and $tdd:notes here", {
      "pstack:tdd": createSkillSnapshot("pstack:tdd"),
      tdd: createSkillSnapshot("tdd"),
    });

    const badges = getSkillBadges(view.container);
    expect(badges.map((badge) => badge.textContent)).toEqual(["$pstack:tdd", "$tdd"]);
    expect(view.container.textContent).toContain("$tdd:notes here");
  });

  test("does not badge inline code or fenced code block tokens", () => {
    const view = renderMarkdown("Use `$tdd` here.\n\n```\n$deep-review\n```", {
      "deep-review": createSkillSnapshot("deep-review"),
      tdd: createSkillSnapshot("tdd"),
    });

    expect(getSkillBadges(view.container)).toHaveLength(0);
  });

  test("does not badge non-skill dollar tokens", () => {
    const view = renderMarkdown("Keep $100, $PATH, and foo$bar as plain text", {
      tdd: createSkillSnapshot("tdd"),
    });

    expect(getSkillBadges(view.container)).toHaveLength(0);
    expect(view.container.querySelector("a")).toBeNull();
  });

  test("renders unknown inline skill references as plain text", () => {
    const view = renderMarkdown("Run $unknown if it exists", {});

    expect(view.container.textContent).toContain("$unknown");
    expect(getSkillBadges(view.container)).toHaveLength(0);
    expect(view.container.querySelector("a")).toBeNull();
  });

  test("renders repeated references from one snapshot entry", () => {
    const view = renderMarkdown("Run $tdd, then run $tdd again", {
      tdd: createSkillSnapshot("tdd"),
    });

    const badges = getSkillBadges(view.container);
    expect(badges).toHaveLength(2);
    expect(badges.every((badge) => badge.textContent === "$tdd")).toBe(true);
  });
});
