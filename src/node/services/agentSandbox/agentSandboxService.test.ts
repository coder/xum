import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import {
  agentSandboxPolicyAllows,
  agentSandboxSettingsFor,
  buildStrictestAgentSandboxPolicy,
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
    // Its commands look the setting up by the parent's path, so its own would change nothing.
    await config.updateProjectAgentSandbox(CHILD, { enabled: false });
    service = new AgentSandboxService(config);

    await service.start();

    expect(agentSandboxSettingsFor(PARENT)?.[0].allowedHosts).toEqual(["parent.example"]);
    expect(agentSandboxSettingsFor(CHILD)?.[0].allowedHosts).toEqual(["parent.example"]);
    expect(agentSandboxSettingsFor(OTHER)).toBeNull();
    // A project Xum does not know, and a command with no project, get the global setting.
    expect(agentSandboxSettingsFor("/projects/unknown")?.[0].allowedHosts).toEqual([
      "global.example",
    ]);
    expect(agentSandboxSettingsFor(undefined)?.[0].allowedHosts).toEqual(["global.example"]);
  });

  it("saves the settings and returns them with only the projects that override the global one", async () => {
    service = new AgentSandboxService(config);
    await service.start();
    expect(service.get().global).toEqual({});

    await service.set({ enabled: true });
    const state = await service.setProject(OTHER, { enabled: false });

    expect(state.global).toEqual({ enabled: true });
    expect(state.projects).toEqual({ [OTHER]: { enabled: false } });
    expect(agentSandboxSettingsFor(OTHER)).toBeNull();
    expect(agentSandboxSettingsFor(PARENT)).not.toBeNull();
  });

  it("saves only the fields a save names, over the latest saved setting", async () => {
    service = new AgentSandboxService(config);
    await service.start();
    // Another window, or a hand edit, turned the sandbox on after this window loaded.
    await config.editConfig((current) => ({ ...current, agentSandbox: { enabled: true } }));
    await config.updateProjectAgentSandbox(OTHER, { extraReadPaths: ["~/.npmrc"] });

    await service.set({ network: "open" });
    await service.setProject(OTHER, { enabled: false });
    expect(service.get().global).toEqual({ enabled: true, network: "open" });
    expect(service.get().projects[OTHER]).toEqual({ extraReadPaths: ["~/.npmrc"], enabled: false });

    // null removes a field, so it takes its default or follows the global setting.
    await service.set({ network: null });
    const state = await service.setProject(OTHER, { enabled: null, extraReadPaths: null });
    expect(state.global).toEqual({ enabled: true });
    expect(state.projects).toEqual({});
  });

  it("follows a config change made outside the service", async () => {
    service = new AgentSandboxService(config);
    await service.start();
    expect(agentSandboxSettingsFor(OTHER)).toBeNull();

    await config.editConfig((current) => ({ ...current, agentSandbox: { enabled: true } }));

    await waitForCondition(() => agentSandboxSettingsFor(OTHER) !== null);
  });

  // `xum run` and `xum workflow` copy the keys into a temp folder, where commands can write.
  it("hides the private config copy of a CLI run from commands, but not its sessions", async () => {
    const savedRoot = process.env.XUM_ROOT;
    // Outside the temp write roots, where the policy fails closed on Xum's home folder.
    process.env.XUM_ROOT = path.join(path.parse(os.tmpdir()).root, `xum-sandbox-${process.pid}`);
    const runRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xum-run-")));
    try {
      await fs.writeFile(path.join(runRoot, "secrets.json"), "{}");
      await config.updateAgentSandbox({ enabled: true });
      service = new AgentSandboxService(config, { privateConfigRoot: runRoot });
      await service.start();
      const policy = buildStrictestAgentSandboxPolicy(agentSandboxSettingsFor(undefined)!, {
        cwd: rootDir,
      });
      const allows = (parts: string[], access: "read" | "write") =>
        agentSandboxPolicyAllows(policy, path.join(runRoot, ...parts), access);

      for (const name of ["secrets.json", "providers.jsonc", "config.json"]) {
        // writeFileAtomic() writes a sibling temp file and renames it over the file.
        for (const file of [name, `${name}.0123456789ab`]) {
          expect(allows([file], "read")).toBe(false);
          expect(allows([file], "write")).toBe(false);
        }
      }
      expect(allows(["sessions", "ws", "scratch", "notes"], "write")).toBe(true);
    } finally {
      if (savedRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = savedRoot;
      await fs.rm(runRoot, { recursive: true, force: true });
    }
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
    expect(agentSandboxSettingsFor(OTHER)?.[0].network).toBe("loopback");
    expect(agentSandboxSettingsFor(undefined)).toBeNull();
  });
});
