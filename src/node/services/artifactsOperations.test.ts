import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import type { ORPCContext } from "@/node/orpc/context";
import { getWorkspaceScratchDir } from "@/node/runtime/workspaceScratchDir";
import type { RuntimeConfig } from "@/common/types/runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import * as runtimeHelpers from "@/node/runtime/runtimeHelpers";
import {
  ARTIFACTS_UNAVAILABLE_REASON,
  DEVCONTAINER_SCRATCH_MOUNT_MISSING_REASON,
  RUNTIME_SCRATCH_DIR_MISSING_REASON,
  listArtifacts,
  readArtifact,
  resolveArtifactsLocation,
} from "./artifactsOperations";

/**
 * Stands in for an SSH/Docker runtime: runs a harmless local command instead of the remote one,
 * answers the scratch mkdir like a runtime would, and records each exec's abort signal.
 */
class FakeRemoteRuntime extends LocalRuntime {
  readonly signals: Array<AbortSignal | undefined> = [];
  constructor(
    cwd: string,
    private readonly opts: { mkdirSucceeds: boolean; home?: string }
  ) {
    super(cwd);
  }
  override getXumHome(): string {
    return this.opts.home ?? "~/.mux";
  }
  override exec(command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
    this.signals.push(options.abortSignal);
    if (command.includes("mkdir -p")) {
      return super.exec(this.opts.mkdirSucceeds ? "printf /remote/scratch" : "exit 1", options);
    }
    return super.exec("exit 0", options);
  }
}

