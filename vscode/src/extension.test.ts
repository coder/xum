import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

// Drives the real chat view provider through activate() against real local oRPC servers to check
// when bridged calls reuse the validated API client (#5196).

type Listener<T> = (event: T) => void;

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }
}

interface Disposable {
  dispose(): void;
}

const settings = new Map<string, unknown>();
const configurationChanges = new Emitter<{ affectsConfiguration(section: string): boolean }>();
let registeredProvider: unknown = null;

const fakeUri = (value: string) => ({ toString: () => value });

// The real "vscode" module exists only inside the extension host, so there is nothing to restore.
void mock.module("vscode", () => ({
  Uri: {
    joinPath: (base: { toString(): string }, ...parts: string[]) =>
      fakeUri([base.toString(), ...parts].join("/")),
    file: (path: string) => fakeUri(`file://${path}`),
    parse: (value: string) => fakeUri(value),
  },
  window: {
    createOutputChannel: () => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
    registerWebviewViewProvider: (_viewId: string, provider: unknown) => {
      registeredProvider = provider;
      return { dispose: () => undefined };
    },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: (section: string) => ({
      get: (key: string) => settings.get(`${section}.${key}`),
    }),
    onDidChangeConfiguration: configurationChanges.event,
  },
  commands: {
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: () => Promise.resolve(undefined),
  },
}));

const WORKSPACE = {
  id: "ws-1",
  name: "main",
  projectName: "xum",
  projectPath: "/tmp/xum",
  runtimeConfig: { type: "local" },
  createdAt: "2026-10-01T00:00:00.000Z",
};

const GET_OUTPUT = ["workspace", "backgroundBashes", "getOutput"];
const SUBSCRIBE = ["workspace", "backgroundBashes", "subscribe"];

// Every server request and posted message wakes waiters, so tests wait on signals, not time.
const waiters = new Set<() => void>();
function notify(): void {
  for (const waiter of [...waiters]) waiter();
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`timed out waiting for ${label}`));
    }, 5_000);
    const check = () => {
      if (!predicate()) return;
      clearTimeout(timeout);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
  });
}

