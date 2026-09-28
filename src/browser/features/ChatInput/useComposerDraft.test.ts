import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { getInputAttachmentsKey, getInputKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { installDom } from "../../../../tests/ui/dom";
import { installQuotaLimitedStorage } from "../../../../tests/ui/quotaLimitedStorage";
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

const renderDraft = (
  pushToast: Parameters<typeof useComposerDraft>[0]["pushToast"] = () => undefined
) =>
  renderHook(() =>
    useComposerDraft({
      variant: "workspace",
      workspaceId: WORKSPACE_ID,
      creationProjectPath: "",
      attachedReviews: [],
      pushToast,
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

  // Under the size cap the write can still fail when the origin quota is full and nothing
  // evictable is left. The user must hear that the attachment is memory-only, and the
  // previously saved list must not come back on reload.
  test("warns when an attachment within the size cap still fails to save", () => {
    const storage = installQuotaLimitedStorage(400);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const pushToast = mock((_toast: unknown) => undefined);
    const { result } = renderDraft(pushToast);
    act(() => {
      result.current.setAttachments([attachment("small")]);
    });
    expect(storage.getItem(getInputAttachmentsKey(WORKSPACE_ID))).not.toBeNull();
    expect(pushToast).not.toHaveBeenCalled();

    storage.seed("review-state:ws-draft", "y".repeat(300));
    act(() => {
      result.current.setAttachments((current) => [...current, attachment("second")]);
    });

    expect(result.current.attachments.map(({ id }) => id)).toEqual(["small", "second"]);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0]).toEqual([expect.objectContaining({ type: "error" })]);
    expect(storage.getItem(getInputAttachmentsKey(WORKSPACE_ID))).toBeNull();

    // The first toast auto-dismisses, so each later add that also fails must warn again;
    // removing an attachment adds nothing new to warn about.
    act(() => {
      result.current.setAttachments((current) => [...current, attachment("third")]);
    });
    expect(pushToast).toHaveBeenCalledTimes(2);
    act(() => {
      result.current.setAttachments((current) => current.slice(1));
    });
    expect(pushToast).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
