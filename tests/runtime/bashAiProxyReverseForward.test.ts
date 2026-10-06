/**
 * Bash AI proxy over a real SSH host: the reverse forward (both transports), the bash-only
 * health probe on the host, and a provider call from the host that is counted.
 *
 * Needs Docker (the same sshd fixture as runtime.test.ts) and TEST_INTEGRATION=1.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { BashAiProxyService } from "@/node/services/bashAiProxy/bashAiProxyService";
import { createSshForwardTarget } from "@/node/services/bashAiProxy/sshForwardTarget";

const describeIntegration =
  process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true"
    ? describe
    : describe.skip;

describeIntegration("bash AI proxy reverse forward over SSH", () => {
  let ssh: SSHServerConfig;
  let upstream: http.Server;
  let upstreamBaseUrl: string;
  const upstreamKeys: string[] = [];

  beforeAll(async () => {
    if (!(await isDockerAvailable())) throw new Error("Docker is required");
    ssh = await startSSHServer();
    // The fake provider runs on the backend host, like the real one is reached from it.
    upstream = http.createServer((req, res) => {
      upstreamKeys.push(String(req.headers["x-api-key"]));
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "claude-sonnet-5-5",
            usage: { input_tokens: 7, output_tokens: 3 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    upstream?.close();
    if (ssh) await stopSSHServer(ssh);
  }, 30_000);

  for (const useSSH2 of [false, true]) {
    test(`${useSSH2 ? "ssh2" : "OpenSSH"}: a command on the host is proxied and counted`, async () => {
      const runtimeConfig = {
        host: "testuser@localhost",
        srcBaseDir: ssh.workdir,
        identityFile: ssh.privateKeyPath,
        port: ssh.port,
      };
      const runtime = new SSHRuntime(runtimeConfig, createSSHTransport(runtimeConfig, useSSH2));
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-ai-proxy-it-"));
      const recorded: string[] = [];
      const proxy = new BashAiProxyService({
        rootDir,
        isEnabled: () => true,
        workspaceExists: () => true,
        isWorkspaceTrusted: () => Promise.resolve(true),
        forwardTargetFor: () => Promise.resolve(createSshForwardTarget(runtime)),
        loadProviderConfig: () => ({ apiKey: "real-key", baseUrl: upstreamBaseUrl }),
        recordUsage: (_workspaceId, modelString) => {
          recorded.push(modelString);
          return Promise.resolve(undefined);
        },
        onUsageRecorded: () => undefined,
      });
      try {
        const env = await proxy.envFor("ws-ssh", "ssh", []);
        expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/anthropic$/);

        // On the host, with bash only (the fixture has no curl): POST through the forward.
        const port = new URL(env.ANTHROPIC_BASE_URL).port;
        const body = '{"model":"claude-sonnet-5-5"}';
        const script =
          `exec 3<>/dev/tcp/127.0.0.1/${port} || exit 3; ` +
          `printf 'POST /anthropic/v1/messages HTTP/1.0\\r\\nx-api-key: %s\\r\\n` +
          `content-type: application/json\\r\\ncontent-length: ${body.length}\\r\\n\\r\\n%s' ` +
          `"$KEY" '${body}' >&3; cat <&3`;
        const result = await execBuffered(runtime, script, {
          cwd: "/",
          timeout: 20,
          env: { KEY: env.ANTHROPIC_API_KEY },
        });
        expect(result.stdout).toContain("HTTP/1.1 200");
        expect(result.stdout).toContain('"input_tokens":7');
        expect(upstreamKeys.at(-1)).toBe("real-key");
        expect(recorded).toEqual(["anthropic:claude-sonnet-5-5"]);
      } finally {
        await proxy.stop();
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    }, 90_000);
  }
});
