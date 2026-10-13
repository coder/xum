import { describe, expect, it } from "bun:test";

import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { TestRemoteRuntime } from "@/node/runtime/testRemoteRuntime";

import type { ResolvedAgentSkill } from "./agentSkillsService";
import { resolveSkillDirectory, substituteSkillDirectoryPlaceholders } from "./skillDirectory";

const BODY = "sh ${CLAUDE_SKILL_DIR}/scripts/x.sh";

function resolvedSkill(sourceRuntime: Runtime, skillDir: string): ResolvedAgentSkill {
  return {
    package: {
      scope: "global",
      directoryName: "demo",
      frontmatter: { name: "demo", description: "demo" },
      body: BODY,
    },
    skillDir,
    sourceRuntime,
  };
}

/** Body as the model sees it after agent_skill_read/slash materialization. */
function bodyFor(skill: ResolvedAgentSkill, workspaceRuntime: Runtime): string {
  return substituteSkillDirectoryPlaceholders(BODY, resolveSkillDirectory(skill, workspaceRuntime));
}

// The tool tests cover local and worktree workspaces with real files. These
// cases need runtimes whose bash runs off the Xum host, so only the locality
// decision is exercised here.
describe("resolveSkillDirectory for off-host workspaces", () => {
  const hostRuntime = new LocalRuntime("/host/project");
  const remoteRuntime = new TestRemoteRuntime();
  const devcontainerRuntime = new DevcontainerRuntime({
    srcBaseDir: "/host/src",
    configPath: ".devcontainer/devcontainer.json",
  });

  it("reports a path read through the remote runtime itself (SSH/Docker project skills)", () => {
    const skill = resolvedSkill(remoteRuntime, "/workspace/.xum/skills/demo");
    expect(bodyFor(skill, remoteRuntime)).toBe("sh /workspace/.xum/skills/demo/scripts/x.sh");
  });

  for (const [label, workspaceRuntime] of [
    ["SSH/Docker", remoteRuntime],
    ["devcontainer", devcontainerRuntime],
  ] as const) {
    it(`withholds a host path from a ${label} workspace (plugin, host-fallback skills)`, () => {
      const dir = resolveSkillDirectory(
        resolvedSkill(hostRuntime, "/host/.xum/plugins/p/skills/demo"),
        workspaceRuntime
      );
      expect(dir.available).toBe(false);
      if (!dir.available) expect(dir.reason).toMatch(/agent_skill_read_file/);
      expect(substituteSkillDirectoryPlaceholders(BODY, dir)).toBe(BODY);
    });
  }

  it("inserts paths literally, even with replacement-pattern characters", () => {
    const skill = resolvedSkill(hostRuntime, "/host/a$&b$1");
    expect(bodyFor(skill, hostRuntime)).toBe("sh /host/a$&b$1/scripts/x.sh");
  });
});
