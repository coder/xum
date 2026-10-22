/**
 * Real Daytona Cloud test (costs money): creates a sandbox through Daytona's SSH gateway and
 * drives create, exec, file read/write, fork, archive and delete through DaytonaSSHRuntime.
 *
 * Skipped unless TEST_DAYTONA=1 and DAYTONA_API_KEY are set (DAYTONA_API_URL optional). HOME
 * points at a temp dir and the ssh2 transport is used, so the real ~/.ssh/config and Xum home
 * are never written. The sandbox is always deleted in afterAll.
 */

import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { RuntimeConfig } from "@/common/types/runtime";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DaytonaSSHRuntime } from "@/node/runtime/DaytonaSSHRuntime";
import type { InitLogger } from "@/node/runtime/Runtime";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { createSSHTransport } from "@/node/runtime/transports";
import { createDaytonaArchiveHook } from "@/node/services/daytona/daytonaLifecycleHooks";
import { DaytonaService } from "@/node/services/daytona/daytonaService";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";

const shouldRun = process.env.TEST_DAYTONA === "1" && Boolean(process.env.DAYTONA_API_KEY);
const describeDaytona = shouldRun ? describe : describe.skip;

const logger: InitLogger = {
  logStep: (line) => console.log(`[daytona] ${line}`),
  logStdout: (line) => console.log(`[daytona] ${line}`),
  logStderr: (line) => console.error(`[daytona] ${line}`),
  logComplete: () => undefined,
};

describeDaytona("Daytona runtime (real control plane)", () => {
  let tempRoot: string;
  let originalHome: string | undefined;
  let service: DaytonaService;
  let projectPath: string;
  let sandboxId: string | undefined;

  function makeRuntime(config: Extract<RuntimeConfig, { type: "ssh" }>, workspaceName: string) {
    if (!config.daytona) throw new Error("expected a daytona config");
    const sshConfig = { ...config, daytona: config.daytona };
    return new DaytonaSSHRuntime(sshConfig, createSSHTransport(sshConfig, true), service, {
      projectPath,
      workspaceName,
      workspaceId: `daytona-test-${workspaceName}`,
    });
  }

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xum-daytona-real-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
    const xumHome = path.join(tempRoot, "xum");
    await fs.mkdir(xumHome, { recursive: true });
    service = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(xumHome),
      rootDir: xumHome,
      sshConfigWriter: new DaytonaSshConfigWriter({
        xumHome,
        sshConfigPath: path.join(tempRoot, ".ssh", "config"),
      }),
    });

    projectPath = path.join(tempRoot, "project");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, "README.md"), "hello\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectPath });
    git("init", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  }, 60_000);

  afterAll(async () => {
    if (sandboxId) await service.deleteSandbox(sandboxId);
    process.env.HOME = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }, 120_000);

  test("create, exec, files, fork, archive, delete", async () => {
    const draft: RuntimeConfig = {
      type: "ssh",
      host: "pending.xum--daytona",
      srcBaseDir: "~/src",
      daytona: {},
    };
    const creator = makeRuntime(draft, "feature");
    const finalized = await creator.finalizeConfig("feature", draft);
    if (!finalized.success || finalized.data.type !== "ssh") throw new Error("finalize failed");
    sandboxId = finalized.data.daytona?.sandboxId;
    expect((await creator.validateBeforePersist("feature", finalized.data)).success).toBe(true);

    const runtime = makeRuntime(finalized.data, "feature");
    const created = await runtime.createWorkspace({
      projectPath,
      branchName: "feature",
      trunkBranch: "main",
      directoryName: "feature",
      initLogger: logger,
    });
    if (!created.success || !created.workspacePath) throw new Error("createWorkspace failed");
    const initParams = {
      projectPath,
      branchName: "feature",
      trunkBranch: "main",
      workspacePath: created.workspacePath,
      initLogger: logger,
      trusted: true,
    };
    await runtime.postCreateSetup(initParams);
    expect((await runtime.initWorkspace(initParams)).success).toBe(true);
    expect(await runtime.ensureReady()).toEqual({ ready: true });

    const echo = await execBuffered(runtime, "echo ok", {
      cwd: created.workspacePath,
      timeout: 60,
    });
    expect(echo.stdout).toContain("ok");

    const filePath = `${created.workspacePath}/note.txt`;
    await writeFileString(runtime, filePath, "from xum\n");
    expect(await readFileString(runtime, filePath)).toBe("from xum\n");

    const fork = await runtime.forkWorkspace({
      projectPath,
      sourceWorkspaceName: "feature",
      newWorkspaceName: "feature-fork",
      initLogger: logger,
      trusted: true,
    });
    expect(fork.success).toBe(true);
    const forkConfig = fork.forkedRuntimeConfig;
    if (forkConfig?.type !== "ssh") throw new Error("fork lost its ssh config");
    expect(forkConfig.daytona?.forked).toBe(true);

    // Removing the fork deletes only its checkout: the sandbox stays for its owner.
    const forkRuntime = makeRuntime(forkConfig, "feature-fork");
    const deleted = await forkRuntime.deleteWorkspace(projectPath, "feature-fork", false);
    expect(deleted.success).toBe(true);
    expect((await service.getSandboxState(sandboxId ?? "")).state).toBe("started");

    // Archiving the workspace that created the sandbox deletes it.
    const archiveHook = createDaytonaArchiveHook({ daytonaService: service });
    const archived = await archiveHook({
      workspaceId: "daytona-test-feature",
      workspaceMetadata: {
        id: "daytona-test-feature",
        name: "feature",
        projectName: "project",
        projectPath,
        runtimeConfig: finalized.data,
      },
    });
    expect(archived.success).toBe(true);
    expect((await service.getSandboxState(sandboxId ?? "")).state).toBe("missing");
  }, 900_000);
});
