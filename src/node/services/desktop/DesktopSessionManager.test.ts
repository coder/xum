import * as fs from "fs/promises";
import * as nodeFs from "node:fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, spyOn, test } from "bun:test";
import type { Workspace } from "@/common/types/project";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { PortableDesktopSession } from "./PortableDesktopSession";
import { DesktopTokenManager } from "./DesktopTokenManager";
import { getDesktopBootstrap } from "./desktopOperations";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Config } from "@/node/config";
import { ExperimentsService } from "@/node/services/experimentsService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { DesktopSessionManager } from "./DesktopSessionManager";

interface PortableDesktopStartupOutput {
  runtimeDir: string;
  display: number;
  vncPort: number;
  geometry: string;
  depth: number;
  dpi: number;
  desktopSizeMode: string;
  sessionDir: string;
  cleanupSessionDirOnStop: boolean;
  xvncPid: number;
  openboxPid: number;
  detached: boolean;
  stateFile?: string;
  startedAt: string;
  sessionId?: string;
}

interface PortableDesktopShimConfig {
  startupInfo?: PortableDesktopStartupOutput;
  actionRecordPath?: string;
}

interface DesktopManagerHarness {
  tempDir: string;
  config: Config;
  originalPath: string | undefined;
}

const TEST_STARTED_AT = "2026-03-14T14:33:30Z";

function createStartupInfo(options: {
  display: number;
  vncPort: number;
  geometry: string;
  sessionDir?: string;
  stateFile?: string;
  sessionId?: string;
}): PortableDesktopStartupOutput {
  return {
    runtimeDir: "/home/coder/.cache/portabledesktop/runtime-a4db4a81d62e",
    display: options.display,
    vncPort: options.vncPort,
    geometry: options.geometry,
    depth: 24,
    dpi: 96,
    desktopSizeMode: "fixed",
    sessionDir: options.sessionDir ?? `/tmp/portabledesktop-${options.display}`,
    cleanupSessionDirOnStop: true,
    xvncPid: 4010171,
    openboxPid: 4010180,
    detached: true,
    stateFile: options.stateFile,
    startedAt: TEST_STARTED_AT,
    sessionId: options.sessionId,
  };
}

let desktopManagerTestLock: Promise<void> = Promise.resolve();

async function withDesktopManagerHarness(
  run: (harness: DesktopManagerHarness) => Promise<void>
): Promise<void> {
  const previousLock = desktopManagerTestLock;
  let releaseLock: (() => void) | undefined;
  desktopManagerTestLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-desktop-session-manager-test-"));
  const config = new Config(tempDir);
  const originalPath = process.env.PATH;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    await config.editConfig((current) => {
      current.projects.set("/tmp/project-1", {
        workspaces: [
          "platform",
          "missing-binary",
          "local",
          "reuse",
          "archiving",
          "dead",
          "close-one",
          "close-two",
          "action",
        ]
          .map(
            (suffix): Workspace => ({
              id: `workspace-${suffix}`,
              name: `workspace-${suffix}`,
              path: `/tmp/project-1/workspace-${suffix}`,
              runtimeConfig: { type: "local" },
            })
          )
          .concat([
            {
              id: "workspace-ssh",
              name: "workspace-ssh",
              path: "/tmp/project-1/ssh",
              runtimeConfig: { type: "ssh", host: "example.com", srcBaseDir: "~/mux" },
            },
            {
              id: "workspace-worktree",
              name: "workspace-worktree",
              path: "/tmp/project-1/worktree",
              runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/worktrees" },
            },
          ] as Workspace[]),
      });
      return current;
    });
    await run({ tempDir, config, originalPath });
  } finally {
    process.env.PATH = originalPath;
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    releaseLock?.();
  }
}

