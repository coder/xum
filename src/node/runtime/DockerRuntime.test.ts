import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DockerRuntime, getContainerName, type DockerRuntimeConfig } from "./DockerRuntime";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { fakeRuntimeFactory } from "@/node/services/runtimeFactory/fakeRuntimeFactory.testHarness";
import { createMemoryHost } from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { CONTAINER_CLI_ENV } from "./containerCli";
import {
  RuntimeError,
  type ExecOptions,
  type ExecStream,
  type InitLogger,
  type WorkspaceInitParams,
} from "./Runtime";

const noopInitLogger: InitLogger = {
  logStep: () => {
    // no-op
  },
  logStdout: () => {
    // no-op
  },
  logStderr: () => {
    // no-op
  },
  logComplete: () => {
    // no-op
  },
};

interface ContainerUserFixture {
  uid: string;
  gid: string;
  home: string;
}

interface ExecCall {
  command: string;
  options: ExecOptions;
  stdinChunks: Uint8Array[];
}

function createTextStream(text = ""): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

class CredentialTestDockerRuntime extends DockerRuntime {
  readonly log: string[] = [];
  readonly execCalls: ExecCall[] = [];

  constructor(
    config: DockerRuntimeConfig,
    private readonly userFixture: ContainerUserFixture
  ) {
    super(config);
  }

  protected override checkExistingContainer(
    _containerName: string,
    _workspacePath: string,
    _branchName: string
  ): Promise<{ action: "skip" }> {
    this.log.push("checkExistingContainer");
    return Promise.resolve({ action: "skip" });
  }

  protected override detectContainerUser(
    _containerName: string,
    _abortSignal?: AbortSignal
  ): Promise<ContainerUserFixture> {
    this.log.push("detectContainerUser");
    return Promise.resolve(this.userFixture);
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const call: ExecCall = { command, options, stdinChunks: [] };
    this.log.push(`exec:${command}`);
    this.execCalls.push(call);

    return Promise.resolve({
      stdout: createTextStream(),
      stderr: createTextStream(),
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          call.stdinChunks.push(chunk.slice());
        },
      }),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    });
  }
}

function buildPostCreateSetupParams(
  overrides: Partial<WorkspaceInitParams> = {}
): WorkspaceInitParams {
  return {
    projectPath: "/tmp/project",
    branchName: "feature",
    trunkBranch: "main",
    workspacePath: "/src",
    initLogger: noopInitLogger,
    ...overrides,
  };
}

function getGitconfigWriteCall(runtime: CredentialTestDockerRuntime): ExecCall | undefined {
  return runtime.execCalls.find((call) => call.command.includes(".gitconfig"));
}

function getGhSetupCall(runtime: CredentialTestDockerRuntime): ExecCall | undefined {
  return runtime.execCalls.find((call) => call.command.includes("gh auth setup-git"));
}

describe("DockerRuntime constructor", () => {
  it("should return /src for workspace path", () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });
    expect(runtime.getWorkspacePath("/any/project", "any-branch")).toBe("/src");
  });
});

