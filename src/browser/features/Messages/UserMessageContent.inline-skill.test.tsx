import "../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { DisplayedUserMessage, InlineSkillSnapshotMap } from "@/common/types/message";
import type { EditingMessageState } from "@/browser/utils/chatEditing";
import { UserMessage } from "./UserMessage";
import { UserMessageContent } from "./UserMessageContent";
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

describe("UserMessageContent inline skill rendering", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders the slash skill badge in sent user messages", () => {
    const slashSnapshot = createSkillSnapshot("deep-review");
    const view = render(
      <UserMessageContent
        content="/deep-review Please run $tdd"
        commandPrefix="/deep-review"
        agentSkillSnapshot={slashSnapshot.snapshot}
        inlineSkillSnapshots={{ tdd: createSkillSnapshot("tdd") }}
        variant="sent"
      />
    );

    // Inline `$skill` Markdown badge rendering is covered directly in
    // InlineSkillMarkdown.test; this composition test only needs the synchronously
    // rendered slash prefix badge so it does not depend on Streamdown timing under
    // full-suite coverage runs.
    const badgeTexts = getSkillBadges(view.container).map((badge) => badge.textContent);
    expect(badgeTexts).toContain("/deep-review");
  });

  test("keeps edit-mode textarea content as raw text", () => {
    function EditHarness() {
      const [editingMessage, setEditingMessage] = React.useState<EditingMessageState | null>(null);
      const message: DisplayedUserMessage = {
        type: "user",
        id: "display-1",
        historyId: "history-1",
        historySequence: 1,
        content: "Please run $tdd",
        inlineSkillSnapshots: { tdd: createSkillSnapshot("tdd") },
      };

      if (editingMessage) {
        return (
          <textarea aria-label="Edit message" readOnly value={editingMessage.pending.content} />
        );
      }

      return (
        <TooltipProvider>
          <UserMessage message={message} onEdit={(nextEditing) => setEditingMessage(nextEditing)} />
        </TooltipProvider>
      );
    }

    const view = render(<EditHarness />);

    fireEvent.click(view.getByRole("button", { name: "Edit" }));

    const textarea = view.getByLabelText("Edit message");
    if (!(textarea instanceof window.HTMLTextAreaElement)) {
      throw new Error("Expected edit control to be a textarea");
    }

    expect(textarea.value).toBe("Please run $tdd");
    expect(getSkillBadges(view.container)).toHaveLength(0);
  });
});
