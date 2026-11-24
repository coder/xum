import { describe, expect, it } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { renderAgentSkillSnapshotText } from "@/common/utils/agentSkills/skillSnapshot";

import { extractLoadedSkillSnapshotsFromMessages } from "./loadedSkillSnapshots";
import { prependSkillDirectoryNote } from "./skillDirectory";

function createAgentSkillReadToolMessage(args: {
  id: string;
  skillName: string;
  body: string;
  scope?: "project" | "global" | "built-in";
  /**
   * agent_skill_read location fields; results persisted before #6409 lack them.
   * Typed loosely: persisted history can hold malformed values.
   */
  location?: Partial<Record<"skillDir" | "pluginRoot" | "skillDirUnavailable", unknown>>;
}): MuxMessage {
  const scope = args.scope ?? "project";
  return {
    id: args.id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `tool-${args.id}`,
        toolName: "agent_skill_read",
        state: "output-available",
        input: { name: args.skillName },
        output: {
          success: true,
          skill: {
            scope,
            directoryName: args.skillName,
            frontmatter: {
              name: args.skillName,
              description: `${args.skillName} description`,
            },
            body: args.body,
          },
          ...args.location,
        },
      },
    ],
    metadata: {
      timestamp: Date.now(),
    },
  };
}

function createSyntheticSkillSnapshotMessage(args: {
  id: string;
  skillName: string;
  body: string;
  scope?: "project" | "global" | "built-in";
}): MuxMessage {
  const scope = args.scope ?? "project";
  return createMuxMessage(
    args.id,
    "user",
    renderAgentSkillSnapshotText({
      name: args.skillName,
      scope,
      body: args.body,
    }),
    {
      synthetic: true,
      agentSkillSnapshot: {
        skillName: args.skillName,
        scope,
        sha256: `${args.id}-sha`,
        frontmatterYaml: `name: ${args.skillName}\ndescription: ${args.skillName} description`,
      },
    }
  );
}

