import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import {
  agentSandboxSettingsFor,
  setAgentSandboxTargets,
} from "@/node/runtime/sandbox/agentSandboxTargets";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import { AgentSandboxService } from "./agentSandboxService";

const PARENT = "/projects/parent";
const CHILD = "/projects/parent/packages/child";
const OTHER = "/projects/other";

describe("AgentSandboxService", () => {
  let rootDir: string;
  let config: Config;
  let service: AgentSandboxService | undefined;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-sandbox-service-"));
    config = new Config(rootDir);
    await config.editConfig((current) => {
      current.projects.set(PARENT, { workspaces: [] });
      current.projects.set(CHILD, { workspaces: [], parentProjectPath: PARENT });
      current.projects.set(OTHER, { workspaces: [] });
      return current;
    });
  });

  afterEach(async () => {
    await service?.dispose();
    service = undefined;
    setAgentSandboxTargets(null);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("gives each project its override, a sub-project its parent's, and the rest the global setting", async () => {
    await config.updateAgentSandbox({ enabled: true, allowedHosts: ["global.example"] });
    await config.updateProjectAgentSandbox(PARENT, { allowedHosts: ["parent.example"] });
    await config.updateProjectAgentSandbox(OTHER, { enabled: false });
    service = new AgentSandboxService(config);

    await service.start();

    expect(agentSandboxSettingsFor(PARENT)?.allowedHosts).toEqual(["parent.example"]);
    expect(agentSandboxSettingsFor(CHILD)?.allowedHosts).toEqual(["parent.example"]);
    expect(agentSandboxSettingsFor(OTHER)).toBeNull();
    // A project Xum does not know, and a command with no project, get the global setting.
    expect(agentSandboxSettingsFor("/projects/unknown")?.allowedHosts).toEqual(["global.example"]);
    expect(agentSandboxSettingsFor(undefined)?.allowedHosts).toEqual(["global.example"]);
  });

  it("follows a config change made outside the service", async () => {
    service = new AgentSandboxService(config);
    await service.start();
    expect(agentSandboxSettingsFor(OTHER)).toBeNull();

    await config.editConfig((current) => ({ ...current, agentSandbox: { enabled: true } }));

    await waitForCondition(() => agentSandboxSettingsFor(OTHER) !== null);
  });

  it("keeps the sandbox on when a hand edit breaks another field of config.json", async () => {
    await fs.writeFile(
      path.join(rootDir, "config.json"),
      JSON.stringify({
        projects: [[OTHER, { workspaces: [], agentSandbox: { enabled: true, network: 42 } }]],
        agentSandbox: { network: "loopback", extraReadPaths: "~/.npmrc" },
      })
    );
    service = new AgentSandboxService(new Config(rootDir));

    await service.start();

    // The global setting is off, so only the project's salvaged `enabled` turns it on, and the
    // global network survives its broken sibling field.
    expect(agentSandboxSettingsFor(OTHER)?.network).toBe("loopback");
    expect(agentSandboxSettingsFor(undefined)).toBeNull();
  });
});
