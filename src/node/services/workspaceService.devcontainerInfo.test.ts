import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import path from "path";
import { projectWorkspace, saveWorkspaces } from "./taskService.testHarness";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

const workspaceId = "dc-ws";
const remoteWorkspaceFolder = "/workspaces/ws";

interface FakeCli {
  /** Names `docker ps` prints; empty means no running container. */
  containerNames: string[];
  /** JSON result line `devcontainer up` prints. */
  upResult: Record<string, unknown>;
}

// getDevcontainerInfo shells out to the literal `docker` and `devcontainer` binaries.
// The fakes on PATH stand in for both, so the real DevcontainerRuntime runs end to end.
async function installFakeCli(binDir: string, dockerLog: string, fake: FakeCli): Promise<void> {
  await fsPromises.mkdir(binDir, { recursive: true });
  const names = fake.containerNames.map((name) => `echo '${name}'`).join("\n");
  await fsPromises.writeFile(
    path.join(binDir, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${dockerLog}'\n${names}\nexit 0\n`,
    { mode: 0o755 }
  );
  await fsPromises.writeFile(
    path.join(binDir, "devcontainer"),
    [
      "#!/bin/sh",
      'if [ "$1" = up ]; then',
      `  echo '${JSON.stringify(fake.upResult)}'`,
      "  exit 0",
      "fi",
      // `exec`: refuse credential copies (they write ~/.gitconfig) and accept everything else.
      'case "$*" in *.gitconfig*) echo "permission denied" >&2; exit 1 ;; esac',
      "cat >/dev/null",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
}

describe.skipIf(process.platform === "win32")("WorkspaceService.getDevcontainerInfo", () => {
  let harness: WorkspaceServiceHarness;
  let projectPath: string;
  let hostWorkspacePath: string;
  let binDir: string;
  let dockerLog: string;
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    projectPath = path.join(harness.rootDir, "repo");
    hostWorkspacePath = path.join(projectPath, "ws");
    binDir = path.join(harness.rootDir, "bin");
    dockerLog = path.join(harness.rootDir, "docker.log");
    // DevcontainerRuntime.ensureReady requires a git checkout at the host path.
    await fsPromises.mkdir(path.join(hostWorkspacePath, ".git"), { recursive: true });
    await saveWorkspaces(harness.config, projectPath, [
      projectWorkspace(projectPath, "ws", workspaceId, {
        runtimeConfig: { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
      }),
      projectWorkspace(projectPath, "local", "local-ws", { runtimeConfig: { type: "local" } }),
    ]);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await harness.cleanup();
  });

  const successUp = {
    outcome: "success",
    containerId: "c1",
    remoteUser: "root",
    remoteWorkspaceFolder,
  };

  test("returns the container name and both workspace paths for a running devcontainer", async () => {
    await installFakeCli(binDir, dockerLog, {
      containerNames: ["happy_container", "second_container"],
      upResult: successUp,
    });

    expect(await harness.service.getDevcontainerInfo(workspaceId)).toEqual({
      containerName: "happy_container",
      containerWorkspacePath: remoteWorkspaceFolder,
      hostWorkspacePath,
    });
    // Docker is asked for the container labeled with the persisted host path.
    const dockerArgs = (await fsPromises.readFile(dockerLog, "utf8")).split("\n");
    expect(dockerArgs).toContain(`label=devcontainer.local_folder=${hostWorkspacePath}`);
  });

  test("returns null for workspaces that are unknown or not devcontainers", async () => {
    await installFakeCli(binDir, dockerLog, { containerNames: ["c"], upResult: successUp });

    expect(await harness.service.getDevcontainerInfo("missing-ws")).toBeNull();
    expect(await harness.service.getDevcontainerInfo("local-ws")).toBeNull();
    // Neither case reaches Docker.
    expect(await fsPromises.stat(dockerLog).catch(() => null)).toBeNull();
  });

  test("returns null when no container is running for the workspace", async () => {
    await installFakeCli(binDir, dockerLog, { containerNames: [], upResult: successUp });

    expect(await harness.service.getDevcontainerInfo(workspaceId)).toBeNull();
  });

  test("returns null when devcontainer up fails", async () => {
    await installFakeCli(binDir, dockerLog, {
      containerNames: ["c"],
      upResult: { outcome: "error", message: "build failed" },
    });

    expect(await harness.service.getDevcontainerInfo(workspaceId)).toBeNull();
  });

  test("returns null when the runtime is not ready even though up reported a folder", async () => {
    // Credential setup runs after `up` caches the remote folder; its failure still means not ready.
    const home = path.join(harness.rootDir, "home");
    await fsPromises.mkdir(home);
    await fsPromises.writeFile(path.join(home, ".gitconfig"), "[user]\n\tname = t\n");
    process.env.HOME = home;
    await harness.config.editConfig((config) => {
      config.projects.get(projectPath)!.workspaces[0].runtimeConfig = {
        type: "devcontainer",
        configPath: ".devcontainer/devcontainer.json",
        shareCredentials: true,
      };
      return config;
    });
    await installFakeCli(binDir, dockerLog, { containerNames: ["c"], upResult: successUp });

    expect(await harness.service.getDevcontainerInfo(workspaceId)).toBeNull();
  });
});
