import { describe, expect, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { TerminalSessionRouter, type TerminalSubscriberCallbacks } from "./TerminalSessionRouter";

type Message = { type: "screenState"; data: string } | { type: "output"; data: string };

/** A server whose attach and onExit streams the test feeds by hand. */
function fakeServer(name: string) {
  const attaches: Array<{ input: unknown; push: (m: Message) => void; signal?: AbortSignal }> = [];
  const exits: Array<{ push: (code: number) => void }> = [];
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let releaseAttach: (() => void) | null = null;
  let holdAttach = false;
  let heldResize: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let holdResize = false;

  function stream<T>(register: (push: (value: T) => void) => void, signal?: AbortSignal) {
    const queue: T[] = [];
    let wake: (() => void) | null = null;
    register((value) => {
      queue.push(value);
      wake?.();
    });
    return (async function* () {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          wake = null;
          continue;
        }
        yield queue.shift() as T;
      }
    })();
  }

  const client = createTestApiClient({
    terminal: {
      attach: async (input: unknown, options?: { signal?: AbortSignal }) => {
        if (holdAttach) await new Promise<void>((resolve) => (releaseAttach = resolve));
        return stream<Message>(
          (push) => attaches.push({ input, push, signal: options?.signal }),
          options?.signal
        );
      },
      onExit: (_input: unknown, options?: { signal?: AbortSignal }) =>
        Promise.resolve(stream<number>((push) => exits.push({ push }), options?.signal)),
      sendInput: (input: { data: string }) => {
        inputs.push(input.data);
        return Promise.resolve();
      },
      resize: (input: { cols: number; rows: number }) => {
        resizes.push({ cols: input.cols, rows: input.rows });
        if (!holdResize) return Promise.resolve();
        return new Promise<void>((resolve, reject) => (heldResize = { resolve, reject }));
      },
    },
  });
  return {
    name,
    client,
    attaches,
    exits,
    inputs,
    resizes,
    holdNextAttach() {
      holdAttach = true;
    },
    releaseAttach() {
      holdAttach = false;
      releaseAttach?.();
    },
    holdNextResize() {
      holdResize = true;
    },
    settleResize(error?: Error) {
      holdResize = false;
      if (error == null) heldResize?.resolve();
      else heldResize?.reject(error);
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function recorder() {
  const screens: Array<{ state: string; replace: boolean }> = [];
  const output: string[] = [];
  const exits: number[] = [];
  const callbacks: TerminalSubscriberCallbacks = {
    onOutput: (data) => output.push(data),
    onScreenState: (state, options) => screens.push({ state, replace: options?.replace === true }),
    onExit: (code) => exits.push(code),
  };
  return { screens, output, exits, callbacks };
}

describe("TerminalSessionRouter across reconnects", () => {
  test("setClient() keeps the subscriber and restarts its streams on the new client", async () => {
    const first = fakeServer("first");
    const router = new TerminalSessionRouter(first.client);
    const view = recorder();
    router.subscribe("t1", view.callbacks);
    await settle();
    first.attaches[0]?.push({ type: "screenState", data: "screen-1" });
    await settle();

    const second = fakeServer("second");
    router.setClient(second.client);
    await settle();
    expect(second.attaches).toHaveLength(1);
    second.attaches[0]?.push({ type: "screenState", data: "screen-2" });
    second.attaches[0]?.push({ type: "output", data: "after" });
    // The old server's stream is superseded: nothing it sends reaches the view.
    first.attaches[0]?.push({ type: "output", data: "stale" });
    await settle();

    expect(view.screens).toEqual([
      { state: "screen-1", replace: false },
      { state: "screen-2", replace: true },
    ]);
    expect(view.output).toEqual(["after"]);
    expect(first.attaches[0]?.signal?.aborted).toBe(true);
  });

  test("an attach that resolves after a newer client arrived delivers nothing", async () => {
    const first = fakeServer("first");
    first.holdNextAttach();
    const router = new TerminalSessionRouter(first.client);
    const view = recorder();
    router.subscribe("t1", view.callbacks);
    await settle();

    const second = fakeServer("second");
    router.setClient(second.client);
    first.releaseAttach();
    await settle();
    first.attaches[0]?.push({ type: "output", data: "late" });
    second.attaches[0]?.push({ type: "output", data: "current" });
    await settle();
    expect(view.output).toEqual(["current"]);
  });

  test("offline, the session waits: input is dropped and the size is sent again later", async () => {
    const first = fakeServer("first");
    const router = new TerminalSessionRouter(first.client);
    const view = recorder();
    router.subscribe("t1", view.callbacks);
    await settle();

    router.setClient(null);
    router.sendInput("t1", "lost");
    await router.resize("t1", 120, 40);
    expect(first.inputs).toEqual([]);

    const second = fakeServer("second");
    router.setClient(second.client);
    await settle();
    expect(second.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(second.attaches).toHaveLength(1);
    router.sendInput("t1", "typed");
    await settle();
    expect(second.inputs).toEqual(["typed"]);
  });

  // attach's first message is the server's screen: taken before the resize, it has the old width.
  test.each([
    ["succeeds", undefined],
    ["fails", new Error("resize failed")],
  ])("after a reconnect, attach waits until the replayed resize %s", async (_, error) => {
    const first = fakeServer("first");
    const router = new TerminalSessionRouter(first.client);
    router.subscribe("t1", recorder().callbacks);
    await settle();
    router.setClient(null);
    await router.resize("t1", 120, 40);

    const second = fakeServer("second");
    second.holdNextResize();
    router.setClient(second.client);
    await settle();
    expect(second.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(second.attaches).toHaveLength(0);
    second.settleResize(error);
    await settle();
    expect(second.attaches).toHaveLength(1);
  });

  test("an exited session is not restarted", async () => {
    const first = fakeServer("first");
    const router = new TerminalSessionRouter(first.client);
    const view = recorder();
    router.subscribe("t1", view.callbacks);
    await settle();
    first.exits[0]?.push(0);
    await settle();
    expect(view.exits).toEqual([0]);

    const second = fakeServer("second");
    router.setClient(second.client);
    await settle();
    expect(second.attaches).toHaveLength(0);
  });

  test("a pop-out router attaches as a pop-out again", async () => {
    const router = new TerminalSessionRouter(fakeServer("first").client, { popout: true });
    router.subscribe("t1", recorder().callbacks);
    const second = fakeServer("second");
    router.setClient(second.client);
    await settle();
    expect(second.attaches[0]?.input).toEqual({ sessionId: "t1", popout: true });
  });

  test("a first screen after a reconnect does not replace when nothing was shown", async () => {
    const router = new TerminalSessionRouter(null);
    const view = recorder();
    router.subscribe("t1", view.callbacks);
    const server = fakeServer("first");
    router.setClient(server.client);
    await settle();
    server.attaches[0]?.push({ type: "screenState", data: "screen" });
    await settle();
    expect(view.screens).toEqual([{ state: "screen", replace: false }]);
  });
});