function startServer(initialToken: string) {
  const hits = new Map<string, number>();
  const state: { token: string; hold: Promise<void> | null; heldCalls: number } = {
    token: initialToken,
    // getOutput waits on this while set, so a test can hold a call in flight.
    hold: null,
    heldCalls: 0,
  };
  const authed = os.$context<{ authorization: string | null }>().use(({ context, next }) => {
    if (context.authorization !== `Bearer ${state.token}`) {
      throw new ORPCError("UNAUTHORIZED");
    }
    return next();
  });
  const router = {
    general: { ping: authed.handler(() => "pong") },
    workspace: {
      list: authed.handler(() => [WORKSPACE]),
      activity: { list: authed.handler(() => ({})) },
      backgroundBashes: {
        getOutput: authed.handler(async () => {
          const hold = state.hold;
          if (hold) {
            state.heldCalls += 1;
            notify();
            await hold;
          }
          return {
            success: true,
            data: { status: "running", output: "line", nextOffset: 4, truncatedStart: false },
          };
        }),
        subscribe: authed.handler(async function* () {
          yield { processes: [], foregroundToolCallIds: [] };
          throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "stream lost" });
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      notify();
      if (path === "/health") return Response.json({ status: "ok" });
      const { matched, response } = await handler.handle(request, {
        prefix: "/orpc",
        context: { authorization: request.headers.get("authorization") },
      });
      return matched ? response : new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    hits: (path: string) => hits.get(path) ?? 0,
    validations: () => hits.get("/orpc/general/ping") ?? 0,
    getOutputs: () => hits.get("/orpc/workspace/backgroundBashes/getOutput") ?? 0,
    stop: () => server.stop(true),
  };
}

type TestServer = ReturnType<typeof startServer>;

interface PostedMessage {
  type: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  kind?: string;
  streamId?: string;
}

const SECRET_KEY = "mux.serverAuthToken";
const servers: TestServer[] = [];
const subscriptions: Disposable[] = [];
let activate: (context: unknown) => Promise<void>;
let xumRoot: string;
const savedXumRoot = process.env.XUM_ROOT;

beforeAll(async () => {
  // Discovery must never read the host's server lockfile.
  xumRoot = await mkdtemp(join(tmpdir(), "xum-vscode-ext-"));
  process.env.XUM_ROOT = xumRoot;
  ({ activate } = (await import("./extension")) as unknown as {
    activate: (context: unknown) => Promise<void>;
  });
});

afterAll(async () => {
  if (savedXumRoot === undefined) delete process.env.XUM_ROOT;
  else process.env.XUM_ROOT = savedXumRoot;
  await rm(xumRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  for (const server of servers.splice(0)) server.stop();
  settings.clear();
});

async function setup() {
  const server = startServer("token-a");
  servers.push(server);
  settings.set("mux.connectionMode", "server-only");
  settings.set("mux.serverUrl", server.url);

  const secrets = new Map<string, string>([[SECRET_KEY, "token-a"]]);
  const secretChanges = new Emitter<{ key: string }>();
  const memento = () => {
    const values = new Map<string, unknown>();
    return {
      get: (key: string) => values.get(key),
      update: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
    };
  };
  const context = {
    subscriptions,
    extensionUri: fakeUri("file:///extension"),
    workspaceState: memento(),
    globalState: memento(),
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      onDidChange: secretChanges.event,
    },
  };

  registeredProvider = null;
  await activate(context);
  const provider = registeredProvider as { resolveWebviewView(view: unknown): void } | null;
  if (!provider) throw new Error("activate did not register the chat view provider");

  const posted: PostedMessage[] = [];
  let receive: ((message: unknown) => void) | null = null;
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        receive = handler;
        return { dispose: () => undefined };
      },
      postMessage: (message: PostedMessage) => {
        posted.push(message);
        notify();
        return Promise.resolve(true);
      },
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  provider.resolveWebviewView(view);
  const send = (message: unknown) => {
    if (!receive) throw new Error("the provider did not subscribe to webview messages");
    receive(message);
  };

  const workspaceLists = () => posted.filter((message) => message.type === "workspaces").length;
  const refresh = async (type: "ready" | "refreshWorkspaces") => {
    const before = workspaceLists();
    send({ type });
    await until(() => workspaceLists() > before, `${type} to post the workspace list`);
  };
  await refresh("ready");

  let nextRequestId = 0;
  const startCall = (path: string[] = GET_OUTPUT) => {
    const requestId = `req-${++nextRequestId}`;
    send({
      type: "orpcCall",
      requestId,
      path,
      input: { workspaceId: WORKSPACE.id, processId: "bash-1", tailBytes: 1000 },
    });
    return requestId;
  };
  const response = async (requestId: string) => {
    const find = () =>
      posted.find((message) => message.type === "orpcResponse" && message.requestId === requestId);
    await until(() => find() !== undefined, `the response to ${requestId}`);
    return find()!;
  };
  const call = async (path?: string[]) => response(startCall(path));

  return {
    server,
    posted,
    refresh,
    startCall,
    response,
    call,
    cancel: (requestId: string) => send({ type: "orpcCancel", requestId }),
    setSecret: (token: string) => secrets.set(SECRET_KEY, token),
    fireSecretChange: () => secretChanges.fire({ key: SECRET_KEY }),
  };
}

describe("chat view bridged oRPC calls reuse the validated API client (#5196)", () => {
  test("a burst and a run of calls validate the connection once", async () => {
    const harness = await setup();
    const { server } = harness;
    const health = server.hits("/health");
    const validations = server.validations();

    const burst = await Promise.all(
      Array.from({ length: 5 }, () => harness.response(harness.startCall()))
    );
    for (let i = 0; i < 3; i++) burst.push(await harness.call());

    expect(burst.every((message) => message.ok === true)).toBe(true);
    expect(server.hits("/health") - health).toBe(1);
    expect(server.validations() - validations).toBe(1);
    expect(server.getOutputs()).toBe(8);
  });

  test("a rejected call drops the client and the next call re-validates once, never reusing a failed validation", async () => {
    const harness = await setup();
    const { server } = harness;
    expect((await harness.call()).ok).toBe(true);
    const validations = server.validations();

    // The server restarted with a new token; no secret change event fires.
    server.state.token = "token-b";
    const rejected = await harness.call();
    expect(rejected.ok).toBe(false);
    expect(server.validations()).toBe(validations);

    const refused = await harness.call();
    expect(refused.error).toContain("rejected the auth token");
    expect(server.validations()).toBe(validations + 1);

    harness.setSecret("token-b");
    expect((await harness.call()).ok).toBe(true);
    expect((await harness.call()).ok).toBe(true);
    expect(server.validations()).toBe(validations + 2);
  });

  test("a bridged stream that errors drops the client", async () => {
    const harness = await setup();
    const { server, posted } = harness;
    const stream = await harness.call(SUBSCRIBE);
    expect(stream.kind).toBe("stream");
    await until(
      () =>
        posted.some(
          (message) => message.type === "orpcStreamError" && message.streamId === stream.streamId
        ),
      "the stream error"
    );
    const validations = server.validations();

    expect((await harness.call()).ok).toBe(true);
    expect(server.validations()).toBe(validations + 1);
  });

  test("a cancelled call keeps the client", async () => {
    const harness = await setup();
    const { server } = harness;
    expect((await harness.call()).ok).toBe(true);
    const validations = server.validations();

    let release: () => void = () => undefined;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = harness.startCall();
    await until(() => server.state.heldCalls === 1, "the server to hold the call");
    server.state.hold = null;
    harness.cancel(held);

    expect((await harness.call()).ok).toBe(true);
    expect((await harness.call()).ok).toBe(true);
    expect(server.validations()).toBe(validations);
    release();
  });

  test("a workspace refresh makes the next call validate again", async () => {
    const harness = await setup();
    const { server } = harness;
    expect((await harness.call()).ok).toBe(true);

    await harness.refresh("refreshWorkspaces");
    const validations = server.validations();
    expect((await harness.call()).ok).toBe(true);
    expect((await harness.call()).ok).toBe(true);
    expect(server.validations()).toBe(validations + 1);
  });

  test("a changed server URL or auth token secret drops the client", async () => {
    const harness = await setup();
    const serverA = harness.server;
    expect((await harness.call()).ok).toBe(true);

    const serverB = startServer("token-a");
    servers.push(serverB);
    settings.set("mux.serverUrl", serverB.url);
    configurationChanges.fire({ affectsConfiguration: (section) => section === "mux.serverUrl" });
    const callsToA = serverA.getOutputs();
    expect((await harness.call()).ok).toBe(true);
    expect(serverB.validations()).toBe(1);
    expect(serverB.getOutputs()).toBe(1);
    expect(serverA.getOutputs()).toBe(callsToA);

    harness.fireSecretChange();
    expect((await harness.call()).ok).toBe(true);
    expect(serverB.validations()).toBe(2);
  });

  test("a late failure from a replaced client does not drop its replacement", async () => {
    const harness = await setup();
    const { server } = harness;
    expect((await harness.call()).ok).toBe(true);

    let fail: (error: Error) => void = () => undefined;
    server.state.hold = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const held = harness.startCall();
    await until(() => server.state.heldCalls === 1, "the server to hold the call");
    server.state.hold = null;

    await harness.refresh("refreshWorkspaces");
    expect((await harness.call()).ok).toBe(true);
    const validations = server.validations();

    fail(new Error("process table unavailable"));
    expect((await harness.response(held)).ok).toBe(false);

    expect((await harness.call()).ok).toBe(true);
    expect(server.validations()).toBe(validations);
  });
});
