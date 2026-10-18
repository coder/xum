/**
 * #6974: the creation composer (project page) shares the workspace composer's caret handling,
 * and its CreationDraftStore drops an edit for an id with no draft. These tests cover both on a
 * real creation view.
 */
import "../dom";
import { act, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  openProjectCreationView,
  setupTestDom,
  waitForLatestDraftId,
} from "../helpers";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const WAIT = { timeout: 30_000 };

function composer(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (!textarea) throw new Error("Creation textarea not found");
  return textarea;
}

/**
 * Types `key` where the textarea caret is, as a browser does: the input event reports the caret
 * after the key. (fireEvent.input would move the caret to the end first.)
 */
function typeAtCaret(textarea: HTMLTextAreaElement, key: string) {
  const view = textarea.ownerDocument.defaultView as unknown as typeof globalThis;
  const caret = textarea.selectionStart;
  const next = textarea.value.slice(0, caret) + key + textarea.value.slice(textarea.selectionEnd);
  act(() => {
    // The prototype setter, as the browser's own edit: React's value tracker then sees a change.
    Reflect.set(view.HTMLTextAreaElement.prototype, "value", next, textarea);
    textarea.setSelectionRange(caret + key.length, caret + key.length);
    textarea.dispatchEvent(new view.Event("input", { bubbles: true }));
  });
}

async function openCreationView() {
  const cleanupDom = setupTestDom();
  const view = renderApp({ apiClient: getSharedEnv().orpc });
  const projectPath = await addProjectViaUI(view, getSharedRepoPath());
  await openProjectCreationView(view, projectPath);
  const draftId = await waitForLatestDraftId(projectPath);
  return { view, cleanupDom, draftId };
}

describeIntegration("creation composer caret and draft edits (#6974)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  // The workspace composer's #6944 case, in the creation composer: the key after a symbol
  // conversion mid-text goes right after the symbol, not to the end of the text.
  test("the key after a symbol conversion mid-text lands after the symbol", async () => {
    const { view, cleanupDom, draftId } = await openCreationView();
    try {
      act(() => getCreationDraftStore().update(draftId, { text: "a b" }));
      await waitFor(() => expect(composer(view.container).value).toBe("a b"), WAIT);
      const textarea = composer(view.container);
      textarea.setSelectionRange(1, 1);
      for (const key of ["\\", "i", "n", " ", "x"]) typeAtCaret(textarea, key);
      expect(textarea.value).toBe("a∈ x b");
      expect(getCreationDraftStore().getView(draftId).draft?.text).toBe("a∈ x b");
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 120_000);

  // CreationDraftStore.update returns early for an id with no draft (#6974 item 3). A mounted
  // composer never reaches that return: CreationDraftGate renders it only for a loaded draft and
  // takes it down in the render right after the delete, before the next key event (the store
  // notifies synchronously). What still reaches it is a late writer, such as a name generation
  // that settles after the delete: the return keeps it from bringing the draft back.
  test("a deleted draft takes its composer down, and a late edit does not bring it back", async () => {
    const { view, cleanupDom, draftId } = await openCreationView();
    const store = getCreationDraftStore();
    try {
      act(() => store.update(draftId, { text: "old" }));
      await waitFor(() => expect(composer(view.container).value).toBe("old"), WAIT);
      const shown = composer(view.container);
      await act(async () => {
        await store.delete(draftId);
      });
      expect(shown.isConnected).toBe(false);
      expect(view.container.querySelector('textarea[aria-label="Message"]')).toBeNull();

      act(() => store.update(draftId, { text: "late" }));
      expect(store.getView(draftId).draft).toBeNull();
      expect(view.container.querySelector('textarea[aria-label="Message"]')).toBeNull();
      const rows = Object.values(store.getDraftsByProject()).flat();
      expect(rows.map((row) => row.draftId)).not.toContain(draftId);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 120_000);
});
