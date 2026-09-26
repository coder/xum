/**
 * SSH2 Transport Integration Tests
 *
 * Focused tests for the SSH2 transport (ssh2 npm library) against a real
 * Docker SSH server. These tests are isolated from the main runtime suite
 * to keep SSH2-specific coverage small and easy to diagnose.
 *
 * Tests use the same Docker fixture as runtime.test.ts but explicitly use
 * `createSSHTransport(config, true)` to exercise the SSH2 code path.
 */

import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { TestWorkspace } from "./test-fixtures/test-helpers";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { sshConnectionPool } from "@/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "@/node/runtime/SSH2ConnectionPool";

function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true";
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

let sshConfig: SSHServerConfig | undefined;

/**
 * Create an SSHRuntime using the SSH2 transport (not OpenSSH)
 */
function createSSH2Runtime(config: SSHServerConfig): SSHRuntime {
  const sshRuntimeConfig = {
    host: "testuser@localhost",
    srcBaseDir: config.workdir,
    identityFile: config.privateKeyPath,
    port: config.port,
  };
  // useSSH2 = true to exercise the ssh2 library transport
  return new SSHRuntime(sshRuntimeConfig, createSSHTransport(sshRuntimeConfig, true));
}

describeIntegration("SSH2 Transport integration tests", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH2 integration tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    console.log("Starting SSH server container for SSH2 tests...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 120000);

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Reset SSH connection pool state before each test to prevent backoff from one
  // test affecting subsequent tests.
  beforeEach(() => {
    sshConnectionPool.clearAllHealthForTests();
    ssh2ConnectionPool.clearAllHealthForTests();
  });

  describe("exec() - Command execution via SSH2", () => {
    test("returns correct exit code for failed commands", async () => {
      const runtime = createSSH2Runtime(sshConfig!);
      await using workspace = await TestWorkspace.create(runtime, "ssh");

      const result = await execBuffered(runtime, "exit 42", {
        cwd: workspace.path,
        timeout: 30,
      });

      expect(result.exitCode).toBe(42);
    });

    test("captures stderr separately", async () => {
      const runtime = createSSH2Runtime(sshConfig!);
      await using workspace = await TestWorkspace.create(runtime, "ssh");

      const result = await execBuffered(runtime, 'echo "out" && echo "err" >&2', {
        cwd: workspace.path,
        timeout: 30,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("out");
      expect(result.stderr.trim()).toBe("err");
    });
  });

  describe("File operations via SSH2", () => {
    test("writes and reads file roundtrip", async () => {
      const runtime = createSSH2Runtime(sshConfig!);
      await using workspace = await TestWorkspace.create(runtime, "ssh");

      const testContent = "Hello from SSH2 transport test!\nLine 2\n";
      const filePath = `${workspace.path}/test-file.txt`;

      await writeFileString(runtime, filePath, testContent);
      const readContent = await readFileString(runtime, filePath);

      expect(readContent).toBe(testContent);
    });

    test("handles binary-like content", async () => {
      const runtime = createSSH2Runtime(sshConfig!);
      await using workspace = await TestWorkspace.create(runtime, "ssh");

      // Content with special characters that might trip up text handling
      const testContent = "Line with special chars: \t\r\nUnicode: 日本語 émojis: 🚀\n";
      const filePath = `${workspace.path}/special-chars.txt`;

      await writeFileString(runtime, filePath, testContent);
      const readContent = await readFileString(runtime, filePath);

      expect(readContent).toBe(testContent);
    });
  });
});
