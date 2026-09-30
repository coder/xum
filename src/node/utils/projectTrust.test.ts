import { describe, expect, test } from "bun:test";
import type { Config } from "@/node/config";
import { isProjectTrusted, isWorkspaceProjectTrusted } from "./projectTrust";

function configWithProjects(projects: Map<string, { trusted?: boolean }>): Config {
  return { loadConfigOrDefault: () => ({ projects }) } as unknown as Config;
}

describe("isWorkspaceProjectTrusted", () => {
  test("treats scratch workspaces as trusted despite unregistered workdir projectPath", () => {
    const config = configWithProjects(new Map());
    const trusted = isWorkspaceProjectTrusted(config, {
      kind: "scratch",
      projectPath: "/home/user/.mux/scratch/ws-1",
    });
    expect(trusted).toBe(true);
    // The raw path lookup alone would report untrusted; that is the bug this
    // helper exists to fix.
    expect(isProjectTrusted(config, "/home/user/.mux/scratch/ws-1")).toBe(false);
  });

  test("falls back to config trust for regular workspaces", () => {
    const config = configWithProjects(
      new Map([
        ["/repo/trusted", { trusted: true }],
        ["/repo/untrusted", {}],
      ])
    );
    expect(isWorkspaceProjectTrusted(config, { projectPath: "/repo/trusted" })).toBe(true);
    expect(isWorkspaceProjectTrusted(config, { projectPath: "/repo/untrusted" })).toBe(false);
  });
});
