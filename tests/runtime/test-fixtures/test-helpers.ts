/**
 * Test helpers for runtime integration tests
 */

import * as fs from "fs/promises";
import { realpathSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { Runtime } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import type { SSHServerConfig } from "./ssh-fixture";
import type { InitLogger } from "@/node/runtime/Runtime";

/** Shared no-op init logger for tests that call initWorkspace / forkWorkspace. */
export const noopInitLogger: InitLogger = {
  logStep: () => {},
  logStdout: () => {},
  logStderr: () => {},
  logComplete: () => {},
};

/**
 * Runtime type for test matrix
 * Note: "local" here means worktree runtime (isolated git worktrees), not project-dir runtime
 */

export interface DockerRuntimeTestConfig {
  image: string;
  containerName: string;
}
export type RuntimeType = "local" | "ssh" | "docker";

/**
 * Create runtime instance based on type
 */
export function createTestRuntime(
  type: RuntimeType,
  workdir: string,
  sshConfig?: SSHServerConfig,
  dockerConfig?: DockerRuntimeTestConfig
): Runtime {
  switch (type) {
    case "local": {
      // Resolve symlinks (e.g., /tmp -> /private/tmp on macOS) to match git worktree paths
      // Note: "local" in tests means WorktreeRuntime (isolated git worktrees)
      const resolvedWorkdir = realpathSync(workdir);
      return new WorktreeRuntime(resolvedWorkdir);
    }
    case "ssh": {
      if (!sshConfig) {
        throw new Error("SSH config required for SSH runtime");
      }
      const config = {
        host: "testuser@localhost",
        srcBaseDir: sshConfig.workdir,
        identityFile: sshConfig.privateKeyPath,
        port: sshConfig.port,
      };
      return new SSHRuntime(config, createSSHTransport(config, false));
    }
    case "docker": {
      if (!dockerConfig) {
        throw new Error("Docker config required for Docker runtime");
      }
      return new DockerRuntime({
        image: dockerConfig.image,
        containerName: dockerConfig.containerName,
      });
    }
  }
}

/**
 * Test workspace - isolated temp directory for each test
 */
export class TestWorkspace {
  public readonly path: string;
  private readonly runtime: Runtime;
  private readonly isRemote: boolean;

  private constructor(runtime: Runtime, workspacePath: string, isRemote: boolean) {
    this.runtime = runtime;
    this.path = workspacePath;
    this.isRemote = isRemote;
  }

  /**
   * Create a test workspace with isolated directory
   */
  static async create(runtime: Runtime, type: RuntimeType): Promise<TestWorkspace> {
    const isRemote = type !== "local";

    if (isRemote) {
      // For SSH/Docker, create a unique subdirectory in the runtime's filesystem.
      const testId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const workspacePath =
        type === "ssh" ? `/home/testuser/workspace/${testId}` : `/src/${testId}`;

      const cwd = type === "ssh" ? "/home/testuser" : "/";

      // Create directory on remote
      const stream = await runtime.exec(`mkdir -p ${workspacePath}`, {
        cwd,
        timeout: 30,
      });
      await stream.stdin.close();
      const exitCode = await stream.exitCode;

      if (exitCode !== 0) {
        throw new Error(`Failed to create remote workspace: ${workspacePath}`);
      }

      return new TestWorkspace(runtime, workspacePath, true);
    } else {
      // For local, use temp directory
      // Resolve symlinks (e.g., /tmp -> /private/tmp on macOS) to avoid git worktree path mismatches
      const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-test-"));
      const workspacePath = await fs.realpath(tempPath);
      return new TestWorkspace(runtime, workspacePath, false);
    }
  }

  /**
   * Cleanup workspace
   */
  async cleanup(): Promise<void> {
    if (this.isRemote) {
      // Remove remote directory
      try {
        const cwd = this.path.startsWith("/home/testuser") ? "/home/testuser" : "/";
        const stream = await this.runtime.exec(`rm -rf ${this.path}`, {
          cwd,
          timeout: 60,
        });
        await stream.stdin.close();
        await stream.exitCode;
      } catch (error) {
        console.error(`Failed to cleanup remote workspace ${this.path}:`, error);
      }
    } else {
      // Remove local directory
      try {
        await fs.rm(this.path, { recursive: true, force: true });
      } catch (error) {
        console.error(`Failed to cleanup local workspace ${this.path}:`, error);
      }
    }
  }

  /**
   * Disposable interface for using declarations
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}

/**
 * Wait for predicate to become true
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  options?: { timeout?: number; interval?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 5000;
  const interval = options?.interval ?? 100;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await predicate()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error("Timeout waiting for predicate");
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
