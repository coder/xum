// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { canEditDisplayedUserMessage } from "@/browser/utils/chatEditing";
import { buildDisplayedMessagesForMessage } from "@/browser/utils/messages/displayedMessageBuilder";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import {
  createMuxMessage,
  type ArtifactInteractionMetadata,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { ArtifactInteractionPill } from "./ArtifactInteractionPill";
import { formatArtifactInteractionMarkdown } from "./artifactInteractionMarkdown";

const INTERACTION: ArtifactInteractionMetadata = {
  id: "i1",
  artifactPath: "forms/plan.html",
  title: "Plan",
  version: 3,
  action: "send",
  text: "Canary",
  data: { pct: 10 },
};

const TAG =
  '<artifact_interaction artifact="forms/plan.html" title="Plan" version="3" action="send">{"text":"Canary"}</artifact_interaction>';

function displayedUser(muxMetadata?: MuxMessageMetadata) {
  const message = createMuxMessage("u1", "user", TAG, {
    historySequence: 1,
    ...(muxMetadata ? { muxMetadata } : {}),
  });
  const [row] = buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  if (row?.type !== "user") throw new Error("expected a user row");
  return row;
}

describe("messages sent from artifacts", () => {
  test("only backend metadata marks a message as from an artifact; a typed tag does not", () => {
    expect(displayedUser().artifactInteraction).toBeUndefined();
    expect(
      displayedUser({ type: "normal", artifactInteraction: INTERACTION }).artifactInteraction
    ).toEqual(INTERACTION);
    // Malformed metadata degrades to an ordinary message instead of a broken pill.
    const bad: ArtifactInteractionMetadata = { ...INTERACTION, version: -1 };
    expect(
      displayedUser({ type: "normal", artifactInteraction: bad }).artifactInteraction
    ).toBeUndefined();
  });

  test("Edit is hidden for artifact messages but not for typed lookalikes", () => {
    expect(canEditDisplayedUserMessage(displayedUser())).toBe(true);
    expect(
      canEditDisplayedUserMessage(
        displayedUser({ type: "normal", artifactInteraction: INTERACTION })
      )
    ).toBe(false);
  });

  test("body shows the text plus data as a JSON block that artifact data cannot close", () => {
    expect(formatArtifactInteractionMarkdown({ text: "Hi" })).toBe("Hi");
    const markdown = formatArtifactInteractionMarkdown({ text: "Hi", data: { s: "```x" } });
    expect(markdown.startsWith("Hi\n\n````json\n")).toBe(true);
    expect(markdown.endsWith("\n````")).toBe(true);
  });

  describe("pill", () => {
    let cleanupDom: (() => void) | null = null;
    beforeEach(() => {
      cleanupDom = installDom();
    });
    afterEach(() => {
      cleanup();
      cleanupDom?.();
      cleanupDom = null;
    });

    test("opens the artifact at the interacted version", () => {
      const opened: Array<CustomEventPayloads[typeof CUSTOM_EVENTS.OPEN_ARTIFACT]> = [];
      const onOpen = (event: Event) =>
        opened.push(
          (event as CustomEvent<CustomEventPayloads[typeof CUSTOM_EVENTS.OPEN_ARTIFACT]>).detail
        );
      window.addEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpen);
      const view = render(<ArtifactInteractionPill interaction={INTERACTION} workspaceId="ws" />);
      fireEvent.click(view.getByRole("button", { name: "Open Plan in Artifacts" }));
      window.removeEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpen);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ workspaceId: "ws", path: "forms/plan.html", versionId: 3 });
    });
  });
});