// Keep the manager shim aligned with the real PortableDesktop lifecycle so
// DesktopSessionManager exercises detached startup, state-file liveness, and
// state-file-based follow-up commands instead of the older long-lived process model.
function buildControllerScript(configPath: string): string {
  return `
const fs = require("fs");
const path = require("path");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const command = process.argv[2];
const args = process.argv.slice(3);

function readFlag(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function getPositionals() {
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    positionals.push(value);
  }
  return positionals;
}

function appendActionRecord(entry) {
  if (!config.actionRecordPath) {
    return;
  }

  const existing = fs.existsSync(config.actionRecordPath)
    ? JSON.parse(fs.readFileSync(config.actionRecordPath, "utf8"))
    : [];
  existing.push(entry);
  fs.writeFileSync(config.actionRecordPath, JSON.stringify(existing));
}

switch (command) {
  case "up": {
    const stateFile = readFlag("--state-file") ?? config.startupInfo?.stateFile;
    const startupInfo = {
      ...config.startupInfo,
      stateFile,
    };
    if (stateFile) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(startupInfo));
    }
    process.stdout.write(JSON.stringify(startupInfo) + "\\n");
    break;
  }
  case "down": {
    const stateFile = readFlag("--state-file");
    if (stateFile) {
      fs.rmSync(stateFile, { force: true });
    }
    break;
  }
  case "mouse": {
    const positionals = getPositionals();
    appendActionRecord({
      command,
      subcommand: positionals[0],
      args: positionals.slice(1),
      stateFile: readFlag("--state-file"),
    });
    break;
  }
  case "keyboard": {
    const positionals = getPositionals();
    appendActionRecord({
      command,
      subcommand: positionals[0],
      args: positionals.slice(1),
      stateFile: readFlag("--state-file"),
    });
    break;
  }
  case "screenshot": {
    const positionals = getPositionals();
    const outputPath = positionals[0] ?? readFlag("--file");
    if (!outputPath) {
      process.stderr.write("Missing screenshot output path");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from("manager-screenshot", "utf8"));
    break;
  }
  default: {
    process.stderr.write("Unknown command: " + command);
    process.exit(1);
  }
}
`;
}

function buildLauncherScript(controllerPath: string): string {
  const runtimePath = JSON.stringify(process.execPath);
  const escapedControllerPath = JSON.stringify(controllerPath);

  if (process.platform === "win32") {
    return `@echo off\r\n"${process.execPath}" ${escapedControllerPath} %*\r\n`;
  }

  return `#!/bin/sh\nexec ${runtimePath} ${escapedControllerPath} "$@"\n`;
}

async function installPortableDesktopShim(options: {
  rootDir: string;
  config: PortableDesktopShimConfig;
}): Promise<void> {
  const cacheDir = path.join(options.rootDir, "cache", "portabledesktop");
  await fs.mkdir(cacheDir, { recursive: true });

  const controllerPath = path.join(cacheDir, "portable-desktop-manager-shim.js");
  const configPath = path.join(cacheDir, "portable-desktop-manager-shim.config.json");
  await fs.writeFile(configPath, JSON.stringify(options.config));
  await fs.writeFile(controllerPath, buildControllerScript(configPath));

  const binaryName = process.platform === "win32" ? "portabledesktop.exe" : "portabledesktop";
  const binaryPath = path.join(cacheDir, binaryName);
  await fs.writeFile(binaryPath, buildLauncherScript(controllerPath));
  if (process.platform !== "win32") {
    await fs.chmod(binaryPath, 0o755);
  }
}

function createWorkspaceMetadata(
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"]
): FrontendWorkspaceMetadata {
  const metadata: FrontendWorkspaceMetadata = {
    id: "workspace-1",
    name: "workspace-1",
    projectName: "project-1",
    projectPath: "/tmp/project-1",
    runtimeConfig,
    namedWorkspacePath: "/tmp/project-1/workspace-1",
  };
  return metadata;
}

function createExperimentsService(enabled: boolean): ExperimentsService {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- prototype-backed stub only needs isExperimentEnabled in these tests.
  return Object.setPrototypeOf(
    {
      isExperimentEnabled: () => enabled,
    },
    ExperimentsService.prototype
  );
}

function createWorkspaceService(
  getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>
): WorkspaceService {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- prototype-backed stub only needs getInfo in these tests.
  return Object.setPrototypeOf(
    {
      getInfo,
      isRemoving: () => false,
    },
    WorkspaceService.prototype
  );
}

function assertSessionMap(value: unknown): asserts value is Map<string, unknown> {
  expect(value).toBeInstanceOf(Map);
}

interface PortableDesktopRecordedCommand {
  command: string;
  subcommand: string;
  args: string[];
  stateFile: string;
}

function assertPortableDesktopRecordedCommands(
  value: unknown
): asserts value is PortableDesktopRecordedCommand[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error("PortableDesktop recorded commands must be an array");
  }

  for (const entry of value) {
    expect(entry).toBeObject();
    const record = entry as Record<string, unknown>;
    expect(typeof record.command).toBe("string");
    expect(typeof record.subcommand).toBe("string");
    expect(Array.isArray(record.args)).toBe(true);
    expect(typeof record.stateFile).toBe("string");
  }
}