describe("artifacts operations", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "artifacts-ops-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function createContext(options: {
    enabled: boolean;
    runtimeConfig?: Record<string, unknown>;
  }): ORPCContext {
    const info = {
      id: "ws-art",
      name: "ws-art",
      projectPath: tempDir,
      projectName: "project",
      namedWorkspacePath: tempDir,
      runtimeConfig: options.runtimeConfig ?? { type: "local", srcBaseDir: tempDir },
    };
    return {
      config,
      workspaceService: {
        getInfo: mock((workspaceId: string) =>
          Promise.resolve(workspaceId === "ws-art" ? info : null)
        ),
      },
      experimentsService: { isExperimentEnabled: mock(() => options.enabled) },
    } as unknown as ORPCContext;
  }

  async function writeArtifact(relPath: string, content: string) {
    const dir = path.join(getWorkspaceScratchDir(config.sessionsDir, "ws-art"), "artifacts");
    await fsPromises.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fsPromises.writeFile(path.join(dir, relPath), content);
  }

  test("refuses every route while the experiment is off", async () => {
    const context = createContext({ enabled: false });
    const listError = await listArtifacts(context, { workspaceId: "ws-art" }).catch(
      (error: unknown) => error
    );
    const readError = await readArtifact(context, { workspaceId: "ws-art", path: "a.md" }).catch(
      (error: unknown) => error
    );
    expect(listError).toBeInstanceOf(Error);
    expect((listError as Error).message).toBe("Artifacts are disabled");
    expect(readError).toBeInstanceOf(Error);
    expect((readError as Error).message).toBe("Artifacts are disabled");
  });

  test("lists and reads the workspace scratch artifacts folder on local runtimes", async () => {
    await writeArtifact("report.md", "# Report");
    const context = createContext({ enabled: true });

    const listing = await listArtifacts(context, { workspaceId: "ws-art" });
    const read = await readArtifact(context, { workspaceId: "ws-art", path: "report.md" });

    expect(listing).toMatchObject({
      success: true,
      data: { available: true, entries: [{ path: "report.md", kind: "markdown" }] },
    });
    expect(read).toMatchObject({ success: true, data: { status: "ok", content: "# Report" } });
  });

  test("a read may lower the size cap: larger files come back too_large without bytes", async () => {
    await writeArtifact("big.txt", "x".repeat(20));
    const context = createContext({ enabled: true });

    const read = await readArtifact(context, {
      workspaceId: "ws-art",
      path: "big.txt",
      maxBytes: 10,
    });

    expect(read).toMatchObject({
      success: true,
      data: { status: "too_large", size: 20, maxBytes: 10 },
    });
    expect(read.success && "content" in read.data).toBe(false);
  });

  describe("resolveArtifactsLocation", () => {
    const fakeRuntime = { getXumHome: () => "~/.mux" } as unknown as Runtime;
    const resolve = (
      runtimeConfig: RuntimeConfig,
      extra?: {
        canMount?: boolean;
        pinnable?: boolean;
        projects?: Array<{ projectPath: string; projectName: string }>;
        runtime?: Runtime;
      }
    ) =>
      resolveArtifactsLocation(
        config.sessionsDir,
        "ws-art",
        {
          runtimeConfig,
          projectPath: tempDir,
          name: "ws-art",
          namedWorkspacePath: tempDir,
          projects: extra?.projects,
        },
        {
          createRuntime: () => extra?.runtime ?? fakeRuntime,
          canBindMountHostPaths: () => Promise.resolve(extra?.canMount ?? true),
          hostSupportsDescriptorPaths: () => Promise.resolve(extra?.pinnable ?? true),
        }
      );
    const hostArtifacts = () =>
      path.join(getWorkspaceScratchDir(config.sessionsDir, "ws-art"), "artifacts");

    test("reads host scratch dirs from this host", async () => {
      expect(await resolve({ type: "local" })).toEqual({ kind: "host", dir: hostArtifacts() });
      expect(await resolve({ type: "worktree", srcBaseDir: tempDir })).toEqual({
        kind: "host",
        dir: hostArtifacts(),
      });
      // The devcontainer scratch dir is the host dir, bind-mounted at the same path. A
      // LocalRuntime "container" sees every host path, so the mount probe passes.
      expect(
        await resolve(
          { type: "devcontainer", configPath: "dc.json" },
          { runtime: new LocalRuntime(tempDir) }
        )
      ).toEqual({ kind: "host", dir: hostArtifacts(), containerWritable: true });
    });

    test("reads a devcontainer mount inside the container where folders cannot be pinned", async () => {
      // Without descriptor paths the host's pathname checks can be raced by the container writer.
      const container = new LocalRuntime(tempDir);
      expect(
        await resolve(
          { type: "devcontainer", configPath: "dc.json" },
          { runtime: container, pinnable: false }
        )
      ).toEqual({ kind: "runtime", runtime: container, dir: hostArtifacts() });
    });

    test("is unavailable in a devcontainer that does not see the scratch mount", async () => {
      let probes = 0;
      class NoMountRuntime extends LocalRuntime {
        override exec(_command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
          probes++;
          return super.exec("exit 1", options);
        }
      }
      const devcontainer = { type: "devcontainer", configPath: "dc.json" } as const;
      expect(await resolve(devcontainer, { runtime: new NoMountRuntime(tempDir) })).toEqual({
        kind: "unavailable",
        reason: DEVCONTAINER_SCRATCH_MOUNT_MISSING_REASON,
      });
      expect(probes).toBe(1);

      // Once the container sees the mount, the positive result is kept: no probe per poll.
      const seesHost = new LocalRuntime(tempDir);
      expect(await resolve(devcontainer, { runtime: seesHost })).toEqual({
        kind: "host",
        dir: hostArtifacts(),
        containerWritable: true,
      });
      expect(await resolve(devcontainer, { runtime: new NoMountRuntime(tempDir) })).toEqual({
        kind: "host",
        dir: hostArtifacts(),
        containerWritable: true,
      });
      expect(probes).toBe(1);
    });

    test("reads SSH and Docker scratch dirs through the runtime, never the host", async () => {
      const remote = new FakeRemoteRuntime(tempDir, { mkdirSucceeds: true });
      expect(
        await resolve({ type: "ssh", host: "box", srcBaseDir: "~/src" }, { runtime: remote })
      ).toEqual({
        kind: "runtime",
        runtime: remote,
        dir: "~/.mux/workspace-scratch/ws-art/artifacts",
      });
      expect(await resolve({ type: "docker", image: "img" }, { runtime: remote })).toEqual({
        kind: "runtime",
        runtime: remote,
        dir: "/var/mux/scratch/artifacts",
      });
    });

    test("is unavailable while the runtime cannot create the scratch dir", async () => {
      // A home no other test uses, so no earlier success is cached for this dir.
      const ssh = { type: "ssh", host: "box", srcBaseDir: "~/src" } as const;
      const failing = new FakeRemoteRuntime(tempDir, { mkdirSucceeds: false, home: "~/.fail" });
      expect(await resolve(ssh, { runtime: failing })).toEqual({
        kind: "unavailable",
        reason: RUNTIME_SCRATCH_DIR_MISSING_REASON,
      });
      // A failure is not cached: the next poll retries, and a success is kept.
      const working = new FakeRemoteRuntime(tempDir, { mkdirSucceeds: true, home: "~/.fail" });
      expect(await resolve(ssh, { runtime: working })).toMatchObject({ kind: "runtime" });
      expect(await resolve(ssh, { runtime: failing })).toMatchObject({ kind: "runtime" });
    });

    test("is unavailable where no scratch dir exists", async () => {
      const unavailable = { kind: "unavailable" as const, reason: ARTIFACTS_UNAVAILABLE_REASON };
      expect(
        await resolve({ type: "devcontainer", configPath: "dc.json" }, { canMount: false })
      ).toEqual(unavailable);
      const projects = [
        { projectPath: "/a", projectName: "a" },
        { projectPath: "/b", projectName: "b" },
      ];
      expect(await resolve({ type: "docker", image: "img" }, { projects })).toEqual(unavailable);
    });
  });

  test("passes the request's abort signal to every remote exec", async () => {
    const remote = new FakeRemoteRuntime(tempDir, { mkdirSucceeds: true, home: "~/.abort" });
    const createRuntime = spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(
      remote
    );
    const context = createContext({
      enabled: true,
      runtimeConfig: { type: "ssh", host: "box", srcBaseDir: "~/src" },
    });
    const controller = new AbortController();
    try {
      await listArtifacts(context, { workspaceId: "ws-art" }, controller.signal);
      await readArtifact(context, { workspaceId: "ws-art", path: "a.md" }, controller.signal);
    } finally {
      createRuntime.mockRestore();
    }
    // mkdir (first call only, then cached), list, read.
    expect(remote.signals).toHaveLength(3);
    for (const signal of remote.signals) expect(signal).toBe(controller.signal);
  });

  test("returns an error for unknown workspaces", async () => {
    const context = createContext({ enabled: true });
    expect(await listArtifacts(context, { workspaceId: "nope" })).toEqual({
      success: false,
      error: "Workspace not found: nope",
    });
  });
});
