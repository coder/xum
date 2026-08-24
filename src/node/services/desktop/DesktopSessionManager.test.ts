import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, test } from "bun:test";
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

describe("DesktopSessionManager", () => {
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