async function registerSharedWorkspaces(config: Config): Promise<void> {
  await config.editConfig((current) => {
    const project = current.projects.get("/tmp/project-1");
    if (!project) throw new Error("Missing test project");
    project.workspaces.push(
      { id: "owner", name: "owner-name", path: "/tmp/project-1/owner" },
      {
        id: "child",
        name: "child",
        path: "/tmp/project-1/child",
        parentWorkspaceId: "owner",
        taskDesktopOwnerWorkspaceId: "owner",
        taskStatus: "running",
      },
      {
        id: "isolated",
        name: "isolated",
        path: "/tmp/project-1/isolated",
        parentWorkspaceId: "owner",
      }
    );
    return current;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createWindowManager() {
  const windows = new Map<string, { instanceId: string }>();
  return {
    openWindow(workspaceId: string, instanceId: string) {
      const state = windows.get(workspaceId) ?? { instanceId };
      windows.set(workspaceId, state);
      return Promise.resolve(state);
    },
    getWindow: (workspaceId: string) => windows.get(workspaceId) ?? null,
    closeWindow(workspaceId: string, instanceId: string) {
      if (windows.get(workspaceId)?.instanceId === instanceId) windows.delete(workspaceId);
    },
    closeWorkspace: (workspaceId: string) => {
      windows.delete(workspaceId);
    },
    closeAll: () => windows.clear(),
  };
}

async function withWindowHarness(
  run: (harness: {
    manager: DesktopSessionManager;
    config: Config;
    windows: ReturnType<typeof createWindowManager>;
    workspaceService: WorkspaceService;
    experimentsService: ExperimentsService;
  }) => Promise<void>
) {
  await withDesktopManagerHarness(async ({ tempDir, config }) => {
    await installPortableDesktopShim({ rootDir: tempDir, config: {} });
    await config.editConfig((current) => {
      const project = current.projects.get("/tmp/project-1");
      if (!project) throw new Error("Missing test project");
      project.workspaces.push(
        ...["workspace", "one", "two"].map((id) => ({
          id,
          name: id,
          path: `/tmp/project-1/${id}`,
          runtimeConfig: { type: "local" as const },
        }))
      );
      return current;
    });
    const workspaceService = createWorkspaceService(() =>
      Promise.resolve(createWorkspaceMetadata({ type: "local" }))
    );
    const experimentsService = createExperimentsService(true);
    const manager = new DesktopSessionManager({ config, experimentsService, workspaceService });
    // WorkspaceService now supplies one guard covering both archive and removal admission.
    manager.setWorkspaceArchiveGuard((workspaceId) => workspaceService.isRemoving(workspaceId));
    const windows = createWindowManager();
    manager.setDesktopWindowManager(windows);
    try {
      await run({ manager, config, windows, workspaceService, experimentsService });
    } finally {
      await manager.closeAll();
    }
  });
}

describe("DesktopSessionManager windows", () => {
  test("server mode has no window and cannot create one", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
      });
      expect(manager.getWindow("workspace")).toBeNull();
      manager.closeWindow("workspace", "instance");
      expect(
        await manager.openWindow("workspace", "instance").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
    });
  });

  test.each(["missing", "remote", "disabled", "archiving", "removing"] as const)(
    "rejects a %s workspace before opening a window",
    async (reason) => {
      await withWindowHarness(
        async ({ manager, config, windows, workspaceService, experimentsService }) => {
          if (reason === "missing" || reason === "remote") {
            await config.editConfig((current) => {
              const project = current.projects.get("/tmp/project-1");
              const workspace = project?.workspaces.find((entry) => entry.id === "workspace");
              if (!project || !workspace) throw new Error("Missing test workspace");
              if (reason === "missing") {
                project.workspaces = project.workspaces.filter((entry) => entry !== workspace);
              } else {
                workspace.runtimeConfig = { type: "ssh", host: "host", srcBaseDir: "/tmp" };
              }
              return current;
            });
          }
          if (reason === "disabled")
            spyOn(experimentsService, "isExperimentEnabled").mockReturnValue(false);
          if (reason === "archiving") manager.setWorkspaceArchiveGuard(() => true);
          if (reason === "removing") spyOn(workspaceService, "isRemoving").mockReturnValue(true);
          expect(
            await manager.openWindow("workspace", "instance").catch((error: unknown) => error)
          ).toBeInstanceOf(Error);
          expect(windows.getWindow("workspace")).toBeNull();
          expect(manager.has("workspace")).toBe(false);
        }
      );
    }
  );

  test("persisted archive blocks stale requests but unarchiving allows a fresh viewer", async () => {
    await withWindowHarness(async ({ manager, config }) => {
      const workspace = {
        id: "workspace",
        path: "/tmp/project/workspace",
        archivedAt: "2026-01-01T00:00:00.000Z",
      };
      await config.editConfig((current) => {
        current.projects.set("/tmp/project-1", { workspaces: [workspace] });
        return current;
      });
      await manager.close("workspace");
      expect(
        await manager.openWindow("workspace", "stale").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      await config.editConfig((current) => {
        current.projects.set("/tmp/project-1", {
          workspaces: [{ ...workspace, unarchivedAt: "2026-01-02T00:00:00.000Z" }],
        });
        return current;
      });
      expect(await manager.openWindow("workspace", "fresh")).toEqual({ instanceId: "fresh" });
    });
  });

  test("returns the actual instance and guards stale closes", async () => {
    await withWindowHarness(async ({ manager }) => {
      expect(await manager.openWindow("workspace", "first")).toEqual({ instanceId: "first" });
      expect(await manager.openWindow("workspace", "second")).toEqual({ instanceId: "first" });
      expect(manager.has("workspace")).toBe(true);
      manager.closeWindow("workspace", "second");
      expect(manager.getWindow("workspace")).toEqual({ instanceId: "first" });
      manager.closeWindow("workspace", "first");
      expect(manager.getWindow("workspace")).toBeNull();
      expect(manager.has("workspace")).toBe(false);
    });
  });

  test.each(["workspace", "all", "instance", "archive", "remove"] as const)(
    "%s teardown during capability lookup cannot resurrect a window",
    async (teardown) => {
      await withWindowHarness(async ({ manager, windows, workspaceService }) => {
        const capability = await manager.getCapability("workspace");
        const lookup = deferred();
        spyOn(manager, "getCapability").mockImplementationOnce(async () => {
          await lookup.promise;
          return capability;
        });
        const pending = manager
          .openWindow("workspace", "instance")
          .catch((error: unknown) => error);
        expect(manager.has("workspace")).toBe(true);
        if (teardown === "workspace") await manager.close("workspace");
        if (teardown === "all") await manager.closeAll();
        if (teardown === "instance") manager.closeWindow("workspace", "instance");
        if (teardown === "archive") manager.setWorkspaceArchiveGuard(() => true);
        if (teardown === "remove") spyOn(workspaceService, "isRemoving").mockReturnValue(true);
        lookup.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(windows.getWindow("workspace")).toBeNull();
        expect(manager.has("workspace")).toBe(false);
      });
    }
  );

  test("a stale close does not cancel another instance's pending open", async () => {
    await withWindowHarness(async ({ manager }) => {
      const capability = await manager.getCapability("workspace");
      const lookup = deferred();
      spyOn(manager, "getCapability").mockImplementationOnce(async () => {
        await lookup.promise;
        return capability;
      });
      const pending = manager.openWindow("workspace", "new");
      manager.closeWindow("workspace", "old");
      lookup.resolve();
      expect(await pending).toEqual({ instanceId: "new" });
    });
  });

  test.each(["owner", "child"])(
    "closing %s cancels a borrower's pending viewer without blocking isolated viewers",
    async (closedId) => {
      await withWindowHarness(async ({ manager, config }) => {
        await registerSharedWorkspaces(config);
        const capability = await manager.getCapability("child");
        const lookup = deferred();
        spyOn(manager, "getCapability").mockImplementationOnce(async () => {
          await lookup.promise;
          return capability;
        });
        const opening = manager.openWindow("child", "borrowed").catch((error: unknown) => error);
        expect(manager.has("child")).toBe(true);
        expect(manager.has("owner")).toBe(true);
        await manager.close(closedId);
        lookup.resolve();
        expect(await opening).toBeInstanceOf(Error);
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.has("owner")).toBe(false);
        await manager.openWindow("child", "fresh");
        expect(manager.has("owner")).toBe(true);
        await manager.openWindow("isolated", "isolated-viewer");
        await manager.close("owner");
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.getWindow("isolated")).toEqual({ instanceId: "isolated-viewer" });
      });
    }
  );

  test.each(["owner", "child"])(
    "a guard on %s refuses a borrower popout before and after capability lookup",
    async (guardedId) => {
      await withWindowHarness(async ({ manager, config }) => {
        await registerSharedWorkspaces(config);
        manager.setWorkspaceArchiveGuard((id) => id === guardedId);
        expect(
          await manager.openWindow("child", "blocked").catch((error: unknown) => error)
        ).toBeInstanceOf(Error);
        manager.setWorkspaceArchiveGuard(() => false);
        const opening = manager.openWindow("child", "racing").catch((error: unknown) => error);
        manager.setWorkspaceArchiveGuard((id) => id === guardedId);
        expect(await opening).toBeInstanceOf(Error);
        expect(manager.getWindow("child")).toBeNull();
      });
    }
  );

  test("a changed owner during capability lookup cannot retarget a pending viewer", async () => {
    await withWindowHarness(async ({ manager, config }) => {
      await registerSharedWorkspaces(config);
      const capability = await manager.getCapability("child");
      const lookup = deferred();
      spyOn(manager, "getCapability").mockImplementationOnce(async () => {
        await lookup.promise;
        return capability;
      });
      const opening = manager.openWindow("child", "stale").catch((error: unknown) => error);
      await config.editConfig((current) => {
        const child = current.projects
          .get("/tmp/project-1")
          ?.workspaces.find((entry) => entry.id === "child");
        if (!child) throw new Error("Missing child");
        delete child.taskDesktopOwnerWorkspaceId;
        return current;
      });
      lookup.resolve();
      expect(await opening).toBeInstanceOf(Error);
      expect(manager.getWindow("child")).toBeNull();
    });
  });

  test("closing an idle workspace does not leave a tombstone that blocks reopening", async () => {
    await withWindowHarness(async ({ manager }) => {
      expect(manager.has("workspace")).toBe(false);
      const firstClose = manager.close("workspace");
      expect(manager.close("workspace")).toBe(firstClose);
      await firstClose;
      expect(await manager.openWindow("workspace", "first")).toEqual({ instanceId: "first" });
      manager.closeWindow("workspace", "first");

      const secondClose = manager.close("workspace");
      expect(secondClose).not.toBe(firstClose);
      await secondClose;
      expect(await manager.openWindow("workspace", "second")).toEqual({ instanceId: "second" });
    });
  });

  test("workspace cleanup closes its viewer and shutdown prevents subsequent opens", async () => {
    await withWindowHarness(async ({ manager }) => {
      await manager.openWindow("one", "one");
      await manager.openWindow("two", "two");
      const closing = manager.close("one");
      expect(manager.close("one")).toBe(closing);
      expect(manager.getWindow("one")).toBeNull();
      expect(manager.getWindow("two")).toEqual({ instanceId: "two" });
      expect(
        await manager.openWindow("one", "racing").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      await closing;
      await manager.closeAll();
      expect(manager.getWindow("two")).toBeNull();
      expect(
        await manager.openWindow("one", "late").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
    });
  });
});