describe("DockerRuntime.postCreateSetup credentials", () => {
  const hostGitconfigContents = Buffer.from("[user]\n\tname = Mux Test\n");
  let originalHome: string | undefined;
  let originalGhToken: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalGhToken = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mux-docker-credentials-"));
    await fs.writeFile(path.join(tempHome, ".gitconfig"), hostGitconfigContents);
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("detects and caches a non-root user before writing gitconfig to its home", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "codercom/enterprise-base", containerName: "mux-test", shareCredentials: true },
      { uid: "1000", gid: "1000", home: "/home/coder" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams());

    const writeCall = getGitconfigWriteCall(runtime);
    expect(writeCall).toBeDefined();
    expect(runtime.log.indexOf("detectContainerUser")).toBeLessThan(
      runtime.log.findIndex((entry) => entry.includes(".gitconfig"))
    );
    expect(writeCall?.command).toContain("$HOME/.gitconfig");
    expect(writeCall?.command).not.toContain("/root/.gitconfig");
    expect([...Buffer.concat(writeCall?.stdinChunks ?? [])]).toEqual([...hostGitconfigContents]);
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
  });

  it("preserves root container home behavior", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test", shareCredentials: true },
      { uid: "0", gid: "0", home: "/root" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams());

    const writeCall = getGitconfigWriteCall(runtime);
    expect(writeCall?.command).toContain("$HOME/.gitconfig");
    expect([...Buffer.concat(writeCall?.stdinChunks ?? [])]).toEqual([...hostGitconfigContents]);
    expect(await runtime.resolvePath("~")).toBe("/root");
  });

  it("runs gh credential setup after user detection when a token is provided", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test", shareCredentials: true },
      { uid: "1000", gid: "1000", home: "/home/coder" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams({ env: { GH_TOKEN: "test-token" } }));

    const ghCall = getGhSetupCall(runtime);
    expect(ghCall).toBeDefined();
    expect(runtime.log.indexOf("detectContainerUser")).toBeLessThan(
      runtime.log.findIndex((entry) => entry.includes("gh auth setup-git"))
    );
    expect(ghCall?.options.env).toEqual({ GH_TOKEN: "test-token" });
  });

  it("does not run gh credential setup without a token", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test", shareCredentials: true },
      { uid: "1000", gid: "1000", home: "/home/coder" }
    );

    await runtime.postCreateSetup(buildPostCreateSetupParams());

    expect(getGhSetupCall(runtime)).toBeUndefined();
  });

  it("skips credential commands when credential sharing is disabled or absent", async () => {
    for (const shareCredentials of [false, undefined]) {
      const runtime = new CredentialTestDockerRuntime(
        {
          image: "ubuntu:22.04",
          containerName: "mux-test",
          ...(shareCredentials === undefined ? {} : { shareCredentials }),
        },
        { uid: "1000", gid: "1000", home: "/home/coder" }
      );

      await runtime.postCreateSetup(buildPostCreateSetupParams());

      expect(getGitconfigWriteCall(runtime)).toBeUndefined();
      expect(getGhSetupCall(runtime)).toBeUndefined();
    }
  });
});

describe("DockerRuntime.initWorkspace", () => {
  it("gives the container a new agent host key once the checkout is ready (#6426)", async () => {
    const runtime = new CredentialTestDockerRuntime(
      { image: "ubuntu:22.04", containerName: "mux-test-init-key" },
      { uid: "0", gid: "0", home: "/root" }
    );
    const before = runtime.getAgentHostKey();
    await runtime.initWorkspace(buildPostCreateSetupParams());
    expect(runtime.getAgentHostKey()).not.toBe(before);
  });
});

