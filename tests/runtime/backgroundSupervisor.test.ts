/**
 * Background-process supervisor over real runtimes (formal/background-processes,
 * BgTerminateGroup.tla MC_group_supervisor): local, SSH and Docker. The record readers, the stop
 * request and the group probe run through runtime.exec, in the runtime's own process namespace.
 *
 * Linux targets only (the scripts read /proc/<pid>/stat). The SSH and Docker targets are the
 * Alpine fixture (busybox tools, bash), whose container PID 1 is sshd.
 */
import * as os from "os";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { createTestRuntime, TestWorkspace, type RuntimeType } from "./test-fixtures/test-helpers";
import type { BackgroundHandle, Runtime } from "@/node/runtime/Runtime";
import { spawnProcess } from "@/node/services/backgroundProcessExecutor";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { sshConnectionPool } from "@/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "@/node/runtime/SSH2ConnectionPool";

const shouldRun = process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true";
const describeIntegration = shouldRun && process.platform === "linux" ? describe : describe.skip;

let sshConfig: SSHServerConfig | undefined;

describeIntegration("background process supervisor over runtimes", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error("Docker is required for these integration tests (SSH and Docker targets).");
    }
    sshConfig = await startSSHServer();
  }, 120_000);

  afterAll(async () => {
    if (sshConfig) await stopSSHServer(sshConfig);
  }, 30_000);

  beforeEach(() => {
    sshConnectionPool.clearAllHealthForTests();
    ssh2ConnectionPool.clearAllHealthForTests();
  });

  describe.each<{ type: RuntimeType }>([{ type: "local" }, { type: "ssh" }, { type: "docker" }])(
    "$type",
    ({ type }) => {
      const baseWorkdir = () =>
        type === "ssh" ? sshConfig!.workdir : type === "docker" ? "/src" : os.tmpdir();
      const createRuntime = (): Runtime =>
        createTestRuntime(
          type,
          baseWorkdir(),
          sshConfig,
          type === "docker"
            ? { image: "mux-ssh-test", containerName: sshConfig!.containerId }
            : undefined
        );

      async function withSpawned(
        tag: string,
        script: string,
        run: (spawned: { runtime: Runtime; handle: BackgroundHandle; pid: number }) => Promise<void>
      ): Promise<void> {
        const runtime = createRuntime();
        await using workspace = await TestWorkspace.create(runtime, type);
        const result = await spawnProcess(runtime, script, {
          cwd: workspace.path,
          workspaceId: `supervisor-${type}-${tag}-${Date.now()}`,
          processId: tag,
        });
        if (!result.success) throw new Error(result.error);
        try {
          await run({ runtime, handle: result.handle, pid: result.pid });
        } finally {
          // Test-only teardown of the group this test started, if anything is left of it.
          await execBuffered(runtime, `kill -KILL -${result.pid} 2>/dev/null; true`, {
            cwd: "/tmp",
            timeout: 10,
          }).catch(() => undefined);
          await execBuffered(runtime, `rm -rf '${result.outputDir}'`, {
            cwd: "/tmp",
            timeout: 10,
          }).catch(() => undefined);
        }
      }

      async function exitCodeWithin(handle: BackgroundHandle, ms: number) {
        const deadline = Date.now() + ms;
        for (;;) {
          const code = await handle.getExitCode();
          if (code !== null || Date.now() > deadline) return code;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      test("a natural exit records the code once the group ends; a later stop confirms", async () => {
        await withSpawned("natural", "sleep 2 & exit 3", async ({ handle }) => {
          // The lingering `sleep` keeps the process running.
          expect(await handle.getExitCode()).toBeNull();
          expect(await exitCodeWithin(handle, 10_000)).toBe(3);
          expect(await handle.terminate()).toEqual({ confirmed: true, exitCode: 3 });
        });
      }, 60_000);

      test("a stop ends the group from inside and keeps the command's status", async () => {
        await withSpawned("running", "sleep 60", async ({ handle }) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(await handle.terminate()).toEqual({ confirmed: true, exitCode: 143 });
          expect(await handle.getExitCode()).toBe(143);
        });
      }, 60_000);

      test("a stop is unconfirmed when the command killed its supervisor", async () => {
        await withSpawned(
          "supervisor-killed",
          'g=$(cut -d" " -f5 /proc/$$/stat); kill -KILL "$g"; sleep 60',
          async ({ handle, runtime, pid }) => {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const stop = await handle.terminate();
            expect(stop.confirmed).toBe(false);
            // The member still runs: no signal reached it.
            const alive = await execBuffered(runtime, `kill -0 -${pid}`, {
              cwd: "/tmp",
              timeout: 10,
            });
            expect(alive.exitCode).toBe(0);
            expect(await handle.getExitCode()).toBeNull();
          }
        );
      }, 60_000);
    }
  );
});