describe("DesktopSessionManager", () => {
  test("shares startup, screenshots, actions and bootstrap while legacy children stay isolated", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") return;
      await registerSharedWorkspaces(config);
      const actionRecordPath = path.join(tempDir, "shared-actions.json");
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({ display: 20, vncPort: 5910, geometry: "1024x768" }),
          actionRecordPath,
        },
      });
      process.env.PATH = "";
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
      });
      const windows = createWindowManager();
      manager.setDesktopWindowManager(windows);
      const closeNotifications: Array<string | null> = [];
      const unsubscribeClose = manager.onWorkspaceClose((id) => closeNotifications.push(id));
      const tokens = new DesktopTokenManager();
      const start = spyOn(PortableDesktopSession.prototype, "start");
      const serverService = {
        getServerInfo: () => ({
          baseUrl: "http://127.0.0.1:1234",
          token: "test",
          bindHost: "127.0.0.1",
          port: 1234,
          networkBaseUrls: [],
        }),
      };
      try {
        const [parentSession, childSession] = await Promise.all([
          manager.ensureStarted("owner"),
          manager.ensureStarted("child"),
        ]);
        expect(childSession).toBe(parentSession);
        expect(start).toHaveBeenCalledTimes(1);
        expect(manager.has("child")).toBe(false);
        await manager.openWindow("owner", "owner-viewer");
        await manager.openWindow("child", "child-viewer");
        manager.closeWindow("child", "child-viewer");
        expect(parentSession.isAlive()).toBe(true);
        expect(closeNotifications).toEqual([]);
        await manager.openWindow("child", "child-reopened");
        expect(await manager.screenshot("child")).toEqual(await manager.screenshot("owner"));
        expect(await manager.action("child", "key_press", { key: "Return" })).toEqual({
          success: true,
        });
        expect(manager.action("owner", "key_press", { key: "Return" })).rejects.toThrow(
          "controlled by"
        );
        const recorded: unknown = JSON.parse(await fs.readFile(actionRecordPath, "utf8"));
        assertPortableDesktopRecordedCommands(recorded);
        expect(recorded.length).toBe(1);
        expect(recorded[0]?.stateFile).toContain("owner");
        await manager.close("child");
        expect(parentSession.isAlive()).toBe(true);
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.getWindow("owner")).toEqual({ instanceId: "owner-viewer" });
        expect(closeNotifications).toEqual(["child"]);
        await manager.openWindow("child", "child-after-cleanup");

        const isolated = await manager.ensureStarted("isolated");
        expect(isolated).not.toBe(parentSession);
        expect(start).toHaveBeenCalledTimes(2);
        await manager.openWindow("isolated", "isolated-viewer");
        const bootstrap = await getDesktopBootstrap(
          { desktopSessionManager: manager, desktopTokenManager: tokens, serverService },
          "child"
        );
        expect(bootstrap.capability.available).toBe(true);
        if (!bootstrap.capability.available || !bootstrap.token)
          throw new Error("Expected bootstrap");
        expect(bootstrap.capability.sharedDesktop).toEqual({
          ownerWorkspaceId: "owner",
          ownerName: "owner-name",
        });
        const ownerSessionId = parentSession.getSessionInfo().sessionId;
        if (!ownerSessionId) throw new Error("Expected owner session ID");
        expect(tokens.validate(bootstrap.token)).toEqual({
          workspaceId: "child",
          sessionId: ownerSessionId,
        });
        expect(tokens.validate(bootstrap.token)).toBeNull();
        expect(manager.getLiveSessionConnection("child")).toEqual(
          manager.getLiveSessionConnection("owner")
        );
        expect(manager.getLiveSessionConnection("child")?.ownerWorkspaceId).toBe("owner");

        await config.editConfig((current) => {
          const child = current.projects
            .get("/tmp/project-1")
            ?.workspaces.find((entry) => entry.id === "child");
          if (!child) throw new Error("Missing child");
          child.archivedAt = "2026-09-01T00:00:00Z";
          return current;
        });
        expect(manager.getLiveSessionConnection("child")).toBeNull();
        expect(manager.getLiveSessionConnection("owner")).not.toBeNull();
        expect(await manager.getCapability("child")).toEqual({
          available: false,
          reason: "startup_failed",
        });
        await manager.close("owner");
        expect(manager.getWindow("owner")).toBeNull();
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.getWindow("isolated")).toEqual({ instanceId: "isolated-viewer" });
        expect(isolated.isAlive()).toBe(true);
        expect(closeNotifications).toEqual(["child", "owner"]);
        await manager.closeAll();
        expect(manager.getWindow("isolated")).toBeNull();
        expect(closeNotifications).toEqual(["child", "owner", null]);
      } finally {
        unsubscribeClose();
        start.mockRestore();
        tokens.dispose();
        await manager.closeAll();
      }
    });
  });

  for (const archivedId of ["owner", "child"]) {
    test(`rechecks ${archivedId} after a shared startup without leaking or closing another owner's session`, async () => {
      await withDesktopManagerHarness(async ({ tempDir, config }) => {
        if (process.platform === "win32") return;
        await registerSharedWorkspaces(config);
        await installPortableDesktopShim({
          rootDir: tempDir,
          config: {
            startupInfo: createStartupInfo({ display: 21, vncPort: 5911, geometry: "1024x768" }),
          },
        });
        process.env.PATH = "";
        const manager = new DesktopSessionManager({
          config,
          experimentsService: createExperimentsService(true),
          workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        });
        const started = deferred();
        const release = deferred();
        // eslint-disable-next-line @typescript-eslint/unbound-method -- call below supplies the session under test.
        const originalStart = PortableDesktopSession.prototype.start;
        const start = spyOn(PortableDesktopSession.prototype, "start").mockImplementation(
          async function (this: PortableDesktopSession) {
            await originalStart.call(this);
            started.resolve();
            await release.promise;
          }
        );
        const startup = manager.ensureStarted("child").catch((error: unknown) => error);
        try {
          await started.promise;
          expect(manager.has("owner")).toBe(true);
          expect(manager.has("child")).toBe(false);
          await config.editConfig((current) => {
            const entry = current.projects
              .get("/tmp/project-1")
              ?.workspaces.find((entry) => entry.id === archivedId);
            if (!entry) throw new Error("Missing workspace");
            entry.archivedAt = "2026-09-01T00:00:00Z";
            return current;
          });
          release.resolve();
          expect(String(await startup)).toContain("archived");
          expect(manager.has("owner")).toBe(archivedId !== "owner");
          expect(manager.getLiveSessionConnection("child")).toBeNull();
          if (archivedId === "owner") {
            expect(
              await fs.readdir(
                path.join(tempDir, "cache", DESKTOP_DEFAULTS.CACHE_DIR_NAME, "sessions")
              )
            ).toEqual([]);
          }
        } finally {
          release.resolve();
          await startup;
          start.mockRestore();
          await manager.closeAll();
        }
      });
    });
  }

  test("rejects requester and owner archive guards before shared startup", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
      });
      for (const id of ["owner", "child"]) {
        manager.setWorkspaceArchiveGuard((candidate) => candidate === id);
        expect(manager.ensureStarted("child")).rejects.toThrow("being archived");
        expect(manager.has("owner")).toBe(false);
      }
    });
  });

  for (const event of ["error", "close"] as const) {
    test(`config watcher ${event} fails closed once and explicit disposal does not`, async () => {
      await withDesktopManagerHarness(({ config, tempDir }) => {
        const manager = new DesktopSessionManager({
          config,
          experimentsService: createExperimentsService(true),
          workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        });
        const watcher = nodeFs.watch(tempDir, { persistent: false });
        const watch = spyOn(nodeFs, "watch").mockReturnValue(watcher);
        const failures: unknown[] = [];
        const stop = manager.watchWorkspaceConfig(
          () => undefined,
          (error) => failures.push(error)
        );
        try {
          watcher.emit(event, new Error("watch lost"));
          expect(failures).toHaveLength(1);
          stop();
          expect(failures).toHaveLength(1);
        } finally {
          stop();
          watch.mockRestore();
        }

        const cleanWatch = nodeFs.watch(tempDir, { persistent: false });
        const cleanSpy = spyOn(nodeFs, "watch").mockReturnValue(cleanWatch);
        try {
          const dispose = manager.watchWorkspaceConfig(
            () => undefined,
            (error) => failures.push(error)
          );
          dispose();
          cleanWatch.emit("close");
          expect(failures).toHaveLength(1);
        } finally {
          cleanWatch.close();
          cleanSpy.mockRestore();
        }
        return Promise.resolve();
      });
    });
  }

  test("reports machine-level prereqs without consulting workspace metadata when the binary is missing", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      process.env.PATH = "";

      let workspaceInfoCalls = 0;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(false),
        workspaceService: createWorkspaceService((_workspaceId) => {
          workspaceInfoCalls += 1;
          return Promise.resolve(createWorkspaceMetadata({ type: "local" }));
        }),
      });

      expect(manager.getPrereqStatus()).toEqual({
        available: false,
        reason: "binary_not_found",
      });
      expect(workspaceInfoCalls).toBe(0);
      await manager.closeAll();
    });
  });

  test("reports machine-level prereqs as available when the binary exists", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 9,
            vncPort: 5899,
            geometry: "1024x768",
            sessionId: "manager-prereq",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(false),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(manager.getPrereqStatus()).toEqual({ available: true });
      await manager.closeAll();
    });
  });

  test("returns disabled capability when the experiment is off", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      let workspaceInfoCalls = 0;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(false),
        workspaceService: createWorkspaceService((_workspaceId) => {
          workspaceInfoCalls += 1;
          return Promise.resolve(createWorkspaceMetadata({ type: "local" }));
        }),
      });

      expect(await manager.getCapability("workspace-disabled")).toEqual({
        available: false,
        reason: "disabled",
      });
      expect(workspaceInfoCalls).toBe(0);
      await manager.closeAll();
    });
  });

  test("returns unsupported_platform capability when the platform is not supported", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      Object.defineProperty(process, "platform", {
        value: "freebsd",
        configurable: true,
        writable: false,
        enumerable: true,
      });

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(await manager.getCapability("workspace-platform")).toEqual({
        available: false,
        reason: "unsupported_platform",
      });
      await manager.closeAll();
    });
  });

  test("returns unsupported_runtime capability for SSH workspaces", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(
            createWorkspaceMetadata({ type: "ssh", host: "example.com", srcBaseDir: "~/mux" })
          )
        ),
      });

      expect(await manager.getCapability("workspace-ssh")).toEqual({
        available: false,
        reason: "unsupported_runtime",
      });
      await manager.closeAll();
    });
  });

  test("returns binary_not_found capability when the PortableDesktop binary is unavailable", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(await manager.getCapability("workspace-missing-binary")).toEqual({
        available: false,
        reason: "binary_not_found",
      });
      await manager.closeAll();
    });
  });

  test("returns available capability for supported local and worktree runtimes without starting a session", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      const startupStateFile = path.join(tempDir, "manager-capability-state.json");
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 10,
            vncPort: 5900,
            geometry: "1024x768",
            stateFile: startupStateFile,
            sessionId: "manager-capability",
          }),
        },
      });
      process.env.PATH = "";

      const workspaceInfos = new Map<string, FrontendWorkspaceMetadata>([
        ["workspace-local", createWorkspaceMetadata({ type: "local" })],
        [
          "workspace-worktree",
          createWorkspaceMetadata({ type: "worktree", srcBaseDir: "/tmp/worktrees" }),
        ],
      ]);

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService((workspaceId) =>
          Promise.resolve(workspaceInfos.get(workspaceId) ?? null)
        ),
      });

      expect(await manager.getCapability("workspace-local")).toEqual({
        available: true,
        width: 1024,
        height: 768,
        sessionId: "desktop:workspace-local",
      });
      expect(await manager.getCapability("workspace-worktree")).toEqual({
        available: true,
        width: 1024,
        height: 768,
        sessionId: "desktop:workspace-worktree",
      });

      const sessionsAfterCapabilityChecks: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsAfterCapabilityChecks);
      expect(sessionsAfterCapabilityChecks.size).toBe(0);

      let stateFileCreated = true;
      try {
        await fs.access(startupStateFile);
      } catch {
        stateFileCreated = false;
      }
      expect(stateFileCreated).toBe(false);
      await manager.closeAll();
    });
  });

  test("reuses a live session across ensureStarted calls", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 11,
            vncPort: 5901,
            geometry: "1024x768",
            sessionId: "manager-reuse",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      const firstSession = await manager.ensureStarted("workspace-reuse");
      const secondSession = await manager.ensureStarted("workspace-reuse");

      expect(secondSession).toBe(firstSession);
      manager.setDesktopWindowManager(createWindowManager());
      await manager.openWindow("workspace-reuse", "viewer");
      manager.closeWindow("workspace-reuse", "viewer");
      expect(manager.getWindow("workspace-reuse")).toBeNull();
      // Viewer handoff must not restart or terminate the underlying desktop session.
      expect(firstSession.isAlive()).toBe(true);
      expect(await manager.ensureStarted("workspace-reuse")).toBe(firstSession);
      await manager.closeAll();
    });
  });

  test("ensureStarted refuses while the workspace is being archived", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });
      // Archive admission pairing: the gate arms this guard before its activity snapshot, so a
      // startup entering afterwards must refuse instead of publishing a hidden desktop session.
      manager.setWorkspaceArchiveGuard(() => true);

      try {
        await manager.ensureStarted("workspace-archiving");
        expect.unreachable("ensureStarted must refuse while the workspace is being archived");
      } catch (error) {
        expect(String(error)).toContain("being archived");
      }
      expect(manager.has("workspace-archiving")).toBe(false);
    });
  });

  test("has() ignores sessions whose process already exited", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 14,
            vncPort: 5904,
            geometry: "1024x768",
            sessionId: "manager-dead",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      const session = await manager.ensureStarted("workspace-dead");
      expect(manager.has("workspace-dead")).toBe(true);

      // Simulate a crash/exit that bypassed manager cleanup: the session dies but its map entry
      // lingers until the next ensureStarted()/close() touches it. Archive activity gates must
      // not treat that stale entry as live work.
      await session.close();
      const sessions: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessions);
      expect(sessions.has("workspace-dead")).toBe(true);
      expect(manager.has("workspace-dead")).toBe(false);

      await manager.closeAll();
    });
  });

  test("closes individual sessions and clears all tracked sessions", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 12,
            vncPort: 5902,
            geometry: "1024x768",
            sessionId: "manager-close",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      const firstSession = await manager.ensureStarted("workspace-close-one");
      await manager.ensureStarted("workspace-close-two");

      const sessionsBeforeClose: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsBeforeClose);
      expect(sessionsBeforeClose.size).toBe(2);

      await manager.close("workspace-close-one");
      expect(firstSession.isAlive()).toBe(false);

      const sessionsAfterClose: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsAfterClose);
      expect(sessionsAfterClose.size).toBe(1);

      await manager.closeAll();
      const sessionsAfterCloseAll: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsAfterCloseAll);
      expect(sessionsAfterCloseAll.size).toBe(0);
    });
  });

  test("passes pixel coordinates through unchanged before dispatching actions", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      const actionRecordPath = path.join(tempDir, "manager-action-record.json");
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 13,
            vncPort: 5903,
            geometry: "1024x768",
            sessionId: "manager-action",
          }),
          actionRecordPath,
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(
        await manager.action("workspace-action", "drag", {
          startX: 1,
          startY: 1,
          endX: 10,
          endY: 20,
        })
      ).toEqual({ success: true });

      const actionRecords: unknown = JSON.parse(await fs.readFile(actionRecordPath, "utf8"));
      assertPortableDesktopRecordedCommands(actionRecords);
      expect(actionRecords.map(({ stateFile: _stateFile, ...record }) => record)).toEqual([
        {
          command: "mouse",
          subcommand: "move",
          args: ["1", "1"],
        },
        {
          command: "mouse",
          subcommand: "down",
          args: [],
        },
        {
          command: "mouse",
          subcommand: "move",
          args: ["10", "20"],
        },
        {
          command: "mouse",
          subcommand: "up",
          args: [],
        },
      ]);
      const [firstActionRecord, ...remainingActionRecords] = actionRecords;
      expect(firstActionRecord.stateFile).toContain("workspace-action");
      await fs.access(firstActionRecord.stateFile);
      for (const actionRecord of remainingActionRecords) {
        expect(actionRecord.stateFile).toBe(firstActionRecord.stateFile);
      }

      await manager.closeAll();
      let stateFileRemoved = false;
      try {
        await fs.access(firstActionRecord.stateFile);
      } catch {
        stateFileRemoved = true;
      }
      expect(stateFileRemoved).toBe(true);
    });
  });
});
