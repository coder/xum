import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  AgentPluginImportedComponents,
  AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import { SkillNameSchema } from "@/common/orpc/schemas";
import {
  parseSkillMarkdown,
  skillConsentFrontmatter,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import {
  serverConsentFingerprint,
  skillConsentFingerprint,
  workflowConsentFingerprint,
  agentConsentFingerprint,
  slashCommandConsentFingerprint,
  noComponentConsent,
  type ComponentConsent,
} from "./componentConsent";
import { updateApprovedCopies, type ApprovedCopies } from "./approvedCopies";
import { discoverAgentPluginAt, type AgentPluginScope } from "./discovery";
import { getPluginDataPath, loadPluginMcpServers, resolvePluginInstanceId } from "./mcpConfig";
import { listPluginSkillScripts, listPluginWorkflowFiles } from "./workflowFiles";
import { listPluginAgentFiles } from "./agentFiles";

/** Valid managed registry row; tests override individual fields to exercise corruption. */
export function createTestPluginInstallEntry(
  name: string,
  importedComponents?: AgentPluginImportedComponents,
  componentConsent?: ComponentConsent
): AgentPluginInstallEntry {
  return {
    name,
    scope: "global",
    source: {
      type: "git",
      url: "https://example.test/plugins.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: "a".repeat(40),
    installedAt: "2026-01-01T00:00:00.000Z",
    importedComponents,
    ...(componentConsent !== undefined ? { componentConsent } : {}),
  };
}

/**
 * The consent records an install review stores for every skill, MCP server and workflow of the plugin at
 * `pluginDir` (#6498): a managed registry row without them loads none of its components. Built
 * with the production plugin discovery, SKILL.md parse and MCP loader, so a test row matches what
 * the load-time gate recomputes. `pluginDir` is the lexical path inside its container.
 */
export async function reviewedComponentConsent(args: {
  pluginDir: string;
  scope?: AgentPluginScope;
  /** Xum home of the plugin data directory; defaults to the container's parent. */
  xumHome?: string;
}): Promise<ComponentConsent> {
  const { plugin, diagnostics } = await discoverAgentPluginAt({
    pluginDir: args.pluginDir,
    scope: args.scope ?? "global",
  });
  if (plugin === null) {
    throw new Error(
      `reviewedComponentConsent: not a plugin: ${diagnostics.map((d) => d.message).join("; ")}`
    );
  }
  const consent: ComponentConsent = {
    skills: {},
    mcpServers: {},
    workflows: {},
    agents: {},
    slashCommands: {},
  };
  for (const skillsRoot of plugin.skillsDirs ?? []) {
    const dirNames = skillsRoot.single ? [skillsRoot.name] : await fs.readdir(skillsRoot.dir);
    for (const dirName of dirNames) {
      const directoryName = SkillNameSchema.safeParse(dirName);
      if (!directoryName.success) continue;
      const skillDir = skillsRoot.single ? skillsRoot.dir : path.join(skillsRoot.dir, dirName);
      let content: string;
      try {
        content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      // Mirrors the install review (installService collectSkills).
      const parsed = parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content),
        directoryName: directoryName.data,
        allowDisplayName: true,
      });
      // The scan keeps the first skill of a name, in declared root order.
      consent.skills[parsed.frontmatter.name] ??= skillConsentFingerprint({
        relativeDir: path.relative(plugin.rootPath, skillDir),
        frontmatter: skillConsentFrontmatter(parsed),
        body: parsed.body,
      });
    }
  }
  if (plugin.mcpConfigPath !== undefined) {
    const xumHome = args.xumHome ?? path.dirname(plugin.containerPath);
    const instanceId = resolvePluginInstanceId(plugin, {});
    const { servers } = await loadPluginMcpServers(plugin, { xumHome, instanceId });
    const paths = {
      rootPaths: [plugin.rootPath, path.join(plugin.containerPath, plugin.dirName)],
      dataPaths: [getPluginDataPath(xumHome, instanceId)],
    };
    for (const info of Object.values(servers)) {
      if (info.plugin === undefined) throw new Error("plugin server info must carry provenance");
      consent.mcpServers[info.plugin.serverName] = serverConsentFingerprint(info, paths);
    }
  }
  // Workflow scripts (#6629), read the way the resolver reads them.
  for (const file of await listPluginWorkflowFiles(plugin.workflowsDir)) {
    if (plugin.workflowsDir === undefined) break;
    const source = await fs.readFile(path.join(plugin.workflowsDir, file), "utf8");
    if (source.length > 0) consent.workflows[file] = workflowConsentFingerprint({ file, source });
  }
  // Skill workflow scripts (#6629), keyed by their plugin-relative path.
  for (const script of await listPluginSkillScripts(plugin)) {
    const source = await fs.readFile(script.filePath, "utf8");
    if (source.length > 0) {
      consent.workflows[script.file] = workflowConsentFingerprint({ file: script.file, source });
    }
  }
  // Agents (#6629), listed and parsed the way the install review does.
  for (const agent of await listPluginAgentFiles(plugin.agentsDir)) {
    consent.agents[agent.id] = agentConsentFingerprint(agent);
  }
  for (const command of plugin.manifest.contributes?.slashCommands ?? []) {
    consent.slashCommands[command.name] = slashCommandConsentFingerprint(command);
  }
  return consent;
}

/**
 * Save the approved copies an approval sweep saves (approvedCopies.ts) for every skill and
 * workflow script `entry` records, read from `pluginDir` now: what the user approved is what is
 * on disk at this point. Assumes skills under `skills/<name>`.
 */
export async function saveApprovedCopies(args: {
  xumHome: string;
  pluginDir: string;
  entry: AgentPluginInstallEntry;
}): Promise<void> {
  const consent = args.entry.componentConsent ?? noComponentConsent();
  const read = (relativePath: string) =>
    fs.readFile(path.join(args.pluginDir, relativePath), "utf8");
  const skills: ApprovedCopies["skills"] = {};
  for (const [name, fingerprint] of Object.entries(consent.skills)) {
    skills[name] = { fingerprint, content: await read(path.join("skills", name, "SKILL.md")) };
  }
  const workflows: ApprovedCopies["workflows"] = {};
  for (const [file, fingerprint] of Object.entries(consent.workflows)) {
    // Top-level scripts are keyed by file name, skill scripts by their plugin-relative path.
    workflows[file] = {
      fingerprint,
      source: await read(file.includes("/") ? file : path.join("workflows", file)),
    };
  }
  await updateApprovedCopies({
    source: {
      xumHome: args.xumHome,
      instancePath: path.join(args.xumHome, "plugins", args.entry.name),
      installedAt: args.entry.installedAt,
    },
    consent,
    selection: args.entry.importedComponents,
    live: { skills, workflows },
  });
}
