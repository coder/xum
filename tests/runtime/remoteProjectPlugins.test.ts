/**
 * #6426: the remote plugin listing over a real SSH connection to the Alpine fixture, whose tar,
 * find and base64 are BusyBox. Also prints the cold listing time of three checkouts.
 */
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { createTestRuntime } from "./test-fixtures/test-helpers";
import type { Runtime } from "@/node/runtime/Runtime";
import type { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { createRemoteProjectPluginSnapshot } from "@/node/services/agentPlugins/remoteProjectPlugins";

const describeIntegration =
  process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true"
    ? describe
    : describe.skip;

let sshConfig: SSHServerConfig | undefined;
let runtime: Runtime;

async function run(command: string): Promise<void> {
  const result = await execBuffered(runtime, command, { cwd: "/home/testuser", timeout: 120 });
  expect(result.exitCode).toBe(0);
}

/** Writes plugin `kit` with one skill under `<checkout>/.xum/plugins`. */
function writeKit(checkout: string): Promise<void> {
  const kit = `${checkout}/.xum/plugins/kit`;
  return run(
    [
      `mkdir -p ${kit}/skills/review`,
      `printf '%s' '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"kit"}' > ${kit}/plugin.json`,
      `printf -- '---\\nname: review\\ndescription: d\\n---\\n' > ${kit}/skills/review/SKILL.md`,
    ].join(" && ")
  );
}

async function timedSnapshot(checkoutRoot: string) {
  const start = performance.now();
  const snapshot = await createRemoteProjectPluginSnapshot({
    runtime,
    checkoutRoot,
    containers: [`${checkoutRoot}/.xum/plugins`],
  });
  return { snapshot, ms: Math.round(performance.now() - start) };
}

describeIntegration("remote project plugins over SSH (BusyBox)", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) throw new Error("Docker is required");
    sshConfig = await startSSHServer();
    runtime = createTestRuntime("ssh", sshConfig.workdir, sshConfig);
  }, 120000);

  afterAll(async () => {
    if (sshConfig) await stopSSHServer(sshConfig);
  }, 30000);

  test("`~`, `~/x` and an absolute root resolve like SSHRuntime.resolvePath", async () => {
    await writeKit("/home/testuser/rp6426");
    await writeKit("/home/testuser");
    for (const root of ["~", "~/rp6426", "/home/testuser/rp6426"]) {
      const { snapshot } = await timedSnapshot(root);
      expect(snapshot?.root).toBe(await runtime.resolvePath(root));
      expect(snapshot?.plugins.map((plugin) => plugin.rootPath)).toEqual([
        `${await runtime.resolvePath(root)}/.xum/plugins/kit`,
      ]);
    }
  }, 60000);

  test("removing a checkout on the host gives it a new agent host key", async () => {
    const before = (runtime as SSHRuntime).getAgentHostKey();
    const result = await runtime.deleteWorkspace("/projects/p6426", "gone", true);
    expect(result.success).toBe(true);
    expect((runtime as SSHRuntime).getAgentHostKey()).not.toBe(before);
    // Another spelling of the same host (here another identity file) sees the removal too.
    if (!sshConfig) throw new Error("SSH fixture not started");
    const other = createTestRuntime("ssh", sshConfig.workdir, {
      ...sshConfig,
      privateKeyPath: `${sshConfig.privateKeyPath}-other`,
    }) as SSHRuntime;
    const otherBefore = other.getAgentHostKey();
    expect((await runtime.deleteWorkspace("/projects/p6426", "gone", true)).success).toBe(true);
    expect(other.getAgentHostKey()).not.toBe(otherBefore);
  }, 60000);

  test("cold listing times: small, a 100k-entry subtree, near the output cap", async () => {
    await writeKit("/home/testuser/small");
    await writeKit("/home/testuser/huge");
    await run(
      "mkdir -p huge/.xum/plugins/kit/skills/review/many && cd huge/.xum/plugins/kit/skills/review/many && seq 1 100000 | xargs touch"
    );
    await writeKit("/home/testuser/near-cap");
    await run(
      "cd near-cap/.xum/plugins/kit/skills/review && for i in 1 2 3 4 5 6 7 8 9 10 11; do head -c 1000000 /dev/urandom > blob$i; done"
    );
    const small = await timedSnapshot("/home/testuser/small");
    const huge = await timedSnapshot("/home/testuser/huge");
    const nearCap = await timedSnapshot("/home/testuser/near-cap");
    console.log(`cold listing ms: small=${small.ms} huge=${huge.ms} nearCap=${nearCap.ms}`);
    expect(small.snapshot?.plugins).toHaveLength(1);
    // The entry count stops the walk early, so the huge subtree loads nothing.
    expect(huge.snapshot).toBeNull();
    expect(nearCap.snapshot?.bytes).toBeGreaterThan(11_000_000);
    for (const { ms } of [small, huge, nearCap]) expect(ms).toBeLessThan(10_000);
  }, 120000);
});
