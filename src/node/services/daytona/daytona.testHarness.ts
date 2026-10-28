import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import type { DaytonaSshConfigWriter, DaytonaSshGateway } from "@/node/runtime/daytonaSshConfig";
import type { SSHTransport } from "@/node/runtime/transports";
import { DAYTONA_LABEL_INSTANCE } from "./daytonaSandboxes";
import { InMemoryDaytonaSandboxIds } from "./daytonaSandboxIds";
import { DaytonaService } from "./daytonaService";

/**
 * In-memory Daytona control plane for unit tests: enough of the REST API (by id or name, as
 * Daytona accepts) to drive the runtime, the reconciler and the archive hook end to end
 * through the real DaytonaService and DaytonaClient.
 */

function requestBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

export interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  cpu: number;
  memory: number;
  disk: number;
  labels: Record<string, string>;
  /** GETs left before a transitional state settles (creating/starting -> started). */
  pendingPolls: number;
  /** States successive GETs observe instead (the last one repeats); start and stop keep to it. */
  stateScript?: string[];
  errorReason?: string;
  /** Daytona's sandboxClass ("linux-vm", "container", "windows"); unset like an older API. */
  sandboxClass?: string;
  /** GPU units; Daytona's GPU sandboxes carry a positive count. */
  gpu?: number;
}

export class FakeDaytonaControlPlane {
  readonly sandboxes = new Map<string, FakeSandbox>();
  /** `METHOD /path` for every request (query strings omitted). */
  readonly calls: string[] = [];
  /** `METHOD /path <Authorization header>` for every answered request. */
  readonly authorizedCalls: string[] = [];
  readonly createBodies: Array<Record<string, unknown>> = [];
  readonly revokedTokens: string[] = [];
  /** The organization's snapshots; `listedOnly` ones only come with the list, not by name. */
  readonly snapshots: Array<{
    name: string;
    sandboxClass?: string;
    gpu?: number;
    listedOnly?: boolean;
  }> = [];
  /** The ssh gateway GET /config advertises; a test moves it or rotates its host keys. */
  gateway: DaytonaSshGateway = {
    host: "ssh.daytona.test",
    port: 22,
    hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey"],
  };
  /** The snapshot GET /config advertises as the deployment default; unset advertises none. */
  defaultSnapshot?: string;
  /** Answer POST /sandbox with 400 when it carries cpu/memory/disk (fixed-resource snapshot). */
  rejectCreateResources = false;
  /** Leave `disk` out of sandbox responses, which Daytona's schema allows. */
  omitDisk = false;
  /** Leave `cpu` and `memory` out of sandbox responses, which Daytona's schema allows. */
  omitCompute = false;
  /** Resources a sandbox gets when created without any. */
  snapshotResources = { cpu: 1, memory: 1, disk: 3 };
  /** Labels of a sandbox added without any; the rig makes it this install's. */
  defaultLabels: Record<string, string> = {};
  /** Routes (`METHOD /path`) that never answer, for timeout tests. */
  readonly hangingRoutes = new Set<string>();
  /** Routes (`METHOD /path`) that answer 500. */
  readonly failingRoutes = new Set<string>();
  /** POST /sandbox creates the sandbox, then answers 500 (the create's outcome looks unknown). */
  failAfterCreate = false;
  /** Runs when a route (`METHOD /path`) is requested; the plane answers once it settles. */
  readonly onRequest = new Map<string, () => Promise<unknown>>();
  private nextId = 1;
  private nextToken = 1;
  /** Minted tokens are `<prefix><n>`: real tokens never repeat across accounts. */
  tokenPrefix = "tok";
  /** When set, a sandbox list without this API key is refused with 401. */
  apiKey?: string;
  /** A proxy that echoes the request URI and its Authorization header in a failed revoke. */
  revokeEchoesRequest = false;
  /**
   * Xum's side, not Daytona's: the ids the workspace config records per sandbox name. A
   * sandbox a test adds is recorded, as Xum records the sandboxes it creates.
   */
  readonly recordedIds = new InMemoryDaytonaSandboxIds();

  constructor(private readonly now: () => number) {}