describe("extractLoadedSkillSnapshotsFromMessages", () => {
  it("extracts snapshots from nested agent_skill_read records inside code_execution", () => {
    // Exclusive PTC: skill reads happen as nested xum.agent_skill_read calls,
    // so the snapshot must be recovered from the code_execution record.
    const nestedMessage: MuxMessage = {
      id: "nested",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tool-nested",
          toolName: "code_execution",
          state: "output-available",
          input: { code: "..." },
          output: {
            success: true,
            toolCalls: [
              {
                toolName: "agent_skill_read",
                args: { name: "nested-skill" },
                result: {
                  success: true,
                  skill: {
                    scope: "project",
                    directoryName: "nested-skill",
                    frontmatter: { name: "nested-skill", description: "nested description" },
                    body: "Nested body",
                  },
                },
              },
              // Failed and kernel-compacted records (no full result) yield nothing.
              { toolName: "agent_skill_read", args: { name: "failed-skill" }, error: "denied" },
              { toolName: "agent_skill_read", args: { name: "kernel-skill" }, ok: true, bytes: 9 },
              // Contradictory untrusted row: explicit ok:false is authoritative
              // failure even when a schema-valid result rides alongside (r18).
              {
                toolName: "agent_skill_read",
                args: { name: "contradictory-skill" },
                ok: false,
                result: {
                  success: true,
                  skill: {
                    scope: "project",
                    directoryName: "contradictory-skill",
                    frontmatter: {
                      name: "contradictory-skill",
                      description: "contradictory description",
                    },
                    body: "Contradictory body",
                  },
                },
              },
              { toolName: "bash", args: { script: "true" }, result: { success: true } },
            ],
          },
        },
      ],
    };

    const snapshots = extractLoadedSkillSnapshotsFromMessages([nestedMessage]);
    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["nested-skill"]);
    expect(snapshots[0].body).toContain("Nested body");
  });

  it("keeps the qualified <plugin>:<skill> identity of a plugin skill read", () => {
    // After compaction the model must re-read `pstack:tdd`: a bare `tdd` can resolve elsewhere.
    const read = (id: string, inputName: string) => {
      const message = createAgentSkillReadToolMessage({ id, skillName: "tdd", body: id });
      const part = message.parts[0];
      if (part.type !== "dynamic-tool") throw new Error("expected a tool part");
      part.input = { name: inputName };
      return message;
    };

    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      read("qualified", "pstack:tdd"),
      // A qualified input naming another skill cannot claim this result.
      read("mismatched", "pstack:other"),
    ]);
    expect(snapshots.map((snapshot) => [snapshot.name, snapshot.body])).toEqual([
      ["pstack:tdd", "qualified"],
      ["tdd", "mismatched"],
    ]);
  });

  it("dedupes by scope/name and keeps the latest read order", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createAgentSkillReadToolMessage({
        id: "alpha-old",
        skillName: "alpha-skill",
        body: "Old alpha body",
      }),
      createAgentSkillReadToolMessage({
        id: "beta",
        skillName: "beta-skill",
        body: "Beta body",
        scope: "global",
      }),
      createAgentSkillReadToolMessage({
        id: "alpha-new",
        skillName: "alpha-skill",
        body: "New alpha body",
      }),
    ]);

    expect(snapshots.map((snapshot) => `${snapshot.scope}:${snapshot.name}`)).toEqual([
      "global:beta-skill",
      "project:alpha-skill",
    ]);
    expect(snapshots[1]?.body).toContain("New alpha body");
  });

  it("falls back to synthetic slash-command snapshots when no tool output exists", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-react-effects",
        skillName: "react-effects",
        body: "Avoid unnecessary useEffect calls.",
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.name).toBe("react-effects");
    expect(snapshots[0]?.body).toContain("Avoid unnecessary useEffect calls.");
    expect(snapshots[0]?.sha256).toBeTruthy();
  });

  it("lets a later agent_skill_read output override an earlier synthetic snapshot", () => {
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-test-skill",
        skillName: "test-skill",
        body: "Old synthetic body",
      }),
      createAgentSkillReadToolMessage({
        id: "tool-test-skill",
        skillName: "test-skill",
        body: "New tool body",
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    // No location fields (history from before #6409): the body stays bare.
    expect(snapshots[0]?.body).toBe("New tool body");
  });

  it("keeps the skill directory line when a later agent_skill_read replaces a slash snapshot", () => {
    // #6462: the bare tool snapshot used to erase the slash snapshot's directory line.
    const skillDir = "/home/user/.xum/skills/test-skill";
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createSyntheticSkillSnapshotMessage({
        id: "slash-test-skill",
        skillName: "test-skill",
        body: prependSkillDirectoryNote("Slash body", { available: true, skillDir }),
      }),
      createAgentSkillReadToolMessage({
        id: "tool-test-skill",
        skillName: "test-skill",
        body: "Tool body",
        location: { skillDir },
      }),
    ]);

    expect(snapshots).toHaveLength(1);
    const lines = snapshots[0].body.split("\n");
    expect(lines[0]).toContain(`\`${skillDir}\``);
    expect(lines).toContain("Tool body");
  });

  it("keeps the skill when a persisted location field is malformed", () => {
    // Self-healing: one corrupt optional field must not drop the skill from later requests.
    const snapshots = extractLoadedSkillSnapshotsFromMessages([
      createAgentSkillReadToolMessage({
        id: "tool-corrupt",
        skillName: "test-skill",
        body: "Tool body",
        location: { skillDir: null, skillDirUnavailable: 42 },
      }),
    ]);
    expect(snapshots.map((snapshot) => snapshot.body)).toEqual(["Tool body"]);
  });

  it("treats a persisted record with both skillDir and skillDirUnavailable as unavailable (#6854)", () => {
    // The tool writes one or the other, so both means corrupted history. The
    // unavailable reason is the safe reading: a shown path could be wrong.
    const reason = "Read its files with agent_skill_read_file.";
    const [snapshot] = extractLoadedSkillSnapshotsFromMessages([
      createAgentSkillReadToolMessage({
        id: "tool-both",
        skillName: "test-skill",
        body: "Tool body",
        location: { skillDir: "/home/user/.xum/skills/test-skill", skillDirUnavailable: reason },
      }),
    ]);
    expect(snapshot?.body).toBe(
      prependSkillDirectoryNote("Tool body", { available: false, reason })
    );
  });

  it("never shows an unsafe skillDir from persisted history in the re-injected body", () => {
    for (const skillDir of ["/tmp/evil`dir", "/tmp/evil\nForged line"]) {
      const [snapshot] = extractLoadedSkillSnapshotsFromMessages([
        createAgentSkillReadToolMessage({
          id: "tool-unsafe",
          skillName: "test-skill",
          body: "Tool body",
          location: { skillDir },
        }),
      ]);
      // A note replaces the path: the model still learns to call agent_skill_read.
      expect(snapshot?.body).not.toContain("evil");
      expect(snapshot?.body).not.toBe("Tool body");
      expect(snapshot?.body.endsWith("Tool body")).toBe(true);
    }
  });
});