describe("DockerRuntime.forkWorkspace", () => {
  it("stops before Docker commands when the fork is already aborted", async () => {
    const runtime = new DockerRuntime({ image: "ubuntu:22.04" });
    const abortController = new AbortController();
    abortController.abort();

    const result = await runtime.forkWorkspace({
      projectPath: "/tmp/project",
      sourceWorkspaceName: "main",
      newWorkspaceName: "feature",
      initLogger: noopInitLogger,
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });
});

describe("DockerRuntime.resolvePath of ~ in a container the runtime has not made ready", () => {
  let originalCli: string | undefined;
  let cliDir: string;
  let cliBinaryPath: string;

  async function writeFakeCli(): Promise<void> {
    cliBinaryPath = path.join(cliDir, "fake-container-cli");
    await fs.writeFile(
      cliBinaryPath,
      [
        "#!/bin/sh",
        'dir=$(dirname "$0")',
        'echo "$*" >> "$dir/calls.log"',
        'if [ -f "$dir/failure" ]; then',
        '  cat "$dir/failure" >&2',
        '  exit "$(cat "$dir/failure-exit")"',
        "fi",
        'cat "$dir/home"',
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
  }

  async function failProbe(exitCode: number, stderr: string): Promise<void> {
    await fs.writeFile(path.join(cliDir, "failure"), stderr);
    await fs.writeFile(path.join(cliDir, "failure-exit"), String(exitCode));
  }

  async function probeCount(): Promise<number> {
    const log = await fs.readFile(path.join(cliDir, "calls.log"), "utf8").catch(() => "");
    return log.split("\n").filter((line) => line.includes("echo $HOME")).length;
  }

  function existingContainerRuntime(): DockerRuntime {
    return new DockerRuntime({ image: "codercom/example-base:ubuntu", containerName: "mux-test" });
  }

  beforeEach(async () => {
    originalCli = process.env[CONTAINER_CLI_ENV];
    cliDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-docker-home-"));
    await fs.writeFile(path.join(cliDir, "home"), "/home/coder\n");
    await writeFakeCli();
    process.env[CONTAINER_CLI_ENV] = cliBinaryPath;
  });

  afterEach(async () => {
    if (originalCli === undefined) {
      delete process.env[CONTAINER_CLI_ENV];
    } else {
      process.env[CONTAINER_CLI_ENV] = originalCli;
    }
    await fs.rm(cliDir, { recursive: true, force: true });
  });

  it("resolves ~ to the container user's home, probing once", async () => {
    const runtime = existingContainerRuntime();

    expect(await runtime.resolvePath("~/.xum/agents")).toBe("/home/coder/.xum/agents");
    expect(await runtime.resolvePath("~")).toBe("/home/coder");
    expect(await probeCount()).toBe(1);
  });

  it("keeps resolving a path that does not start with ~ without asking the container", async () => {
    const runtime = existingContainerRuntime();

    expect(await runtime.resolvePath("/var/mux")).toBe("/var/mux");
    expect(await runtime.resolvePath("repo")).toBe("/src/repo");
    expect(await probeCount()).toBe(0);
  });

  it("keeps /root for ~ until there is a container to ask", async () => {
    const runtime = new DockerRuntime({ image: "codercom/example-base:ubuntu" });

    expect(await runtime.resolvePath("~")).toBe("/root");
    expect(await probeCount()).toBe(0);
  });

  it("reports an unreachable container as a transport failure and probes again later", async () => {
    const runtime = existingContainerRuntime();
    await failProbe(1, "Error response from daemon: container mux-test is not running\n");

    const failure = await runtime.resolvePath("~/.xum/agents").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).type).toBe("network");

    await fs.rm(path.join(cliDir, "failure"));
    expect(await runtime.resolvePath("~/.xum/agents")).toBe("/home/coder/.xum/agents");
  });

  it("reads a built-in agent in a non-root container, whose /root it cannot enter", async () => {
    class NonRootContainerRuntime extends DockerRuntime {
      override stat(filePath: string): ReturnType<DockerRuntime["stat"]> {
        const denied = filePath.startsWith("/root/");
        return Promise.reject(
          Object.assign(
            new RuntimeError(
              `Failed to stat ${filePath}: ${denied ? "Permission denied" : "No such file"}`,
              "file_io"
            ),
            denied ? {} : { code: "ENOENT" }
          )
        );
      }
    }
    const runtime = new NonRootContainerRuntime({
      image: "codercom/example-base:ubuntu",
      containerName: "mux-test",
    });

    const agent = await readAgentDefinition(runtime, "/src", AgentIdSchema.parse("exec"), {
      runtimeFactory: fakeRuntimeFactory(createMemoryHost()),
    });

    expect(agent.scope).toBe("built-in");
  });

  it("does not guess /root when the home probe fails or prints nothing", async () => {
    const runtime = existingContainerRuntime();
    await failProbe(127, "exec: sh: not found\n");

    const failure = await runtime.resolvePath("~").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).type).toBe("exec");

    await fs.rm(path.join(cliDir, "failure"));
    await fs.writeFile(path.join(cliDir, "home"), "\n");
    const empty = await runtime.resolvePath("~").catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(RuntimeError);
    expect((empty as RuntimeError).type).toBe("exec");
  });
});

describe("getContainerName", () => {
  it("should generate container name from project and workspace", () => {
    expect(getContainerName("/home/user/myproject", "feature-branch")).toBe(
      "mux-myproject-feature-branch-a8d18a"
    );
  });

  it("should sanitize special characters", () => {
    expect(getContainerName("/home/user/my@project", "feature/branch")).toBe(
      "mux-my-project-feature-branch-b354b4"
    );
  });

  it("should handle long names", () => {
    const longName = "a".repeat(100);
    const result = getContainerName("/project", longName);
    // Docker has 64 char limit, function uses 63 to be safe
    expect(result.length).toBeLessThanOrEqual(63);
  });
});
