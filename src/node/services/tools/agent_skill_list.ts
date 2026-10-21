import * as fsPromises from "fs/promises";
import os from "node:os";
import * as path from "path";
import { tool } from "ai";

import {
  LEGACY_MUX_SKILLS_CLI_GLOBAL_DIR,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";
import {
  AgentSkillDescriptorSchema,
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillUserInvocable,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas";
import { resolveSkillPaths } from "@/common/utils/skills/skillPaths";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillListToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { PLUGIN_REGISTRY_FILE_NAME } from "@/node/services/agentPlugins/registry";
import { discoverAgentPlugins } from "@/node/services/agentPlugins/discovery";
import {
  pluginSkillFileName,
  pluginSkillMarkdown,
} from "@/node/services/agentPlugins/claudeCommands";
import type { PluginSkillConsentGate } from "@/node/services/agentPlugins/componentConsent";
import {
  consentedPluginSkill,
  pluginSkillConsentGate,
} from "@/node/services/agentPlugins/approvedCopies";
import {
  discoverAgentSkills,
  requireReachableSkills,
  getDefaultAgentSkillsRoots,
  getProjectSkillRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { ensurePathContained, hasErrorCode, isSameHostDirectory } from "./skillFileUtils";

interface AgentSkillListToolArgs {
  includeUnadvertised?: boolean | null;
}

async function listSkillDirectories(skillsRoot: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(skillsRoot, { withFileTypes: true });
    // Include symlinked entries: skill package managers install skills by
    // symlinking directories into skills roots. readSkillDescriptor enforces
    // realpath containment per skill, so escaping symlinks stay rejected.
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    log.warn(
      `Skipping skills root '${skillsRoot}' because directory entries could not be read: ${getErrorMessage(error)}`
    );
    return [];
  }
}

interface ListedSkillsRoot {
  skillsRoot: string;
  containmentRoot: string;
  scope: "global" | "project";
  importedSkills?: readonly string[];
  skillConsent?: PluginSkillConsentGate;
  /** Plugin roots only: the root is this one skill (PluginSkillsRoot `single`). */
  singleSkillName?: string;
  /** Plugin roots only: that skill is a Claude command, `<root>/<name>.md` (claudeCommands.ts). */
  commandSkill?: true | undefined;
}

/**
 * Host global skills roots in precedence order: ~/.xum > ~/.agents > ~/.mux > ~/.claude, the same
 * order as getDefaultAgentSkillsRoots. All but the Xum home's are read-only.
 */
async function getHostGlobalSkillsRoots(
  xumHome: string,
  userHome: string,
  includeClaudeSkills: boolean
): Promise<ListedSkillsRoot[]> {
  const xumSkillsRoot = path.join(xumHome, "skills");
  // The skills CLI writes ~/.mux/skills for `--agent mux`; skip it when it is the Xum home's.
  const legacyMuxSkillsRoot = path.join(userHome, LEGACY_MUX_SKILLS_CLI_GLOBAL_DIR);
  const userHomeRoots = [
    path.join(userHome, ".agents", "skills"),
    ...((await isSameHostDirectory(xumSkillsRoot, legacyMuxSkillsRoot))
      ? []
      : [legacyMuxSkillsRoot]),
    // claude-skills-compat: lowest-precedence global root.
    ...(includeClaudeSkills ? [path.join(userHome, ".claude", "skills")] : []),
  ];
  return [
    { skillsRoot: xumSkillsRoot, containmentRoot: xumHome, scope: "global" },
    // Contained at the user home, like ~/.agents/skills.
    ...userHomeRoots.map((skillsRoot) => ({
      skillsRoot,
      containmentRoot: userHome,
      scope: "global" as const,
    })),
  ];
}

/** The skill folders of a skills root: the root itself for a single-skill plugin root. */
async function listSkillFolders(
  skillsRoot: string,
  singleSkillName: string | undefined
): Promise<Array<{ name: string; dir: string }>> {
  if (singleSkillName != null) return [{ name: singleSkillName, dir: skillsRoot }];
  return (await listSkillDirectories(skillsRoot)).map((name) => ({
    name,
    dir: path.join(skillsRoot, name),
  }));
}

/**
 * Read `skillDir`'s SKILL.md (a Claude command's `<name>.md`) when it is a contained regular file
 * of allowed size; else log and null.
 */
async function readContainedSkillFile(
  skillDir: string,
  directoryName: string,
  scope: "global" | "project",
  containmentRoot: string,
  fileName: string
): Promise<{ content: string; byteSize: number } | null> {
  const skillFilePath = path.join(skillDir, fileName);

  // SECURITY: validate that BOTH the skill directory and SKILL.md canonical
  // paths stay within the containment root before any read. Checking only the
  // file would let a skill-dir symlink resolve outside containment while its
  // SKILL.md symlinks back inside, advertising a skill whose sibling files
  // agent_skill_read_file would then read from the external location.
  let containedPath: string;
  try {
    await ensurePathContained(containmentRoot, skillDir);
    containedPath = await ensurePathContained(containmentRoot, skillFilePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      log.warn(
        `Skipping ${scope} skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
      );
      return null;
    }
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md escapes containment root`
    );
    return null;
  }

  let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    stat = await fsPromises.stat(containedPath);
  } catch {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is missing: ${skillFilePath}`
    );
    return null;
  }

  if (!stat.isFile()) {
    log.warn(`Skipping ${scope} skill '${directoryName}' because SKILL.md is not a regular file`);
    return null;
  }

  if (stat.size > MAX_FILE_SIZE) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is too large (${stat.size} bytes)`
    );
    return null;
  }

  try {
    return { content: await fsPromises.readFile(containedPath, "utf-8"), byteSize: stat.size };
  } catch (error) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md could not be read: ${getErrorMessage(error)}`
    );
    return null;
  }
}

async function readSkillDescriptor(
  skillDir: string,
  directoryNameRaw: string,
  scope: "global" | "project",
  containmentRoot: string,
  skillConsent?: PluginSkillConsentGate,
  commandSkill?: true
): Promise<AgentSkillDescriptor | null> {
  const parsedDirectoryName = SkillNameSchema.safeParse(directoryNameRaw);
  if (!parsedDirectoryName.success) {
    log.warn(`Skipping invalid ${scope} skill directory name '${directoryNameRaw}' at ${skillDir}`);
    return null;
  }

  const directoryName = parsedDirectoryName.data;
  const file = await readContainedSkillFile(
    skillDir,
    directoryName,
    scope,
    containmentRoot,
    pluginSkillFileName(directoryName, commandSkill)
  );
  if (file === null) return null;

  try {
    // A changed managed skill lists its approved copy while the new version awaits review.
    const parsed = await consentedPluginSkill(
      skillConsent,
      skillDir,
      parseSkillMarkdown({
        content: pluginSkillMarkdown(directoryName, file.content, commandSkill),
        byteSize: file.byteSize,
        directoryName,
        // Agree with discovery; the display name stays out of this model-facing output.
        allowDisplayName: true,
      })
    );
    if (parsed === null) {
      log.warn(`Skipping ${scope} plugin skill '${directoryName}': not reviewed on this install`);
      return null;
    }

    const descriptorResult = AgentSkillDescriptorSchema.safeParse({
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      scope,
      advertise: resolveSkillAdvertise(parsed.frontmatter),
      userInvocable: resolveSkillUserInvocable(parsed.frontmatter),
      argumentHint: parsed.frontmatter["argument-hint"],
      whenToUse: resolveSkillWhenToUse(parsed.frontmatter),
      paths: resolveSkillPaths(parsed.frontmatter),
    });

    if (!descriptorResult.success) {
      log.warn(
        `Skipping ${scope} skill '${directoryName}' because descriptor validation failed: ${descriptorResult.error.message}`
      );
      return null;
    }

    return descriptorResult.data;
  } catch (error) {
    log.warn(
      `Skipping ${scope} skill '${directoryName}' because SKILL.md is invalid: ${getErrorMessage(error)}`
    );
    return null;
  }
}

export const createAgentSkillListTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_list.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_list.schema,
    execute: async ({
      includeUnadvertised,
    }: AgentSkillListToolArgs): Promise<AgentSkillListToolResult> => {
      if (!config.cwd || config.cwd.trim().length === 0) {
        return {
          success: false,
          error: "Tool misconfigured: cwd is required.",
        };
      }

      // claude-skills-compat experiment: also list read-only .claude/skills roots.
      const includeClaudeSkills = config.experiments?.claudeSkillsCompat === true;

      try {
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          xumScope: config.xumScope ?? null,
          includeClaudeSkills,
        });

        if (skillCtx.kind === "project-runtime") {
          // Runtime discovery mirrors the shared default roots contract so project-runtime
          // listings include .xum/skills and .agents/skills plus ~/.xum/skills and ~/.agents/skills.
          const roots =
            skillCtx.roots ??
            getDefaultAgentSkillsRoots(skillCtx.runtime, skillCtx.workspacePath, {
              includeClaudeSkills,
            });

          const discovered = requireReachableSkills(
            await discoverAgentSkills(skillCtx.runtime, skillCtx.workspacePath, {
              roots,
              containment: skillCtx.containment,
              dedupeByName: false,
            })
          );
          const seenByScope = new Set<string>();
          const skills = discovered
            .filter((skill) => skill.scope !== "built-in")
            .filter((skill) => {
              const scopeKey = `${skill.scope}:${skill.name}`;
              if (seenByScope.has(scopeKey)) {
                return false;
              }
              seenByScope.add(scopeKey);
              return true;
            })
            .filter((skill) => includeUnadvertised === true || skill.advertise !== false)
            // The display name is user-facing only: plugin model-visible fields are
            // consent-fingerprinted (installService describeSkillAdvertisement).
            .map(({ displayName: _displayName, ...skill }) => skill)
            .sort((a, b) => a.name.localeCompare(b.name));

          return {
            success: true,
            skills,
          };
        }

        const { xumScope } = config;
        if (!xumScope) {
          throw new Error("agent_skill_list requires xumScope");
        }

        const userHome = os.homedir();

        // Always list global skills; also list project skills when in a project workspace.
        const roots: ListedSkillsRoot[] = await getHostGlobalSkillsRoots(
          xumScope.xumHome,
          userHome,
          includeClaudeSkills
        );
        if (xumScope.type === "project") {
          if (skillCtx.roots == null) {
            throw new Error("Project-local skill context requires explicit roots");
          }
          const containmentRoot = xumScope.checkoutRoot ?? xumScope.projectRoot;
          roots.unshift(
            ...getProjectSkillRoots(skillCtx.roots).map((skillsRoot) => ({
              // Project skills are nearest-directory first, before global ones.
              skillsRoot,
              containmentRoot,
              scope: "project" as const,
            }))
          );
        }

        // Expand Agent Plugins containers into per-plugin skills/ roots.
        // Containers anchor at the CHECKOUT root (matching buildProjectLocalRoots):
        // for subProjectPath workspaces `projectRoot` is the execution
        // subdirectory, but plugins live at the checkout level.
        const pluginAnchor =
          xumScope.type === "project" ? (xumScope.checkoutRoot ?? xumScope.projectRoot) : null;
        const pluginContainers = [
          ...(pluginAnchor != null
            ? [
                ...listProjectMetadataRelativePaths("plugins").map((relativePath) => ({
                  path: path.join(pluginAnchor, relativePath),
                  scope: "project" as const,
                })),
                {
                  path: path.join(pluginAnchor, ".agents", "plugins"),
                  scope: "project" as const,
                },
              ]
            : []),
          {
            path: path.join(xumScope.xumHome, "plugins"),
            scope: "global" as const,
            registryPath: path.join(xumScope.xumHome, PLUGIN_REGISTRY_FILE_NAME),
          },
          { path: path.join(userHome, ".agents", "plugins"), scope: "global" as const },
        ];
        const { plugins } = await discoverAgentPlugins(pluginContainers);
        for (const plugin of plugins) {
          if (plugin.skillsDirs == null) {
            continue;
          }
          // Project plugin roots keep the repo-symlink posture of other project
          // roots: the plugin root itself must stay inside the checkout root.
          if (plugin.scope === "project" && pluginAnchor != null) {
            try {
              await ensurePathContained(pluginAnchor, plugin.rootPath);
            } catch {
              log.warn(
                `Skipping project plugin '${plugin.name}': plugin root resolves outside the project root`
              );
              continue;
            }
          }
          // Per-skill containment anchors at the plugin root (§4.1).
          const importedSkills = plugin.importedComponents?.skills;
          // One gate per plugin: its approved copies are read at most once per listing.
          const skillConsent = pluginSkillConsentGate(plugin);
          roots.push(
            ...plugin.skillsDirs.map((skillsRoot) => ({
              skillsRoot: skillsRoot.dir,
              containmentRoot: plugin.rootPath,
              scope: plugin.scope,
              importedSkills,
              skillConsent,
              singleSkillName: skillsRoot.name,
              commandSkill: skillsRoot.command,
            }))
          );
        }

        const skills: AgentSkillDescriptor[] = [];
        const seenByScope = new Set<string>();
        for (const {
          skillsRoot,
          containmentRoot,
          scope,
          importedSkills,
          skillConsent,
          singleSkillName,
          commandSkill,
        } of roots) {
          let skillsRootReal: string;
          try {
            skillsRootReal = await fsPromises.realpath(skillsRoot);
          } catch (error) {
            log.warn(
              `Skipping ${scope} skills root '${skillsRoot}' because path could not be resolved: ${getErrorMessage(error)}`
            );
            continue;
          }

          // Skip roots that resolve outside their containment boundary
          // (e.g., project .mux is a symlink to an external directory).
          try {
            await ensurePathContained(containmentRoot, skillsRootReal);
          } catch {
            log.warn(`Skipping ${scope} skills root: resolves outside containment root`);
            continue;
          }

          for (const { name: directoryName, dir: skillDir } of await listSkillFolders(
            skillsRootReal,
            singleSkillName
          )) {
            // Skipped plugin skills must not claim a same-named fallback in this manual scan.
            if (importedSkills != null && !importedSkills.includes(directoryName)) continue;
            // SECURITY: symlinked skill directories are allowed only through
            // readSkillDescriptor's realpath containment check, which rejects
            // entries resolving outside the containment root. This matches the
            // posture of stream discovery and plugin roots.
            const descriptor = await readSkillDescriptor(
              skillDir,
              directoryName,
              scope,
              containmentRoot,
              skillConsent,
              commandSkill
            );
            if (!descriptor) {
              continue;
            }

            const scopeKey = `${scope}:${descriptor.name}`;
            if (seenByScope.has(scopeKey)) {
              continue;
            }
            seenByScope.add(scopeKey);

            if (includeUnadvertised !== true && descriptor.advertise === false) {
              continue;
            }

            skills.push(descriptor);
          }
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));

        return {
          success: true,
          skills:
            includeUnadvertised === true
              ? skills
              : skills.filter((skill) => skill.advertise !== false),
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to list skills: ${getErrorMessage(error)}`,
        };
      }
    },
  });
};
