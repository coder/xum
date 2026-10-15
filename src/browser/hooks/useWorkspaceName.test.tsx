import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { startTransition, Suspense, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { CONNECTION_LOST_MESSAGE, ConnectionLostError } from "@/browser/contexts/connectionLink";
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
// `satisfies`: the helpers below are hoisted, so a declared union type would not narrow there.
const SCOPE = {
  kind: "creation",
  projectPath: PROJECT,
  draftId: "draft-1",
} satisfies DraftStoreScope;

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

/** Settles when `opts.signal` aborts. */
function aborted(opts?: { signal?: AbortSignal }): Promise<void> {
  return new Promise<void>((resolve) => {
    opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A connection whose socket can drop: the subscription then ends, and calls fail as lost. */
function createDroppableClient() {
  const dropped = Promise.withResolvers<void>();
  let offline = false;
  const client = createTestApiClient({
    drafts: {
      ...draftBackend.drafts,
      subscribe: (_input: void, opts?: { signal?: AbortSignal }) =>
        Promise.resolve(
          (async function* (): AsyncGenerator<DraftEvent> {
            yield { type: "snapshot", drafts: [], list: { entries: [], revision: 0 } };
            await Promise.race([dropped.promise, aborted(opts)]);
            if (!opts?.signal?.aborted) throw new ConnectionLostError();
          })()
        ),
      update: (input: DraftUpdateInput) =>
        offline ? Promise.reject(new ConnectionLostError()) : draftBackend.drafts.update(input),
    },
  });
  return {
    client,
    drop: () => {
      offline = true;
      dropped.resolve();
    },
  };
}

/** The connection after a reconnect: its snapshot holds `nameState`; it records every update. */
function createReconnectClient(nameState: DraftUpdateInput["nameState"]) {
  const updates: DraftUpdateInput[] = [];
  const client = createTestApiClient({
    drafts: {
      ...draftBackend.drafts,
      subscribe: (_input: void, opts?: { signal?: AbortSignal }) =>
        Promise.resolve(
          (async function* (): AsyncGenerator<DraftEvent> {
            yield {
              type: "snapshot",
              drafts: nameState
                ? [{ scope: SCOPE, text: "", attachments: [], nameState, revision: ++revision }]
                : [],
              list: { entries: [], revision: 0 },
            };
            await aborted(opts);
          })()
        ),
      update: (input: DraftUpdateInput) => {
        updates.push(input);
        return draftBackend.drafts.update(input);
      },
    },
  });
  return { client, updates };
}

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

  // A request in flight when the client is replaced may answer before the new snapshot: its name
  // would be an unsaved edit over a cached view and replace the new backend's stored name.
  test("drops a name that arrives while a replacement client's snapshot is pending", async () => {
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    generateMock.mockImplementationOnce(() => generation.promise);
    const view = renderWorkspaceName("fix the sidebar");
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

    const snapshot = Promise.withResolvers<void>();
    // One act: the reply lands after the reconnect but before React re-renders and runs effects.
    await act(async () => {
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
      generation.resolve({
        success: true as const,
        data: { name: "stale-a1b2", title: "Stale name", modelUsed: "test:model" },
      });
      await generation.promise;
    });
    expect(getDraftStore().getView(SCOPE).nameState).toBeNull();

    await act(async () => {
      snapshot.resolve();
      await snapshot.promise;
    });
    await waitFor(() => expect(view.result.current.name).toBe("quotes-a1b2"));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  // The replacement backend already named the draft for this message, so nothing regenerates
  // (and nothing else cancels): the old request's late reply must not replace that name.
  test("drops a reply that a reconnect made stale, also after the new snapshot", async () => {
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    generateMock.mockImplementationOnce(() => generation.promise);
    renderWorkspaceName("fix the sidebar");
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

    const backendName = {
      generatedIdentity: { name: "backend-k3m9", title: "Backend name" },
      manualName: "",
      autoGenerate: true,
      lastGeneratedFor: "fix the sidebar",
    };
    act(() =>
      getDraftStore().setClient(
        createTestApiClient({
          drafts: {
            ...draftBackend.drafts,
            subscribe: (_input: void, opts?: { signal?: AbortSignal }) =>
              Promise.resolve(
                (async function* (): AsyncGenerator<DraftEvent> {
                  yield {
                    type: "snapshot",
                    drafts: [
                      {
                        scope: SCOPE,
                        text: "",
                        attachments: [],
                        nameState: backendName,
                        revision: ++revision,
                      },
                    ],
                    list: { entries: [], revision: 0 },
                  };
                  await new Promise<void>((resolve) => {
                    opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
                  });
                })()
              ),
          },
        })
      )
    );
    await waitFor(() => expect(getDraftStore().hasCurrentSnapshot()).toBe(true));
    await act(async () => {
      generation.resolve({
        success: true as const,
        data: { name: "stale-a1b2", title: "Stale name", modelUsed: "test:model" },
      });
      await generation.promise;
    });
    expect(getDraftStore().getView(SCOPE).nameState).toEqual(backendName);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  // Remote UAT R7-NAME: window 1's held name reply fails when its socket drops, and window 2
  // types a manual name meanwhile. A fallback name stored then would be an unsaved edit over
  // window 1's stale view (no manual name), sent as the whole name state after the reconnect.
  test("a name request lost with the connection leaves another window's newer name alone", async () => {
    const w1 = createDroppableClient();
    act(() => getDraftStore().setClient(w1.client));
    await waitFor(() => expect(getDraftStore().hasCurrentSnapshot()).toBe(true));
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    generateMock.mockImplementationOnce(() => generation.promise);
    const view = renderWorkspaceName("fix the sidebar");
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));
    const waiter = view.result.current.waitForGeneration();

    // The held reply fails first: the subscription has not noticed the drop yet.
    await act(async () => {
      generation.reject(new ConnectionLostError());
      await generation.promise.catch(() => undefined);
      w1.drop();
    });
    const waited = await waiter;
    const errorWhileOffline = view.result.current.error;

    const w2Name = {
      generatedIdentity: null,
      manualName: "w2-manual-held",
      autoGenerate: false,
      lastGeneratedFor: "",
    };
    const w2 = createReconnectClient(w2Name);
    act(() => getDraftStore().setClient(w2.client));
    await waitFor(() => expect(getDraftStore().hasCurrentSnapshot()).toBe(true));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await getDraftStore().flush(SCOPE);

    expect(getDraftStore().getView(SCOPE).nameState).toEqual(w2Name);
    expect(w2.updates.filter((update) => update.nameState != null)).toEqual([]);
    expect(view.result.current.name).toBe("w2-manual-held");
    expect(generateMock).toHaveBeenCalledTimes(1);
    // A submit waiting on the lost request stops and says why; the reconnect clears that.
    expect(waited).toBeNull();
    expect(errorWhileOffline).toEqual({ kind: "transport", message: CONNECTION_LOST_MESSAGE });
    expect(view.result.current.error).toBeNull();
  });

  test("names the draft again after the reconnect when the lost request left it unnamed", async () => {
    const w1 = createDroppableClient();
    act(() => getDraftStore().setClient(w1.client));
    await waitFor(() => expect(getDraftStore().hasCurrentSnapshot()).toBe(true));
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    generateMock.mockImplementationOnce(() => generation.promise);
    const view = renderWorkspaceName("fix the sidebar");
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

    // This time the subscription notices the drop before the reply fails.
    await act(async () => {
      w1.drop();
      await waitFor(() => expect(getDraftStore().hasCurrentSnapshot()).toBe(false));
      generation.reject(new ConnectionLostError());
      await generation.promise.catch(() => undefined);
    });
    expect(getDraftStore().getView(SCOPE).nameState).toBeNull();

    act(() => getDraftStore().setClient(createReconnectClient(undefined).client));
    await waitFor(() => expect(view.result.current.name).toBe("quotes-a1b2"));
    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(view.result.current.error).toBeNull();
  });

  // The composer stays mounted when another window deletes its draft: a reply that lands before
  // the emptied message cancels the request must not bring the draft back as a name-only body.
  test("a name that arrives after another window deleted the draft is dropped", async () => {
    act(() => getDraftStore().setText(SCOPE, "fix the sidebar"));
    await getDraftStore().flush(SCOPE);
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    generateMock.mockImplementationOnce(() => generation.promise);
    renderWorkspaceName("fix the sidebar");
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));

    // One act: the reply lands after the delete but before React re-renders and runs effects.
    await act(async () => {
      pushEvent({ type: "deleted", scope: SCOPE, revision: ++revision });
      await waitFor(() => expect(getDraftStore().getView(SCOPE).text).toBe(""));
      generation.resolve({
        success: true as const,
        data: { name: "stale-a1b2", title: "Stale name", modelUsed: "test:model" },
      });
      await generation.promise;
    });
    expect(getDraftStore().getView(SCOPE).nameState).toBeNull();
  });

  // A Send click after a reconnect, before its snapshot: the cached draft may be stale, so no
  // request starts (its reply would replace the backend's newer name once the snapshot is in).
  test("a submit before a replacement client's snapshot starts no name request", async () => {
    // Its own mock: after the fix nothing consumes the held reply, which must not reach later tests.
    const generation = Promise.withResolvers<Awaited<ReturnType<typeof generateMock>>>();
    const heldGenerate = mock((_input: { draftNamingId?: string }) => generation.promise);
    const heldApi = createTestApiClient({ nameGeneration: { generate: heldGenerate } });
    const view = renderHook(
      () => useWorkspaceName({ message: "fix the sidebar", debounceMs: 60_000, scope: SCOPE }),
      {
        wrapper: (props: { children: ReactNode }) => (
          <APIProvider client={heldApi}>{props.children}</APIProvider>
        ),
      }
    );
    const backendName = {
      generatedIdentity: { name: "backend-k3m9", title: "Backend name" },
      manualName: "",
      autoGenerate: true,
      lastGeneratedFor: "fix the sidebar",
    };
    const snapshot = Promise.withResolvers<void>();
    const reconnect = createReconnectClient(backendName);
    act(() =>
      getDraftStore().setClient(
        createTestApiClient({
          drafts: {
            ...reconnect.client.drafts,
            subscribe: async (input: void, opts?: { signal?: AbortSignal }) => {
              await snapshot.promise;
              return reconnect.client.drafts.subscribe(input, opts);
            },
          },
        })
      )
    );
    const waited = view.result.current.waitForGeneration();

    await act(async () => {
      snapshot.resolve();
      await waitFor(() => expect(getDraftStore().hasCurrentSnapshot()).toBe(true));
    });
    await act(async () => {
      generation.resolve({
        success: true as const,
        data: { name: "stale-a1b2", title: "Stale name", modelUsed: "test:model" },
      });
      await generation.promise;
    });
    await getDraftStore().flush(SCOPE);

    expect(getDraftStore().getView(SCOPE).nameState).toEqual(backendName);
    expect(await waited).toBeNull();
    expect(heldGenerate).toHaveBeenCalledTimes(0);
    expect(view.result.current.name).toBe("backend-k3m9");
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
