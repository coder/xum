import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { installDom } from "../../../../tests/ui/dom";
import { installQuotaLimitedStorage } from "../../../../tests/ui/quotaLimitedStorage";
import type { ChatAttachment } from "./ChatAttachments";
import { useComposerDraft } from "./useComposerDraft";

let cleanupDom: (() => void) | undefined;

const attachment = (id: string): ChatAttachment => ({
  kind: "provider",
  id,
  url: "data:image/png;base64,AAA",
  mediaType: "image/png",
});

// The draft store is a process-wide singleton, so every test uses its own workspace.
const renderDraft = (workspaceId: string) =>
  renderHook(() =>
    useComposerDraft({
      variant: "workspace",
      workspaceId,
      creationProjectPath: "",
      attachedReviews: [],
      pushToast: () => undefined,
    })
  );

describe("useComposerDraft", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  // Issue 5006: the composer rendered the localStorage value, so with a full origin quota every
  // keystroke failed to save and never appeared on screen.
  test("typed text stays on screen when localStorage writes throw QuotaExceededError", () => {
    const storage = installQuotaLimitedStorage(0);
    const { result } = renderDraft("ws-quota-full");
    act(() => {
      result.current.setInput("typed while the quota is full");
    });
    act(() => {
      result.current.setInput((previous) => previous + "!");
    });

    expect(result.current.input).toBe("typed while the quota is full!");
    expect(storage.length).toBe(0);
  });

  // A Stop restore writes text then attachments and flushes them right away (#4448). If the
  // composer unmounts before React renders, a change applied only inside a state updater would
  // never reach the draft store, so the flush would confirm a draft without it.
  test("applies a restore to the draft store before the next render, even if the composer unmounts", () => {
    const workspaceId = "ws-restore-unmount";
    const { result, unmount } = renderDraft(workspaceId);
    act(() => {
      result.current.setInput("restored text");
      result.current.setAttachments((current) => [attachment("restored"), ...current]);
      unmount();
    });

    const draft = getDraftStore().getView({ kind: "workspace", workspaceId });
    expect(draft.text).toBe("restored text");
    expect(draft.attachments.map(({ id }) => id)).toEqual(["restored"]);
  });

  test("sequential functional attachment updates in one batch compose", () => {
    const { result } = renderDraft("ws-sequential");
    act(() => {
      result.current.setAttachments((current) => [...current, attachment("a")]);
      result.current.setAttachments((current) => [...current, attachment("b")]);
    });

    expect(result.current.attachments.map(({ id }) => id)).toEqual(["a", "b"]);
  });
});
