import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AppConfigOnDiskSchema } from "../../../src/common/config/schemas/appConfigOnDisk";
import type { Workspace } from "../../../src/common/types/project";
import { isWorkspaceArchived } from "../../../src/common/utils/archive";

export const FixtureOptionsSchema = z.object({
  workspaces: z.coerce.number().int().min(1),
  projects: z.coerce.number().int().min(1),
  archived: z.coerce.number().min(0).max(1),
  profile: z.enum(["minimal", "realistic"]),
  seed: z.coerce.number().int().default(42),
});
export type FixtureOptions = z.infer<typeof FixtureOptionsSchema>;
export const manifestName = "workspace-scale-fixture.json";

export function buildFixture(root: string, options: FixtureOptions) {
  const projects: [string, { workspaces: Workspace[] }][] = Array.from(
    { length: options.projects },
    (_, i) => [join(root, "projects", "project-" + i), { workspaces: [] }]
  );
  const ids = Array.from({ length: options.workspaces }, (_, i) =>
    createHash("sha256")
      .update(options.seed + ":" + i)
      .digest("hex")
      .slice(0, 10)
  );
  let state = options.seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const order = Array.from({ length: ids.length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const archived = new Set(order.slice(0, Math.round(ids.length * options.archived)));
  for (let i = 0; i < ids.length; i++) {
    const [projectPath, project] = projects[i % projects.length];
    const workspace: Workspace = {
      path: join(root, "src", "project-" + (i % projects.length), ids[i]),
      id: ids[i],
      name: "workspace-" + ids[i],
      title: "Investigate workspace behavior " + i,
      createdAt: "2026-01-01T00:00:00.000Z",
      runtimeConfig: { type: "local" },
      ...(archived.has(i) ? { archivedAt: "2026-02-01T00:00:00.000Z" } : {}),
    };
    if (options.profile === "realistic") {
      const [ai, task, parent, failure, snapshot] = Array.from({ length: 5 }, random);
      if (ai < 0.99) {
        workspace.aiSettingsByAgent = Object.fromEntries(
          ["plan", "exec", "explore", "review", "desktop", "compact"].map((agent) => [
            agent,
            { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "high" as const },
          ])
        );
      }
      if (task < 0.35) {
        workspace.taskExperiments = {
          programmaticToolCalling: true,
          rlm: true,
          advisorTool: true,
          dynamicWorkflows: true,
        };
        workspace.taskTrunkBranch = "main";
        workspace.taskModelString = "anthropic:claude-sonnet-4-5";
      }
      // Parents are earlier roots in the same project, so startup sees no cycles or orphans.
      if (i >= projects.length && parent < 0.4) {
        workspace.parentWorkspaceId = ids[i % projects.length];
        workspace.agentType = "exec";
        workspace.taskStatus = "reported";
      }
      if (failure < 0.04) {
        workspace.taskLaunchError = "Synthetic launch failure: checkout unavailable. "
          .repeat(90)
          .slice(0, 4096);
      }
      if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt) && snapshot < 0.35) {
        workspace.worktreeArchiveSnapshot = {
          version: 1,
          capturedAt: "2026-02-01T00:00:00.000Z",
          stateDirPath: "archive-state",
          projects: [
            {
              projectPath,
              projectName: "project-" + (i % projects.length),
              storageKey: "primary",
              branchName: "workspace-" + ids[i],
              trunkBranch: "main",
              baseSha: "a".repeat(40),
              headSha: "b".repeat(40),
              committedPatchPath: "archive-state/committed.patch",
              stagedPatchPath: "archive-state/staged.patch",
              unstagedPatchPath: "archive-state/unstaged.patch",
            },
          ],
        };
      }
    }
    project.workspaces.push(workspace);
  }
  return AppConfigOnDiskSchema.parse({ projects, mdnsAdvertisementEnabled: false });
}

export async function generateFixture(root: string, options: FixtureOptions) {
  const config = buildFixture(root, FixtureOptionsSchema.parse(options));
  // Refuse existing directories rather than risk overwriting an actual installation.
  await mkdir(root);
  await writeFile(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n");
  await writeFile(join(root, manifestName), JSON.stringify(options));
  for (const [projectPath, project] of config.projects ?? []) {
    await mkdir(projectPath, { recursive: true });
    for (const workspace of project.workspaces) {
      if (!workspace.id) throw new Error("Generated workspace has no ID");
      await mkdir(join(root, "sessions", workspace.id), { recursive: true });
      if (!isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt))
        await mkdir(workspace.path, { recursive: true });
    }
  }
  return config;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      workspaces: { type: "string", default: "1801" },
      projects: { type: "string", default: "41" },
      archived: { type: "string", default: "0.70" },
      profile: { type: "string", default: "realistic" },
      seed: { type: "string", default: "42" },
    },
  });
  if (!values.root)
    throw new Error(
      "Usage: bun scripts/perf/workspace-scale/generate-fixture.ts --root <new-directory> [--workspaces 1801 --projects 41 --archived 0.70 --profile realistic --seed 42]"
    );
  const root = resolve(values.root);
  await generateFixture(root, FixtureOptionsSchema.parse(values));
  console.log(root);
}
