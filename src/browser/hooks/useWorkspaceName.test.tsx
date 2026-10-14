import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { getDraftStore, type DraftStoreScope } from "@/browser/stores/DraftStore";
import { createTestApiClient } from "@/browser/testUtils";
import type { DraftEvent, DraftUpdateInput } from "@/common/orpc/schemas/drafts";
import { toDraftAttachmentMetadata } from "@/common/utils/drafts";
import { useWorkspaceName } from "./useWorkspaceName";

const generateMock = mock(() =>
  Promise.resolve({
    success: true as const,
    data: { name: "quotes-a1b2", title: "Quote heavy message", modelUsed: "test:model" },
  })
);
const api = createTestApiClient({ nameGeneration: { generate: generateMock } });

const PROJECT = "/projects/name-state";
const SCOPE: DraftStoreScope = { kind: "creation", projectPath: PROJECT, draftId: "draft-1" };

/** Events another window's writes would push to this one. */
let pushEvent: (event: DraftEvent) => void = () => undefined;
let revision = 1;
const draftBackend = createTestApiClient({
  drafts: {
    subscribe: (_input: void, opts?: { signal?: AbortSignal }) =>
      Promise.resolve(
        (async function* (): AsyncGenerator<DraftEvent> {
          const queue: DraftEvent[] = [
            { type: "snapshot", drafts: [], list: { entries: [], revision: 0 } },
          ];
          let wake: (() => void) | null = null;
          pushEvent = (event) => {
            queue.push(event);
            wake?.();
          };
          while (!opts?.signal?.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        })()
      ),
    update: (input: DraftUpdateInput) =>
      Promise.resolve({
        revision: ++revision,
        text: input.text ?? "",
        attachments: (input.attachments ?? []).map(toDraftAttachmentMetadata),
        ...(input.nameState != null ? { nameState: input.nameState } : {}),
      }),
  },
});

function Wrapper(props: { children: ReactNode }) {
  return <APIProvider client={api}>{props.children}</APIProvider>;
}

function renderWorkspaceName(message: string) {
  return renderHook(() => useWorkspaceName({ message, debounceMs: 1, scope: { ...SCOPE } }), {
    wrapper: Wrapper,
  });
}

describe("useWorkspaceName draft state", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(async () => {
    cleanupDom = installDom();
    generateMock.mockClear();
    getDraftStore().forgetProject(PROJECT);
    getDraftStore().setClient(draftBackend);
    await getDraftStore().whenReady();
  });

  afterEach(() => {
    getDraftStore().setClient(null);
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a name generated for an escape-heavy message is kept in the draft without regenerating", async () => {
    const message = '"'.repeat(1999);
    const first = renderWorkspaceName(message);
    await waitFor(() => expect(first.result.current.name).toBe("quotes-a1b2"));
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(getDraftStore().getView(SCOPE).nameState?.generatedIdentity?.name).toBe("quotes-a1b2");
    first.unmount();

    const remounted = renderWorkspaceName(message);
    expect(remounted.result.current.name).toBe("quotes-a1b2");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  test("another window's name edit replaces the shown name", async () => {
    const view = renderWorkspaceName("");
    act(() => view.result.current.setAutoGenerate(false));
    act(() => view.result.current.setName("this-window"));
    await getDraftStore().flush(SCOPE);
    act(() =>
      pushEvent({
        type: "changed",
        scope: SCOPE,
        text: "",
        attachments: [],
        nameState: {
          generatedIdentity: null,
          manualName: "other-window",
          autoGenerate: false,
          lastGeneratedFor: "",
        },
        revision: ++revision,
      })
    );
    await waitFor(() => expect(view.result.current.name).toBe("other-window"));
  });
});
