import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  AgentPluginImportedComponents,
  AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import {
  serverConsentFingerprint,
  skillConsentFingerprint,
  type ComponentConsent,
} from "./componentConsent";
import { discoverAgentPluginAt, type AgentPluginScope } from "./discovery";
import { getPluginDataPath, loadPluginMcpServers, resolvePluginInstanceId } from "./mcpConfig";

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
 * The consent records an install review stores for every skill and MCP server of the plugin at
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
  const consent: ComponentConsent = { skills: {}, mcpServers: {} };
  for (const skillsDir of plugin.skillsDirs ?? []) {
    for (const dirName of await fs.readdir(skillsDir)) {
      const directoryName = SkillNameSchema.safeParse(dirName);
      if (!directoryName.success) continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(skillsDir, dirName, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const { frontmatter } = parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content),
        directoryName: directoryName.data,
      });
      // The scan keeps the first skill of a name, in declared root order.
      consent.skills[frontmatter.name] ??= skillConsentFingerprint({
        relativeDir: path.relative(plugin.rootPath, path.join(skillsDir, dirName)),
        frontmatter,
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
  return consent;
}
