import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { getInputAttachmentsKey, getInputKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { installDom } from "../../../../tests/ui/dom";
import type { ChatAttachment } from "./ChatAttachments";
import { readPersistedChatAttachments } from "./draftAttachmentsStorage";
import { useComposerDraft } from "./useComposerDraft";

let cleanupDom: (() => void) | undefined;

const WORKSPACE_ID = "ws-draft";

const attachment = (id: string): ChatAttachment => ({
  kind: "provider",
  id,
  url: "data:image/png;base64,AAA",
  mediaType: "image/png",
});

const renderDraft = () =>
  renderHook(() =>
    useComposerDraft({
      variant: "workspace",
      workspaceId: WORKSPACE_ID,
      creationProjectPath: "",
      attachedReviews: [],
      pushToast: () => undefined,
    })
  );

describe("useComposerDraft attachment persistence", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  // A Stop restore writes text then attachments and acknowledges the backend copy right away
  // (#4448). If the composer unmounts before React renders, attachments persisted only inside
  // a state updater would be lost after that acknowledgement.
  test("persists attachments before the next render, even if the composer unmounts first", () => {
    const { result, unmount } = renderDraft();
    act(() => {
      result.current.setInput("restored text");
      result.current.setAttachments((current) => [attachment("restored"), ...current]);
      unmount();
    });

    expect(readPersistedState(getInputKey(WORKSPACE_ID), "")).toBe("restored text");
    expect(
      readPersistedChatAttachments(getInputAttachmentsKey(WORKSPACE_ID)).map(({ id }) => id)
    ).toEqual(["restored"]);
  });

  test("sequential functional updates in one batch compose", () => {
    const { result } = renderDraft();
    act(() => {
      result.current.setAttachments((current) => [...current, attachment("a")]);
      result.current.setAttachments((current) => [...current, attachment("b")]);
    });

    expect(result.current.attachments.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(
      readPersistedChatAttachments(getInputAttachmentsKey(WORKSPACE_ID)).map(({ id }) => id)
    ).toEqual(["a", "b"]);
  });
});
