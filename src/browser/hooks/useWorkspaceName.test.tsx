import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { startTransition, Suspense, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { getDraftStore, type DraftStoreScope } from "@/browser/stores/DraftStore";
import { createTestApiClient } from "@/browser/testUtils";
import type { DraftEvent, DraftUpdateInput } from "@/common/orpc/schemas/drafts";
import { toDraftAttachmentMetadata } from "@/common/utils/drafts";
import { useWorkspaceName } from "./useWorkspaceName";

const generateMock = mock((_input: { draftNamingId?: string }) =>
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

  // The draft switch renders the new scope before its effect cancels the request (here the
  // switch never commits: the new draft suspends), so a reply in between must not follow it.
  test("a name generated for one draft is never written into the draft switched to", async () => {
    let reply: (name: string) => void = () => undefined;
    generateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = (name) =>
            resolve({
              success: true as const,
              data: { name, title: "Draft one", modelUsed: "test:model" },
            });
        })
    );
    const other: DraftStoreScope = { ...SCOPE, draftId: "draft-2" };
    const pending = new Promise<never>(() => undefined);
    const view = renderHook(
      (props: { scope: DraftStoreScope; suspend: boolean }) => {
        const result = useWorkspaceName({ message: "fix it", debounceMs: 1, scope: props.scope });
        // The Suspense protocol (React 18 has no `use`): a pending render throws its promise.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (props.suspend) throw pending;
        return result;
      },
      {
        initialProps: { scope: { ...SCOPE }, suspend: false },
        wrapper: (props: { children: ReactNode }) => (
          <Wrapper>
            <Suspense fallback={null}>{props.children}</Suspense>
          </Wrapper>
        ),
      }
    );
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));
    act(() => startTransition(() => view.rerender({ scope: other, suspend: true })));
    await act(async () => {
      reply("draft-one-a1b2");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getDraftStore().getView(other).nameState).toBeNull();
    expect(getDraftStore().getView(SCOPE).nameState?.generatedIdentity?.name).toBe(
      "draft-one-a1b2"
    );
  });

  // The user discarded the draft (navigation unmounts the composer) while its name was being
  // generated: the late result must not write a name, which would bring the draft back.
  test("a name generated after unmount is not written to the draft", async () => {
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    generateMock.mockImplementationOnce(() => generation.promise);
    const view = renderWorkspaceName("fix the sidebar");
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      generation.resolve({
        success: true as const,
        data: { name: "sidebar-a1b2", title: "Fix sidebar", modelUsed: "test:model" },
      });
      await generation.promise;
    });
    expect(getDraftStore().getView(SCOPE).nameState).toBeNull();
  });

  // After a reconnect the cached draft may be stale until the new subscription's snapshot: a
  // name generated for it would be an unsaved edit and outrank the backend's name.
  test("waits for a replacement client's snapshot before generating a name", async () => {
    const snapshot = Promise.withResolvers<void>();
    getDraftStore().setClient(
      createTestApiClient({
        drafts: {
          ...draftBackend.drafts,
          subscribe: async (input: void, opts?: { signal?: AbortSignal }) => {
            await snapshot.promise;
            return draftBackend.drafts.subscribe(input, opts);
          },
        },
      })
    );
    const view = renderWorkspaceName("fix the sidebar");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(generateMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      snapshot.resolve();
      await snapshot.promise;
    });
    await waitFor(() => expect(view.result.current.name).toBe("quotes-a1b2"));
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

  describe("handOffGeneration", () => {
    test("hands an in-flight generation to the caller and drops its late result", async () => {
      const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
      generateMock.mockImplementationOnce(() => generation.promise);
      const view = renderWorkspaceName("fix the sidebar");
      await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

      const handedOff: Array<ReturnType<typeof view.result.current.handOffGeneration>> = [];
      act(() => {
        handedOff.push(view.result.current.handOffGeneration());
      });
      // Named so the backend can take the in-flight request's result over.
      const inFlightId = generateMock.mock.calls[0]?.[0]?.draftNamingId;
      expect(typeof inFlightId).toBe("string");
      expect(handedOff[0]?.request).toEqual({
        message: "fix the sidebar",
        candidates: [],
        draftNamingId: inFlightId,
      });
      expect(view.result.current.isGenerating).toBe(false);

      await act(async () => {
        generation.resolve({
          success: true as const,
          data: { name: "sidebar-a1b2", title: "Fix sidebar", modelUsed: "test:model" },
        });
        await generation.promise;
      });
      expect(view.result.current.name).toBe("");
    });

    test("a resume after a switch to another draft leaves that draft's naming alone", async () => {
      const draftB = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
      // Draft A's request is handed off and never answers; draft B's answers below.
      generateMock.mockImplementationOnce(() => new Promise(() => undefined));
      generateMock.mockImplementationOnce(() => draftB.promise);
      const view = renderHook(
        (props: { message: string; draftId: string }) =>
          useWorkspaceName({
            message: props.message,
            debounceMs: 1,
            scope: { ...SCOPE, draftId: props.draftId },
          }),
        { wrapper: Wrapper, initialProps: { message: "fix the sidebar", draftId: "draft-a" } }
      );
      await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));
      const handedOff: Array<ReturnType<typeof view.result.current.handOffGeneration>> = [];
      act(() => {
        handedOff.push(view.result.current.handOffGeneration());
      });

      view.rerender({ message: "rework the layout", draftId: "draft-b" });
      await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(2));
      // Draft A's create fails only now.
      act(() => handedOff[0]?.resume());
      await act(async () => {
        draftB.resolve({
          success: true as const,
          data: { name: "layout-x2p4", title: "Rework layout", modelUsed: "test:model" },
        });
        await draftB.promise;
      });

      expect(view.result.current.name).toBe("layout-x2p4");
      expect(generateMock).toHaveBeenCalledTimes(2);
    });

    test("returns null when a name was generated for the current message", async () => {
      const view = renderWorkspaceName("fix the sidebar");
      await waitFor(() => expect(view.result.current.name).toBe("quotes-a1b2"));
      expect(view.result.current.handOffGeneration()).toBeNull();
    });

    test("returns null for a manual name", () => {
      const view = renderWorkspaceName("fix the sidebar");
      act(() => view.result.current.setAutoGenerate(false));
      act(() => view.result.current.setName("my-feature"));
      expect(view.result.current.handOffGeneration()).toBeNull();
    });
  });
});