  readonly fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const route = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}`;
    this.calls.push(route);
    if (this.hangingRoutes.has(route)) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const hook = this.onRequest.get(route) ?? (() => Promise.resolve());
    return hook().then(() => this.handle(route, url, init));
  }) as typeof fetch;

  addSandbox(
    partial: Partial<FakeSandbox> & { id: string },
    options: { recorded?: boolean } = {}
  ): FakeSandbox {
    const sandbox: FakeSandbox = {
      name: partial.id,
      state: "started",
      cpu: 2,
      memory: 4,
      disk: 10,
      labels: { ...this.defaultLabels },
      pendingPolls: 0,
      ...partial,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    if (options.recorded !== false) this.recordedIds.ids.set(sandbox.name, sandbox.id);
    return sandbox;
  }

  find(idOrName: string): FakeSandbox | undefined {
    return (
      this.sandboxes.get(idOrName) ?? [...this.sandboxes.values()].find((s) => s.name === idOrName)
    );
  }

  countCalls(route: string): number {
    return this.calls.filter((call) => call === route).length;
  }

  private handle(route: string, url: URL, init?: RequestInit): Response {
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? "" : JSON.stringify(body), { status });
    const fail = (status: number, message: string) => json(status, { statusCode: status, message });
    if (this.failingRoutes.has(route)) return fail(500, "Internal error");
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    this.authorizedCalls.push(`${route} ${auth}`);
    // Only the sandbox list checks it: that is the request a connection test makes.
    if (route === "GET /sandbox" && this.apiKey !== undefined && auth !== `Bearer ${this.apiKey}`) {
      return fail(401, "Invalid credentials");
    }

    if (route === "GET /config") {
      return json(200, {
        sshGatewayHost: this.gateway.host,
        sshGatewayPort: this.gateway.port,
        sshGatewayHostKeys: this.gateway.hostKeys,
        ...(this.defaultSnapshot ? { defaultSnapshot: this.defaultSnapshot } : {}),
      });
    }
    if (route === "GET /sandbox") {
      const labels = url.searchParams.get("labels");
      const wanted = labels ? (JSON.parse(labels) as Record<string, string>) : {};
      const items = [...this.sandboxes.values()]
        .filter((sb) => Object.entries(wanted).every(([key, value]) => sb.labels[key] === value))
        .map((sb) => this.view(sb));
      return json(200, { items, nextCursor: null });
    }
    if (route === "POST /sandbox") {
      const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
      this.createBodies.push(body);
      const hasResources = body.cpu != null || body.memory != null || body.disk != null;
      if (this.rejectCreateResources && hasResources) {
        return fail(400, "Cannot specify Sandbox resources when using a snapshot");
      }
      // Daytona names are unique per organization: a taken name is a conflict.
      if (typeof body.name === "string" && this.find(body.name)) {
        return fail(409, `Sandbox with name ${body.name} already exists`);
      }
      const id = `sb-${this.nextId++}`;
      const sandbox = this.addSandbox({
        id,
        name: typeof body.name === "string" ? body.name : id,
        state: "creating",
        pendingPolls: 1,
        cpu: typeof body.cpu === "number" ? body.cpu : this.snapshotResources.cpu,
        memory: typeof body.memory === "number" ? body.memory : this.snapshotResources.memory,
        disk: typeof body.disk === "number" ? body.disk : this.snapshotResources.disk,
        labels: (body.labels as Record<string, string> | undefined) ?? {},
      });
      if (this.failAfterCreate) return fail(500, "Internal error");
      return json(200, this.view(sandbox));
    }

    if (route === "GET /snapshots") {
      return json(200, {
        items: this.snapshots,
        total: this.snapshots.length,
        page: 1,
        totalPages: 1,
      });
    }
    const snapshotMatch = /^GET \/snapshots\/([^/]+)$/.exec(route);
    if (snapshotMatch) {
      const snapshot = this.snapshots.find(
        (s) => s.name === decodeURIComponent(snapshotMatch[1]) && !s.listedOnly
      );
      return snapshot ? json(200, snapshot) : fail(404, "Snapshot not found");
    }

    const match = /^(GET|POST|PUT|DELETE) \/sandbox\/([^/]+)(?:\/(.+))?$/.exec(route);
    if (!match) return fail(500, `unexpected ${route}`);
    const [, method, rawId, action] = match;
    const idOrName = decodeURIComponent(rawId);
    // last-activity takes the real id only (no name lookup), as in Daytona's API.
    const sandbox = action === "last-activity" ? this.sandboxes.get(idOrName) : this.find(idOrName);
    if (!sandbox) return fail(404, "Sandbox not found");

    if (method === "GET" && !action) {
      const script = sandbox.stateScript;
      if (script?.length) {
        sandbox.state = (script.length > 1 ? script.shift() : script[0]) ?? sandbox.state;
      } else if (sandbox.pendingPolls > 0) {
        sandbox.pendingPolls -= 1;
      } else if (sandbox.state === "creating" || sandbox.state === "starting") {
        sandbox.state = "started";
      }
      return json(200, this.view(sandbox));
    }
    if (method === "DELETE" && !action) {
      this.sandboxes.delete(sandbox.id);
      return json(200, {});
    }
    switch (`${method} ${action}`) {
      case "POST start":
        if (!sandbox.stateScript) sandbox.state = "starting";
        return json(200, {});
      case "POST stop":
        if (!sandbox.stateScript) sandbox.state = "stopped";
        return json(200, {});
      case "POST resize":
        return this.resize(sandbox, JSON.parse(requestBody(init)) as Record<string, number>);
      case "POST ssh-access": {
        const minutes = Number(url.searchParams.get("expiresInMinutes"));
        return json(200, {
          token: `${this.tokenPrefix}${this.nextToken++}`,
          expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
        });
      }
      case "DELETE ssh-access":
        if (this.revokeEchoesRequest) {
          return json(500, { message: `Revoke failed for ${url.toString()} (${auth})` });
        }
        this.revokedTokens.push(url.searchParams.get("token") ?? "");
        return json(200, {});
      case "POST last-activity":
        return json(200, {});
      default:
        return fail(500, `unexpected ${route}`);
    }
  }

  /** Daytona's rules: disk only grows and needs a stopped box; running boxes only grow. */
  private resize(sandbox: FakeSandbox, body: Record<string, number>): Response {
    const running = sandbox.state === "started";
    const shrinks =
      (body.cpu ?? sandbox.cpu) < sandbox.cpu || (body.memory ?? sandbox.memory) < sandbox.memory;
    if (body.disk !== undefined && (body.disk < sandbox.disk || running)) {
      return new Response(JSON.stringify({ message: "disk resize needs a stopped sandbox" }), {
        status: 400,
      });
    }
    if (running && shrinks) {
      return new Response(JSON.stringify({ message: "cannot shrink a running sandbox" }), {
        status: 400,
      });
    }
    sandbox.cpu = body.cpu ?? sandbox.cpu;
    sandbox.memory = body.memory ?? sandbox.memory;
    sandbox.disk = body.disk ?? sandbox.disk;
    return new Response(JSON.stringify(this.view(sandbox)), { status: 200 });
  }

  private view(sandbox: FakeSandbox) {
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
      ...(this.omitCompute ? {} : { cpu: sandbox.cpu, memory: sandbox.memory }),
      ...(this.omitDisk ? {} : { disk: sandbox.disk }),
      labels: sandbox.labels,
      ...(sandbox.sandboxClass ? { sandboxClass: sandbox.sandboxClass } : {}),
      ...(sandbox.gpu !== undefined ? { gpu: sandbox.gpu } : {}),
      ...(sandbox.errorReason ? { errorReason: sandbox.errorReason } : {}),
    };
  }
}

/** Records ssh config writes instead of touching `~/.ssh/config`. */
export class FakeDaytonaSshConfigWriter implements Pick<
  DaytonaSshConfigWriter,
  | "writeSandbox"
  | "ensureManagedBlock"
  | "updateToken"
  | "repointGateway"
  | "removeSandbox"
  | "readTokens"
> {
  /** Current token per sandbox alias, as the include file would hold it. */
  readonly tokens = new Map<string, string>();
  readonly fullWrites: string[] = [];
  readonly removed: string[] = [];
  /** Fails every first write of a sandbox (a setup failure after the sandbox exists). */
  writeError?: Error;

  /** The gateway the include file and known_hosts point at, as last written or repointed. */
  gateway?: DaytonaSshGateway;
  readonly repoints: DaytonaSshGateway[] = [];
  writeSandbox(input: {
    sandboxName: string;
    token: string;
    gateway: DaytonaSshGateway;
  }): Promise<void> {
    if (this.writeError) return Promise.reject(this.writeError);
    this.fullWrites.push(input.sandboxName);
    this.gateway = input.gateway;
    this.tokens.set(input.sandboxName, input.token);
    return Promise.resolve();
  }

  /** False once a test removes the `~/.ssh/config` block, as a dotfiles tool might. */
  managedBlockPresent = false;

  ensureManagedBlock(): Promise<void> {
    this.managedBlockPresent = true;
    return Promise.resolve();
  }

  updateToken(input: {
    sandboxName: string;
    token: string;
    gateway: DaytonaSshGateway;
  }): Promise<void> {
    this.gateway = input.gateway;
    this.tokens.set(input.sandboxName, input.token);
    return Promise.resolve();
  }

  repointGateway(gateway: DaytonaSshGateway): Promise<void> {
    this.repoints.push(gateway);
    this.gateway = gateway;
    return Promise.resolve();
  }

  removeSandbox(sandboxName: string): Promise<void> {
    this.removed.push(sandboxName);
    this.tokens.delete(sandboxName);
    return Promise.resolve();
  }

  readTokens(): Promise<Array<{ sandboxName: string; token: string }>> {
    return Promise.resolve(
      [...this.tokens].map(([sandboxName, token]) => ({ sandboxName, token }))
    );
  }
}

export interface DaytonaTestRig {
  rootDir: string;
  plane: FakeDaytonaControlPlane;
  writer: FakeDaytonaSshConfigWriter;
  service: DaytonaService;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

/**
 * A real DaytonaService over the fake control plane, with a test clock whose sleeps advance
 * time instantly. `apiKey: null` builds one without credentials.
 */
export async function createDaytonaTestRig(
  options: { apiKey?: string | null } = {}
): Promise<DaytonaTestRig> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-daytona-test-"));
  const clock = { now: Date.parse("2026-01-01T00:00:00Z") };
  const plane = new FakeDaytonaControlPlane(() => clock.now);
  const writer = new FakeDaytonaSshConfigWriter();
  const env: NodeJS.ProcessEnv =
    options.apiKey === null ? {} : { DAYTONA_API_KEY: options.apiKey ?? "test-key" };
  const service = new DaytonaService({
    credentialsStore: new DaytonaCredentialsStore(rootDir, env),
    sandboxIds: plane.recordedIds,
    rootDir,
    sshConfigWriter: writer,
    fetch: plane.fetch,
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  // Sandboxes a test adds count as ones Xum created, as most tests need; a foreign one sets
  // its own labels.
  plane.defaultLabels = { [DAYTONA_LABEL_INSTANCE]: await service.sandboxes.getInstanceId() };
  return {
    rootDir,
    plane,
    writer,
    service,
    clock,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

/** Runs each "remote" command in a local bash whose HOME is `home`: the sandbox end of ssh. */
export function localShellTransport(home: string): SSHTransport {
  const config = { host: "placeholder.xum--daytona" };
  return {
    spawnRemoteProcess: (command) =>
      Promise.resolve({
        process: spawn("bash", ["-c", command], {
          env: { PATH: process.env.PATH ?? "", HOME: home },
          stdio: "pipe",
        }),
      }),
    isConnectionFailure: (exitCode) => exitCode === 255,
    acquireConnection: () => Promise.resolve(),
    getConfig: () => config,
    createPtySession: () => Promise.reject(new Error("no PTY in this test")),
    openReverseForward: () => Promise.reject(new Error("no forwards in this test")),
  };
}

/** The fake control plane with one sandbox, "sb-1", for tests below the runtime; API key "k". */
export class ScriptedSandboxControlPlane extends FakeDaytonaControlPlane {
  constructor(now: () => number) {
    super(now);
    this.apiKey = "k";
    this.gateway = { host: "ssh.test", port: 22, hostKeys: ["ssh-ed25519 AAAA"] };
    this.addSandbox({ id: "sb-1" });
  }

  get revoked(): string[] {
    return this.revokedTokens;
  }
}
