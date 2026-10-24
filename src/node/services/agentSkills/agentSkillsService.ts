import * as path from "node:path";
import * as os from "node:os";

import {
  isRuntimeReadFailure,
  isRuntimeTransportError,
  type Runtime,
  type RuntimeError,
} from "@/node/runtime/Runtime";
import type { ORPCContext } from "@/node/orpc/context";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { resolveWorkspaceCreationScope } from "@/common/utils/subProjects";
import {
  appendSubProjectRelativePath,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import { resolveAgentDiscoveryContext } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveSkillStorageContext, type SkillStorageContext } from "./skillStorageContext";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { resolveGlobalRuntime } from "@/node/runtime/hostGlobalXumHome";
import { PlatformPaths } from "@/node/utils/paths.main";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { normalizeForDescendantComparison } from "@/common/utils/subProjects";
import { getErrorMessage } from "@/common/utils/errors";
import {
  execBuffered,
  readFileString,
  throwIfTransportFailure,
} from "@/node/utils/runtime/helpers";

import {
  AgentSkillDescriptorSchema,
  AgentSkillPackageSchema,
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillUserInvocable,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas";
import { resolveSkillPaths } from "@/common/utils/skills/skillPaths";
import type {
  AgentSkillDescriptor,
  AgentSkillIssue,
  AgentSkillListResult,
  AgentSkillPackage,
  AgentSkillScope,
  AgentSkillUnavailableSource,
  SkillLookupName,
  SkillName,
} from "@/common/types/agentSkill";
import {
  formatQualifiedSkillName,
  parseSkillLookupName,
} from "@/common/utils/agentSkills/skillLookupName";
import { log } from "@/node/services/log";
import { isProjectTrusted, projectPluginContainerPaths } from "@/node/utils/projectTrust";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";
import { ensureRuntimePathWithinWorkspace } from "@/node/services/tools/runtimeSkillPathUtils";
import {
  ensurePathContained,
  hasErrorCode,
  isSameHostDirectory,
} from "@/node/services/tools/skillFileUtils";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";
import { getBuiltInSkillByName, getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";
import type { ProjectSkillContainment } from "./skillStorageContext";
import {
  discoverAgentPlugins,
  type AgentPluginContainer,
  nodePluginFs,
  type PluginFs,
  readPluginFileWithinRootCapped,
  pluginSkillFolderAlias,
  pluginSkillFolderNames,
  UNIVERSAL_AGENT_PLUGINS_CONTAINER,
} from "@/node/services/agentPlugins/discovery";
import { getRemoteProjectPluginSnapshot } from "@/node/services/agentPlugins/remoteProjectPlugins";
import {
  pluginSkillFileName,
  pluginSkillMarkdown,
} from "@/node/services/agentPlugins/claudeCommands";
import type {
  ComponentConsent,
  PluginSkillConsentGate,
} from "@/node/services/agentPlugins/componentConsent";
import {
  consentedPluginSkill,
  pluginSkillConsentGate,
  type ApprovedCopiesSource,
} from "@/node/services/agentPlugins/approvedCopies";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  getCanonicalProjectMetadataRelativePath,
  LEGACY_MUX_SKILLS_CLI_GLOBAL_DIR,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";

const UNIVERSAL_SKILLS_ROOT = "~/.agents/skills";
// Claude Code compatibility roots (claude-skills-compat experiment): discovery-only,
// lowest precedence within each scope. Write tools never target these roots.
const CLAUDE_SKILLS_ROOT = "~/.claude/skills";
// Agent Plugins containers: discovery-only, host-local, lowest precedence
// within each scope. Write tools never target plugin roots.
const UNIVERSAL_PLUGINS_ROOT = UNIVERSAL_AGENT_PLUGINS_CONTAINER;
// Host Xum home in tilde form: the host LocalRuntime maps it to the configured
// home (XUM_ROOT, dev suffix) when plugin containers are resolved.
const HOST_XUM_HOME = "~/.xum";

export interface AgentSkillsRoots {
  projectRoot: string;
  /**
   * Ordered project roots for subprojects: nearest directory first, then each
   * ancestor through the checkout root. When present, this replaces the three
   * singular project roots above for discovery while writes still target projectRoot.
   */
  projectRoots?: string[];
  /** Inclusive checkout/repository boundary for inherited project roots. */
  projectSearchRoot?: string;
  globalRoot: string;
  universalRoot?: string;
  /**
   * ~/.mux/skills, where the skills CLI writes for `--agent mux` (read-only). Discovery skips it
   * when it is the Xum home's own skills dir (globalRoot).
   */
  legacyMuxGlobalRoot?: string;
  /** ~/.claude/skills (claude-skills-compat experiment; read-only). */
  globalClaudeRoot?: string;
  /** Agent Plugins container dirs, e.g. <projectRoot>/.xum/plugins (read-only). */
  projectPluginRoots?: string[];
  /** Agent Plugins container dirs, e.g. ~/.xum/plugins (read-only). */
  globalPluginRoots?: string[];
  /**
   * #6426: plugin container dirs of a TRUSTED remote checkout (remote paths). Their skills are
   * read from the host's cached snapshot (getRemoteProjectPluginSnapshot), never per turn.
   */
  remoteProjectPluginRoots?: string[];
  /**
   * Host Xum home that owns the plugin registry (import receipts). When absent,
   * it is derived from globalRoot, which is only valid when globalRoot is a host
   * path. Remote runtimes set it because their globalRoot can be a remote path.
   */
  pluginManagedHome?: string;
}

function getProjectDirectories(
  runtime: Runtime,
  projectPath: string,
  projectSearchRoot: string
): string[] {
  const start = runtime.normalizePath(".", projectPath).replaceAll("\\", "/");
  const boundary = runtime.normalizePath(".", projectSearchRoot).replaceAll("\\", "/");
  const normalizedBoundary = normalizeForDescendantComparison(boundary);
  const directories: string[] = [];
  let current = start;

  while (true) {
    // POSIX dirname turns a normalized Windows drive root (`C:/`) into `C:`.
    // Restore the separator before using it as a base path so Windows runtimes
    // do not interpret the inherited root relative to the drive's current cwd.
    const directory =
      /^[A-Za-z]:$/u.test(current) && /^[A-Za-z]:\/$/u.test(boundary) ? `${current}/` : current;
    directories.push(directory);
    // Registered Windows project paths may differ only by casing. Use the same
    // comparison semantics as project hierarchy derivation so inheritance still
    // stops at the configured checkout boundary.
    if (normalizeForDescendantComparison(current) === normalizedBoundary) {
      return directories;
    }

    // Runtime.normalizePath intentionally does not collapse `..` for every
    // runtime (notably SSH/Docker). Project paths use POSIX separators after the
    // normalization above, so dirname guarantees each iteration moves upward.
    const parent = path.posix.dirname(current);
    if (parent === current) {
      // Fail closed when the supplied boundary is not an ancestor. A malformed
      // scope must not make discovery walk arbitrary filesystem parents.
      return [start];
    }
    current = parent;
  }
}

export function buildProjectSkillRoots(
  runtime: Runtime,
  projectPath: string,
  projectSearchRoot: string,
  options?: { includeClaudeSkills?: boolean }
): string[] {
  // Directory distance wins before root convention, so a subproject's
  // .agents/skill overrides a checkout-level Xum skill with the same name.
  return getProjectDirectories(runtime, projectPath, projectSearchRoot).flatMap((directory) => [
    ...listProjectMetadataRelativePaths("skills").map((relativePath) =>
      runtime.normalizePath(relativePath, directory)
    ),
    runtime.normalizePath(".agents/skills", directory),
    ...(options?.includeClaudeSkills ? [runtime.normalizePath(".claude/skills", directory)] : []),
  ]);
}

/**
 * Remote runtimes (SSH/Docker) get the GLOBAL host plugin containers, read through a host
 * LocalRuntime, so a plugin installed on the Xum host works in every workspace. Their checkout's
 * own plugin containers are remote paths, read from a cached snapshot of the remote checkout
 * (#6426). The registry owner is the host Xum home, never a path derived from the remote
 * globalRoot (Docker: /var/mux).
 */
function pluginRootsOf(
  runtime: Runtime,
  projectContainers: string[]
): Pick<
  AgentSkillsRoots,
  "projectPluginRoots" | "remoteProjectPluginRoots" | "globalPluginRoots" | "pluginManagedHome"
> {
  if (runtime instanceof RemoteRuntime) {
    return {
      ...(projectContainers.length > 0 ? { remoteProjectPluginRoots: projectContainers } : {}),
      globalPluginRoots: [`${HOST_XUM_HOME}/plugins`, UNIVERSAL_PLUGINS_ROOT],
      pluginManagedHome: HOST_XUM_HOME,
    };
  }
  return {
    ...(projectContainers.length > 0 ? { projectPluginRoots: projectContainers } : {}),
    globalPluginRoots: [`${runtime.getXumHome()}/plugins`, UNIVERSAL_PLUGINS_ROOT],
  };
}

export function getDefaultAgentSkillsRoots(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    includeClaudeSkills?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
    /** #6426: only `true` adds the project's plugin containers (see projectPluginsAllowed). */
    projectPluginsTrusted?: boolean;
  }
): AgentSkillsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAgentSkillsRoots: workspacePath is required");
  }

  const projectSearchRoot = options?.projectSearchRoot ?? workspacePath;
  const pluginContainers = projectPluginContainerPaths(
    runtime,
    projectSearchRoot,
    options?.projectPluginsTrusted
  );
  return {
    projectRoot: runtime.normalizePath(
      getCanonicalProjectMetadataRelativePath("skills"),
      workspacePath
    ),
    projectSearchRoot,
    projectRoots: buildProjectSkillRoots(runtime, workspacePath, projectSearchRoot, {
      includeClaudeSkills: options?.includeClaudeSkills,
    }),
    globalRoot: `${runtime.getXumHome()}/skills`,
    universalRoot: UNIVERSAL_SKILLS_ROOT,
    legacyMuxGlobalRoot: getLegacyMuxGlobalSkillsRoot(runtime, workspacePath),
    // Claude roots are added only when the experiment is enabled so the default
    // (off) behavior stays byte-identical to the pre-experiment scan order.
    ...(options?.includeClaudeSkills ? { globalClaudeRoot: CLAUDE_SKILLS_ROOT } : {}),
    ...pluginRootsOf(runtime, pluginContainers),
  };
}

export function getProjectSkillRoots(roots: AgentSkillsRoots): string[] {
  // Precedence: nearest directory first, then .xum > .mux > .agents > .claude.
  return Array.from(new Set(roots.projectRoots ?? [roots.projectRoot]));
}

/**
 * ~/.mux/skills as the global runtime reads it, like universalRoot: on the Xum host (local, SSH)
 * or in the runtime's own home (Docker). The host needs the absolute path because expandTilde
 * maps a `~/.mux` path to the Xum home.
 */
export function getLegacyMuxGlobalSkillsRoot(runtime: Runtime, workspacePath: string): string {
  if (resolveGlobalRuntime(runtime, workspacePath) instanceof RemoteRuntime) {
    return `~/${LEGACY_MUX_SKILLS_CLI_GLOBAL_DIR}`;
  }
  // The same home that universalRoot's `~/` expands to (HOME/USERPROFILE when called), not
  // os.homedir(), which Bun does not update when HOME changes. So a test or sandbox that points
  // HOME at a temp folder does not read the host's ~/.mux/skills (#7167).
  const home = PlatformPaths.expandHome("~");
  return path.join(home === "~" ? os.homedir() : home, LEGACY_MUX_SKILLS_CLI_GLOBAL_DIR);
}

/** True when ~/.mux/skills is the Xum home's own skills dir (the home is ~/.mux, or links to it). */
async function isLegacyMuxRootTheGlobalRoot(
  globalRuntime: Runtime,
  globalRoot: string,
  legacyMuxRoot: string
): Promise<boolean> {
  try {
    const [resolvedGlobal, resolvedLegacy] = await Promise.all(
      [globalRoot, legacyMuxRoot].map((root) => globalRuntime.resolvePath(root))
    );
    if (resolvedGlobal === resolvedLegacy) return true;
    return (
      !(globalRuntime instanceof RemoteRuntime) &&
      (await isSameHostDirectory(resolvedGlobal, resolvedLegacy))
    );
  } catch {
    // Unresolvable: keep the root, so its scan reports why it is unavailable.
    return false;
  }
}

async function getGlobalSkillRoots(
  roots: AgentSkillsRoots,
  globalRuntime: Runtime
): Promise<string[]> {
  const legacyMuxRoot =
    roots.legacyMuxGlobalRoot != null &&
    !(await isLegacyMuxRootTheGlobalRoot(
      globalRuntime,
      roots.globalRoot,
      roots.legacyMuxGlobalRoot
    ))
      ? roots.legacyMuxGlobalRoot
      : undefined;
  // Precedence within global scope: ~/.xum > ~/.agents > ~/.mux (skills CLI) > ~/.claude.
  const orderedRoots = [
    roots.globalRoot,
    roots.universalRoot,
    legacyMuxRoot,
    roots.globalClaudeRoot,
  ].filter((root): root is string => root != null && root.length > 0);

  return Array.from(new Set(orderedRoots));
}

interface AgentSkillScanCandidate {
  scope: AgentSkillScope;
  root: string;
  runtime: Runtime;
  /**
   * Agent Plugins only: canonical plugin root anchoring per-skill realpath
   * containment (§4.1). Present exactly for plugin skills/ roots.
   */
  pluginRoot?: string;
  /** Agent Plugins only: contributing plugin name for descriptor attribution. */
  pluginName?: string;
  /**
   * Agent Plugins only: `root` holds SKILL.md itself and is this one skill
   * (PluginSkillsRoot `single`), instead of a folder of skill folders.
   */
  singleSkillName?: string;
  /** Agent Plugins only: the single skill is a Claude command, `<root>/<name>.md` (claudeCommands.ts). */
  commandSkill?: true | undefined;
  /** Agent Plugins only: the plugin is skills-only (a generated Skills install): no scripts run. */
  skillsOnlyPlugin?: true | undefined;
  /** Agent Plugins only: the plugin is a Claude Code package (AgentPluginInfo.claudeFallback). */
  claudePackagePlugin?: true | undefined;
  importedSkills?: string[];
  /** Managed plugins only: the reviewed skill fingerprints (#6498). */
  skillConsent?: PluginSkillConsentGate;
  /** Managed plugins only: every consent record, for the skill's workflow script (#6629). */
  pluginConsent?: ComponentConsent | undefined;
  /** Managed plugins only: the install's approved copies, for the skill's workflow script. */
  pluginApprovedCopies?: ApprovedCopiesSource | undefined;
  /**
   * #6426: a remote checkout's plugin skill. Its files are read from this snapshot (no remote
   * round trip), and every path stays a remote path; `runtime` is the RemoteRuntime.
   */
  pluginFs?: PluginFs;
}

/**
 * #6426: scan candidates for the plugin skills of a trusted remote checkout, from its cached
 * snapshot. No snapshot (a failed or refused listing) means no candidates.
 */
async function buildRemotePluginScanCandidates(
  runtime: Runtime,
  roots: AgentSkillsRoots,
  workspacePath: string
): Promise<AgentSkillScanCandidate[]> {
  const containers = roots.remoteProjectPluginRoots ?? [];
  if (containers.length === 0) return [];
  const checkoutRoot = roots.projectSearchRoot ?? workspacePath;
  const snapshot = await getRemoteProjectPluginSnapshot(runtime, checkoutRoot, containers);
  if (snapshot === null) return [];
  return snapshot.plugins.flatMap((plugin) =>
    // Claude slash commands of remote plugins do not load (#7218).
    (plugin.skillsDirs ?? []).flatMap((root) =>
      root.command === true
        ? []
        : [
            {
              scope: "project" as const,
              root: root.dir,
              runtime,
              pluginRoot: plugin.rootPath,
              pluginName: plugin.name,
              singleSkillName: root.name,
              skillsOnlyPlugin: plugin.skillsOnly,
              claudePackagePlugin: plugin.claudeFallback,
              pluginFs: snapshot.fs,
            },
          ]
    )
  );
}

/**
 * Agent Plugins: expand plugin container dirs into per-plugin `skills/` scan
 * candidates. Host-local filesystem only (v1).
 */
async function buildPluginScanCandidates(args: {
  containers: string[];
  scope: "project" | "global";
  managedHome?: string;
  workspacePath: string;
  /**
   * Project scope: plugin roots must additionally stay inside the project
   * containment root so repo-controlled symlinks under .xum/plugins keep the
   * same escape posture as .xum/skills.
   */
  projectContainmentRoot?: string;
}): Promise<AgentSkillScanCandidate[]> {
  if (args.containers.length === 0) {
    return [];
  }

  const localRuntime = new LocalRuntime(args.workspacePath);
  const managedHome =
    args.managedHome !== undefined ? await localRuntime.resolvePath(args.managedHome) : undefined;
  const resolvedContainers: AgentPluginContainer[] = [];
  for (const container of args.containers) {
    try {
      // Container paths may be tilde-form (e.g. ~/.agents/plugins).
      const resolvedPath = await localRuntime.resolvePath(container);
      resolvedContainers.push({
        path: resolvedPath,
        scope: args.scope,
      });
    } catch (err) {
      log.warn(`Failed to resolve plugin container ${container}: ${getErrorMessage(err)}`);
    }
  }

  const { plugins } = await discoverAgentPlugins(resolvedContainers, { managedHome });

  const candidates: AgentSkillScanCandidate[] = [];
  for (const plugin of plugins) {
    if (plugin.skillsDirs == null) {
      continue;
    }

    if (args.projectContainmentRoot != null) {
      try {
        await ensurePathContained(args.projectContainmentRoot, plugin.rootPath);
      } catch (error) {
        log.warn(
          `Skipping project plugin '${plugin.name}' at '${plugin.rootPath}': plugin root escapes the project containment root: ${getErrorMessage(error)}`
        );
        continue;
      }
    }

    // One candidate per root, in declared order: the scan keeps the first skill of a name.
    const importedSkills = plugin.importedComponents?.skills;
    const skillConsent = pluginSkillConsentGate(plugin);
    candidates.push(
      ...plugin.skillsDirs.map((root) => ({
        scope: args.scope,
        root: root.dir,
        runtime: localRuntime,
        pluginRoot: plugin.rootPath,
        pluginName: plugin.name,
        singleSkillName: root.name,
        commandSkill: root.command,
        skillsOnlyPlugin: plugin.skillsOnly,
        claudePackagePlugin: plugin.claudeFallback,
        importedSkills,
        skillConsent,
        pluginConsent: plugin.componentConsent,
        pluginApprovedCopies: plugin.approvedCopies,
      }))
    );
  }

  return candidates;
}

/** Host Xum home that owns the plugin registry; see AgentSkillsRoots.pluginManagedHome. */
export function getPluginManagedHome(roots: AgentSkillsRoots): string | undefined {
  return roots.pluginManagedHome ?? (roots.globalRoot ? path.dirname(roots.globalRoot) : undefined);
}

async function buildScanCandidates(
  runtime: Runtime,
  workspacePath: string,
  roots: AgentSkillsRoots,
  containment: ProjectSkillContainment
): Promise<AgentSkillScanCandidate[]> {
  const globalRuntime = resolveGlobalRuntime(runtime, workspacePath);
  // Both scans can encounter the configured home, e.g. a project rooted at the user's home.
  const managedHome = getPluginManagedHome(roots);

  // Plugin skills sit at the lowest precedence within each scope, after the
  // standard (and .claude compat) roots of that scope.
  const projectPluginCandidates = await buildPluginScanCandidates({
    containers: roots.projectPluginRoots ?? [],
    scope: "project",
    workspacePath,
    managedHome,
    // Project plugin roots ALWAYS keep the repo-symlink posture: even callers
    // without project containment (UI list/get default discovery) must not
    // resolve a committed .xum/plugins/<name> symlink outside the checkout —
    // otherwise the UI would offer plugin skills that stream discovery and
    // the skill tools reject. Inherited discovery anchors containers and
    // containment at the same checkout boundary.
    projectContainmentRoot:
      containment.kind === "local" ? containment.root : (roots.projectSearchRoot ?? workspacePath),
  });
  const globalPluginCandidates = await buildPluginScanCandidates({
    containers: roots.globalPluginRoots ?? [],
    scope: "global",
    workspacePath,
    managedHome,
  });

  return [
    ...getProjectSkillRoots(roots).map((root) => ({ scope: "project" as const, root, runtime })),
    ...projectPluginCandidates,
    ...(await buildRemotePluginScanCandidates(runtime, roots, workspacePath)),
    ...(await getGlobalSkillRoots(roots, globalRuntime)).map((root) => ({
      scope: "global" as const,
      root,
      runtime: globalRuntime,
    })),
    ...globalPluginCandidates,
  ];
}

const NO_PROJECT_SKILL_CONTAINMENT: ProjectSkillContainment = { kind: "none" };

function resolveProjectSkillContainment(options?: {
  containment?: ProjectSkillContainment;
  projectContainmentRoot?: string | null;
}): ProjectSkillContainment {
  if (options?.containment != null) {
    return options.containment;
  }

  if (options?.projectContainmentRoot != null) {
    return {
      kind: "local",
      root: options.projectContainmentRoot,
    };
  }

  return NO_PROJECT_SKILL_CONTAINMENT;
}

async function assertProjectSkillContained(args: {
  runtime: Runtime;
  containment: ProjectSkillContainment;
  skillDir: string;
  skillFilePath: string;
}): Promise<void> {
  if (args.containment.kind === "none") {
    return;
  }

  // SECURITY: validate the skill DIRECTORY as well as SKILL.md. Checking only
  // the file lets a skill-dir symlink resolve outside containment while its
  // SKILL.md symlinks back inside; the skill would then be accepted and
  // sibling files would be read from the external location.
  if (args.containment.kind === "local") {
    await ensurePathContained(args.containment.root, args.skillDir, {
      allowMissing: true,
    });
    await ensurePathContained(args.containment.root, args.skillFilePath, {
      allowMissing: true,
    });
    return;
  }

  await ensureRuntimePathWithinWorkspace(
    args.runtime,
    args.containment.root,
    args.skillDir,
    "Project skill directory"
  );
  await ensureRuntimePathWithinWorkspace(
    args.runtime,
    args.containment.root,
    args.skillFilePath,
    "Project skill file"
  );
}

/**
 * Agent Plugins: §4.1 per-skill containment anchored at the canonical plugin
 * root. Returns false when the skill must be skipped: a missing SKILL.md means
 * "not a skill" (silent, per §7.1), a realpath escape is logged and reported
 * via onEscape.
 */
async function isPluginSkillContained(args: {
  pluginRoot: string;
  skillDir: string;
  skillFilePath: string;
  directoryName: string;
  /** A remote plugin skill's snapshot; the host filesystem when absent. */
  pluginFs?: PluginFs;
  onEscape?: (message: string) => void;
}): Promise<boolean> {
  const fs = args.pluginFs ?? nodePluginFs;
  try {
    // SECURITY: validate the skill directory as well as SKILL.md so a dir
    // symlink escaping the plugin root cannot hide behind a SKILL.md that
    // symlinks back inside (see assertProjectSkillContained).
    await fs.ensureContained(args.pluginRoot, args.skillDir);
    await fs.ensureContained(args.pluginRoot, args.skillFilePath);
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      const message = `Plugin skill '${args.directoryName}' at '${args.skillFilePath}' escapes the plugin root: ${getErrorMessage(error)}`;
      log.warn(message);
      args.onEscape?.(message);
    }
    return false;
  }
}

/**
 * Containment gate shared by discovery and reads. Returns false when the
 * candidate's skill must be skipped. Plugin candidates use plugin-root
 * containment (the plugin root itself was already validated against the
 * project containment root); project candidates use project containment.
 */
async function isCandidateSkillContained(args: {
  candidate: AgentSkillScanCandidate;
  containment: ProjectSkillContainment;
  skillDir: string;
  skillFilePath: string;
  directoryName: SkillName;
  /** Discovery only: report an escape as an invalid skill. */
  pushInvalidSkill?: (message: string, hint: string) => void;
}): Promise<boolean> {
  const { candidate, containment, skillDir, skillFilePath, directoryName } = args;
  if (candidate.pluginRoot != null) {
    return isPluginSkillContained({
      pluginRoot: candidate.pluginRoot,
      skillDir,
      skillFilePath,
      directoryName,
      pluginFs: candidate.pluginFs,
      onEscape: (message) =>
        args.pushInvalidSkill?.(
          message,
          "Remove the symlink escaping the plugin root or move the skill inside the plugin."
        ),
    });
  }
  if (candidate.scope !== "project") return true;

  try {
    await assertProjectSkillContained({
      runtime: candidate.runtime,
      containment,
      skillDir,
      skillFilePath,
    });
    return true;
  } catch (error) {
    if (isRuntimeTransportError(error)) throw error;
    if (hasErrorCode(error, "ENOENT")) return false;

    log.warn(
      `Skipping escaped project skill '${directoryName}' at '${skillFilePath}' for containment kind '${containment.kind}': ${getErrorMessage(error)}`
    );
    args.pushInvalidSkill?.(
      `Project skill path escapes containment root: ${getErrorMessage(error)}`,
      "Move the skill directory back under the workspace root or remove the escaping symlink."
    );
    return false;
  }
}

/**
 * Plugin skills whose bare name lost to a higher-precedence skill but stay
 * reachable as `<plugin>:<skill>`. Qualified names resolved by an earlier
 * plugin candidate (winners included) are not reachable again: a later plugin
 * with the same plugin name is not listed.
 */
class ShadowedPluginSkills {
  private readonly qualifiedNames = new Set<SkillLookupName>();
  private readonly skills: AgentSkillDescriptor[] = [];

  /** Whether a candidate that lost its bare name is still worth reading. */
  isReachable(pluginName: string | undefined, skillName: SkillName): boolean {
    return (
      pluginName != null &&
      !this.qualifiedNames.has(formatQualifiedSkillName(pluginName, skillName))
    );
  }

  /** Record a loaded descriptor; returns true when it was consumed as shadowed. */
  record(descriptor: AgentSkillDescriptor, shadowed: boolean): boolean {
    if (descriptor.pluginName == null) return false;
    this.qualifiedNames.add(formatQualifiedSkillName(descriptor.pluginName, descriptor.name));
    if (shadowed) this.skills.push(descriptor);
    return shadowed;
  }

  /** Omitted when empty so payloads stay identical for users without collisions. */
  toResult(): Pick<AgentSkillDiscoveryResult, "shadowedPluginSkills"> {
    if (this.skills.length === 0) return {};
    const qualified = (skill: AgentSkillDescriptor) =>
      formatQualifiedSkillName(skill.pluginName ?? "", skill.name);
    return {
      shadowedPluginSkills: [...this.skills].sort((a, b) =>
        qualified(a).localeCompare(qualified(b))
      ),
    };
  }
}

/** A scan root, resolved. A remote plugin root is already a real remote path: no round trip. */
function resolveCandidateRoot(
  candidate: Pick<AgentSkillScanCandidate, "runtime" | "root" | "pluginFs">
): Promise<string> {
  return candidate.pluginFs != null
    ? Promise.resolve(candidate.root)
    : candidate.runtime.resolvePath(candidate.root);
}

/** Whether `skillDir` is a directory, in the candidate's snapshot or on its runtime. */
async function isCandidateSkillDirectory(
  candidate: Pick<AgentSkillScanCandidate, "runtime" | "pluginFs">,
  skillDir: string
): Promise<boolean> {
  return candidate.pluginFs != null
    ? (await candidate.pluginFs.stat(skillDir)).isDirectory()
    : (await candidate.runtime.stat(skillDir)).isDirectory;
}

/** The skill folder `folder` in a scan root: the root itself when it is a single skill. */
function candidateSkillDir(
  candidate: Pick<AgentSkillScanCandidate, "runtime" | "singleSkillName">,
  resolvedRoot: string,
  folder: string
): string {
  return candidate.singleSkillName != null
    ? resolvedRoot
    : candidate.runtime.normalizePath(folder, resolvedRoot);
}

/**
 * The folder of skill `name` in a scan root for a lookup. A plugin skill can live in a
 * snake_case folder (pluginSkillNameOfFolder); the kebab-case folder wins when both exist,
 * as in discovery (pluginSkillFolderNames). Plugin roots are host-local or a snapshot, so the
 * extra stat costs no remote round trip.
 */
async function lookupCandidateSkillDir(
  candidate: Pick<
    AgentSkillScanCandidate,
    "runtime" | "singleSkillName" | "pluginRoot" | "pluginFs"
  >,
  resolvedRoot: string,
  name: SkillName
): Promise<string> {
  const skillDir = candidateSkillDir(candidate, resolvedRoot, name);
  const alias =
    candidate.pluginRoot != null && candidate.singleSkillName == null
      ? pluginSkillFolderAlias(name)
      : undefined;
  if (alias === undefined) return skillDir;
  const canonicalIsDirectory = await isCandidateSkillDirectory(candidate, skillDir).catch(
    (error: unknown) => {
      // An unreadable folder is not a missing one (#4438): readCandidateSkill rethrows it.
      if (isRuntimeReadFailure(error)) throw error;
      return false;
    }
  );
  return canonicalIsDirectory ? skillDir : candidateSkillDir(candidate, resolvedRoot, alias);
}

/** The Markdown file of skill `name` in `skillDir`: SKILL.md, or a Claude command's `<name>.md`. */
function candidateSkillFile(
  candidate: Pick<AgentSkillScanCandidate, "runtime" | "commandSkill">,
  skillDir: string,
  name: SkillName
): string {
  return candidate.runtime.normalizePath(
    pluginSkillFileName(name, candidate.commandSkill),
    skillDir
  );
}

/** Each folder's skill name: plugin folders can be snake_case (pluginSkillNameOfFolder). */
function candidateSkillFolderNames(
  candidate: Pick<AgentSkillScanCandidate, "pluginRoot" | "singleSkillName">,
  folders: string[]
): Array<{ folder: string; name: string }> {
  return candidate.pluginRoot != null && candidate.singleSkillName == null
    ? pluginSkillFolderNames(folders)
    : folders.map((folder) => ({ folder, name: folder }));
}

/** The skill folder names of a scan root: its own name when it is a single skill. */
async function listCandidateSkillNames(
  candidate: Pick<AgentSkillScanCandidate, "runtime" | "singleSkillName" | "pluginFs">,
  resolvedRoot: string,
  workspacePath: string
): Promise<string[]> {
  if (candidate.singleSkillName != null) return [candidate.singleSkillName];
  if (candidate.pluginFs != null) return listSkillDirectories(candidate.pluginFs, resolvedRoot);
  return candidate.runtime instanceof RemoteRuntime
    ? listSkillDirectoriesFromRuntime(candidate.runtime, resolvedRoot, { cwd: workspacePath })
    : listSkillDirectoriesFromLocalFs(resolvedRoot);
}

async function listSkillDirectoriesFromLocalFs(root: string): Promise<string[]> {
  return listSkillDirectories(nodePluginFs, root);
}

async function listSkillDirectories(pluginFs: PluginFs, root: string): Promise<string[]> {
  try {
    const entries = await pluginFs.readdir(root);
    // Include symlinks to directories — users commonly symlink skill dirs
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listSkillDirectoriesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  if (!options.cwd) {
    throw new Error("listSkillDirectoriesFromRuntime: options.cwd is required");
  }

  const quotedRoot = shellQuote(root);
  // -L follows symlinks so symlinked skill directories are discovered
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find -L ${quotedRoot} -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  throwIfTransportFailure(runtime, result, `Failed to read skills directory ${root}`);
  if (result.exitCode !== 0) {
    log.warn(`Failed to read skills directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A loaded skill whose SKILL.md `name` is only a display name gets a non-fatal warning. */
function pushDisplayNameWarning(
  options: { skillWarnings?: AgentSkillIssue[] } | undefined,
  skill: Omit<AgentSkillIssue, "message" | "hint"> & { displayName?: string }
): void {
  if (options?.skillWarnings == null || skill.displayName === undefined) return;
  const { displayName, ...identity } = skill;
  const id = identity.directoryName;
  log.debug(`Skill '${id}' (${identity.scope}) uses display name '${displayName}'`);
  options.skillWarnings.push({
    ...identity,
    message: `SKILL.md name '${displayName}' is not the directory name, so Xum loads the skill as '${id}'.`,
    hint: `Invoke it as /${id}. Set name: ${id} to remove this warning.`,
  });
}

/**
 * Read a non-plugin SKILL.md for the skill index. Each failure becomes a diagnostic and null, so
 * the scan skips the skill. A transport failure throws: an unreachable host is not a bad skill.
 */
async function readRuntimeSkillFileForScan(
  runtime: Runtime,
  skillFilePath: string,
  directoryName: SkillName,
  scope: AgentSkillScope,
  pushInvalidSkill: (message: string, hint: string) => void
): Promise<{ content: string; byteSize: number } | null> {
  let stat;
  try {
    stat = await runtime.stat(skillFilePath);
  } catch (error) {
    if (isRuntimeTransportError(error)) throw error;
    pushInvalidSkill(
      "SKILL.md is missing or unreadable.",
      "Create a SKILL.md file with YAML frontmatter (--- ... ---)."
    );
    return null;
  }

  if (stat.isDirectory) {
    pushInvalidSkill(
      "SKILL.md is a directory (expected a file).",
      "Replace SKILL.md with a regular file."
    );
    return null;
  }

  // Avoid reading very large files into memory (parseSkillMarkdown enforces the same limit).
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation) {
    log.warn(`Skipping skill '${directoryName}' (${scope}): ${sizeValidation.error}`);
    pushInvalidSkill(sizeValidation.error, "Reduce SKILL.md size below 1MB.");
    return null;
  }

  try {
    return { content: await readFileString(runtime, skillFilePath), byteSize: stat.size };
  } catch (err) {
    if (isRuntimeTransportError(err)) throw err;
    const message = getErrorMessage(err);
    log.warn(`Failed to read SKILL.md for ${directoryName}: ${message}`);
    pushInvalidSkill(
      `Failed to read SKILL.md: ${message}`,
      "Check file permissions and ensure the file is UTF-8 text."
    );
    return null;
  }
}

/** A plugin skill file: from its remote snapshot, else the host's contained reader. */
function readPluginSkillFile(
  pluginFs: PluginFs | undefined,
  args: Parameters<typeof readPluginFileWithinRootCapped>[0]
): ReturnType<typeof readPluginFileWithinRootCapped> {
  return pluginFs != null ? pluginFs.readFileCapped(args) : readPluginFileWithinRootCapped(args);
}

async function readSkillDescriptorFromDir(
  runtime: Runtime,
  skillDir: string,
  /** The skill's Markdown file in `skillDir` (candidateSkillFile). */
  skillFilePath: string,
  directoryName: SkillName,
  scope: AgentSkillScope,
  options?: {
    invalidSkills?: AgentSkillIssue[];
    skillWarnings?: AgentSkillIssue[];
    pluginName?: string;
    pluginRoot?: string;
    /** A remote plugin skill's snapshot (AgentSkillScanCandidate.pluginFs). */
    pluginFs?: PluginFs;
    skillConsent?: PluginSkillConsentGate;
    /** A Claude command: read `<name>.md` as SKILL.md text (plugin skills only). */
    commandSkill?: true | undefined;
  }
): Promise<AgentSkillDescriptor | null> {
  // Every invalid-skill diagnostic for this directory shares the same identity
  // (directoryName / scope / displayPath); only message + hint vary per failure.
  const pushInvalidSkill = (message: string, hint: string): void => {
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message,
      hint,
    });
  };

  let content: string;
  let byteSize: number;
  if (options?.pluginRoot != null) {
    // Plugin skills (host-local by construction): bounded post-open
    // revalidation of containment + file identity — see the pluginRoot doc
    // on ResolvedAgentSkill. isPluginSkillContained ran before this call,
    // and a managed update promoted in between could otherwise have the
    // stale canonical path read an outside SKILL.md.
    try {
      const result = await readPluginSkillFile(options.pluginFs, {
        filePath: skillFilePath,
        pluginRoot: options.pluginRoot,
        maxBytes: MAX_FILE_SIZE,
        label: `plugin skill '${directoryName}' SKILL.md`,
      });
      content = pluginSkillMarkdown(directoryName, result.content, options.commandSkill);
      byteSize = result.byteSize;
    } catch (err) {
      const message = getErrorMessage(err);
      log.warn(`Failed to read plugin SKILL.md for ${directoryName}: ${message}`);
      pushInvalidSkill(
        `Failed to read SKILL.md: ${message}`,
        "Ensure SKILL.md is a regular file inside the plugin (no escaping symlinks)."
      );
      return null;
    }
  } else {
    const read = await readRuntimeSkillFileForScan(
      runtime,
      skillFilePath,
      directoryName,
      scope,
      pushInvalidSkill
    );
    if (read === null) return null;
    ({ content, byteSize } = read);
  }

  try {
    // A changed managed skill serves its approved copy while the new version awaits review.
    const parsed = await consentedPluginSkill(
      options?.skillConsent,
      skillDir,
      parseSkillMarkdown({ content, byteSize, directoryName, allowDisplayName: true })
    );
    if (parsed === null) {
      pushInvalidSkill(
        "This plugin skill has not been reviewed on this install, so it does not load.",
        "Open Settings → Plugins and select Review on the plugin."
      );
      return null;
    }

    const descriptor: AgentSkillDescriptor = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      scope,
      advertise: resolveSkillAdvertise(parsed.frontmatter),
      userInvocable: resolveSkillUserInvocable(parsed.frontmatter),
      argumentHint: parsed.frontmatter["argument-hint"],
      whenToUse: resolveSkillWhenToUse(parsed.frontmatter),
      paths: resolveSkillPaths(parsed.frontmatter),
      ...(options?.pluginName !== undefined ? { pluginName: options.pluginName } : {}),
      displayName: parsed.displayName,
    };

    const validated = AgentSkillDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent skill descriptor for ${directoryName}: ${validated.error.message}`);
      pushInvalidSkill(
        `Invalid agent skill descriptor: ${validated.error.message}`,
        "Fix SKILL.md frontmatter fields to satisfy the skill schema."
      );
      return null;
    }

    pushDisplayNameWarning(options, {
      directoryName,
      scope,
      displayPath: skillFilePath,
      displayName: parsed.displayName,
    });
    return validated.data;
  } catch (err) {
    const message = err instanceof AgentSkillParseError ? err.message : getErrorMessage(err);
    log.warn(`Skipping invalid skill '${directoryName}' (${scope}): ${message}`);
    pushInvalidSkill(
      message,
      "Fix SKILL.md frontmatter (name + description) and ensure it matches the directory name."
    );
    return null;
  }
}

const SKILL_ISSUE_SCOPE_ORDER: Readonly<Record<AgentSkillScope, number>> = {
  project: 0,
  global: 1,
  "built-in": 2,
};

function compareSkillIssues(a: AgentSkillIssue, b: AgentSkillIssue): number {
  const scopeDiff = SKILL_ISSUE_SCOPE_ORDER[a.scope] - SKILL_ISSUE_SCOPE_ORDER[b.scope];
  if (scopeDiff !== 0) return scopeDiff;
  return a.directoryName.localeCompare(b.directoryName);
}

/** Omitted when empty so payloads for valid skills stay identical. */
function skillWarningsResult(
  skillWarnings: AgentSkillIssue[]
): Pick<AgentSkillDiscoveryResult, "skillWarnings"> {
  if (skillWarnings.length === 0) return {};
  return { skillWarnings: [...skillWarnings].sort(compareSkillIssues) };
}

export interface AgentSkillDiscoveryResult {
  skills: AgentSkillDescriptor[];
  invalidSkills: AgentSkillIssue[];
  /** Each entry keeps the original error so strict callers can rethrow it. */
  unavailableSources: Array<AgentSkillUnavailableSource & { error: unknown }>;
  /**
   * Dedupe mode only: plugin skills whose bare name lost to a higher-precedence
   * skill, reachable as `<pluginName>:<name>`. Omitted when empty so payloads
   * stay identical for users without collisions.
   */
  shadowedPluginSkills?: AgentSkillDescriptor[];
  /** Loaded skills with a non-fatal problem (e.g. a display name). Omitted when empty. */
  skillWarnings?: AgentSkillIssue[];
}

/** The caller's roots, else the default roots for its options (discovery and reads share it). */
function resolveSkillRoots(
  runtime: Runtime,
  workspacePath: string,
  options:
    | {
        roots?: AgentSkillsRoots;
        includeClaudeSkills?: boolean;
        projectSearchRoot?: string;
        projectPluginsTrusted?: boolean;
      }
    | undefined
): AgentSkillsRoots {
  if (options?.roots != null) return options.roots;
  return getDefaultAgentSkillsRoots(runtime, workspacePath, {
    includeClaudeSkills: options?.includeClaudeSkills,
    projectSearchRoot: options?.projectSearchRoot,
    projectPluginsTrusted: options?.projectPluginsTrusted,
  });
}

/**
 * Discover skills from every root. A list is partial by design: a root that
 * cannot be read (e.g. a project root on an unreachable SSH host) becomes an
 * unavailable source, and the other roots and the built-ins still load.
 */
export async function discoverAgentSkills(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    dedupeByName?: boolean;
    /** claude-skills-compat experiment: also scan .claude/skills roots (used only when `roots` is absent). */
    includeClaudeSkills?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
    /** #6426: only `true` adds project plugin containers (used only when `roots` is absent). */
    projectPluginsTrusted?: boolean;
  }
): Promise<AgentSkillDiscoveryResult> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkills: workspacePath is required");
  }

  const roots = resolveSkillRoots(runtime, workspacePath, options);

  const containment = resolveProjectSkillContainment(options);
  const dedupeByName = options?.dedupeByName ?? true;

  const byName = new Map<SkillName, AgentSkillDescriptor>();
  const discoveredSkills: AgentSkillDescriptor[] = [];
  const invalidSkills: AgentSkillIssue[] = [];
  const skillWarnings: AgentSkillIssue[] = [];
  const unavailableSources: AgentSkillDiscoveryResult["unavailableSources"] = [];
  const shadowedPluginSkills = new ShadowedPluginSkills();

  const scanRoot = async (scan: AgentSkillScanCandidate): Promise<void> => {
    const resolvedRoot = await resolveCandidateRoot(scan);
    const folders = await listCandidateSkillNames(scan, resolvedRoot, workspacePath);

    for (const { folder: directoryNameRaw, name: skillNameRaw } of candidateSkillFolderNames(
      scan,
      folders
    )) {
      const nameParsed = SkillNameSchema.safeParse(skillNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        invalidSkills.push({
          directoryName: directoryNameRaw,
          scope: scan.scope,
          displayPath: scan.runtime.normalizePath(directoryNameRaw, resolvedRoot),
          message: `Invalid skill directory name '${directoryNameRaw}'.`,
          hint: "Rename the directory to kebab-case (lowercase letters/numbers/hyphens).",
        });
        continue;
      }

      const directoryName = nameParsed.data;
      if (scan.importedSkills != null && !scan.importedSkills.includes(directoryName)) continue;

      // A plugin skill that loses its bare name stays reachable qualified.
      const shadowed = dedupeByName && byName.has(directoryName);
      if (shadowed && !shadowedPluginSkills.isReachable(scan.pluginName, directoryName)) continue;
      // Shadowed reads must not change invalidSkills, so bare-name users see
      // identical diagnostics.
      const diagnostics: { invalidSkills: AgentSkillIssue[]; skillWarnings: AgentSkillIssue[] } =
        shadowed ? { invalidSkills: [], skillWarnings: [] } : { invalidSkills, skillWarnings };

      const skillDir = candidateSkillDir(scan, resolvedRoot, directoryNameRaw);
      const skillFilePath = candidateSkillFile(scan, skillDir, directoryName);
      const pushInvalidSkill = (message: string, hint: string): void => {
        diagnostics.invalidSkills.push({
          directoryName,
          scope: scan.scope,
          displayPath: skillFilePath,
          message,
          hint,
        });
      };

      const contained = await isCandidateSkillContained({
        candidate: scan,
        containment,
        skillDir,
        skillFilePath,
        directoryName,
        pushInvalidSkill,
      });
      if (!contained) continue;

      const descriptor = await readSkillDescriptorFromDir(
        scan.runtime,
        skillDir,
        skillFilePath,
        directoryName,
        scan.scope,
        {
          ...diagnostics,
          ...(scan.pluginName !== undefined ? { pluginName: scan.pluginName } : {}),
          ...(scan.pluginRoot !== undefined ? { pluginRoot: scan.pluginRoot } : {}),
          pluginFs: scan.pluginFs,
          skillConsent: scan.skillConsent,
          commandSkill: scan.commandSkill,
        }
      );
      if (!descriptor) continue;

      if (shadowedPluginSkills.record(descriptor, shadowed)) continue;

      if (dedupeByName) {
        // First discovered descriptor wins because duplicates are skipped above.
        byName.set(descriptor.name, descriptor);
      } else {
        discoveredSkills.push(descriptor);
      }
    }
  };

  // Scan order encodes precedence: earlier roots win when names collide.
  const scans = await buildScanCandidates(runtime, workspacePath, roots, containment);
  // After one transport failure, the host's other roots fail at once instead
  // of each waiting out the same connection timeout.
  const transportFailures = new Map<Runtime, RuntimeError>();
  for (const scan of scans) {
    try {
      const transportFailure = transportFailures.get(scan.runtime);
      if (transportFailure) throw transportFailure;
      await scanRoot(scan);
    } catch (error) {
      if (isRuntimeTransportError(error)) transportFailures.set(scan.runtime, error);
      const message = getErrorMessage(error) || "Unknown error";
      log.warn(`Skills root ${scan.root} is unavailable: ${message}`);
      unavailableSources.push({ scope: scan.scope, displayPath: scan.root, message, error });
    }
  }

  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (dedupeByName) {
      // Built-ins are lowest precedence and are omitted when overridden by project/global skills.
      if (!byName.has(builtIn.name)) {
        byName.set(builtIn.name, builtIn);
      }
      continue;
    }

    discoveredSkills.push(builtIn);
  }

  const skills = dedupeByName ? Array.from(byName.values()) : discoveredSkills;
  skills.sort((a, b) => a.name.localeCompare(b.name));

  invalidSkills.sort(compareSkillIssues);

  return {
    skills,
    invalidSkills,
    unavailableSources,
    ...shadowedPluginSkills.toResult(),
    ...skillWarningsResult(skillWarnings),
  };
}

/**
 * Strict callers (the system-prompt skill index, agent_skill_list) must not
 * act on a list that silently lost a project root to an unreachable host
 * (#4438), so they rethrow the first transport failure.
 */
export function requireReachableSkills(result: AgentSkillDiscoveryResult): AgentSkillDescriptor[] {
  const transportFailure = result.unavailableSources.find((source) =>
    isRuntimeTransportError(source.error)
  );
  if (transportFailure) throw transportFailure.error;
  return result.skills;
}

export interface ResolvedAgentSkill {
  package: AgentSkillPackage;
  skillDir: string;
  sourceRuntime: Runtime | null;
  /**
   * Plugin provenance: set for Agent Plugin skills so consuming reads
   * (SKILL.md above, and every referenced file via agent_skill_read_file)
   * can revalidate post-open containment against the PLUGIN root. A managed
   * update can replace skills/<name> (or an ancestor) with an absolute
   * symlink to an outside directory after isPluginSkillContained passed —
   * staged validation reads that as a capability removal — so skill-dir
   * containment alone would canonicalize through the same link and accept
   * outside content.
   */
  pluginRoot?: string;
  /**
   * #6426: a remote plugin skill's snapshot. Its files (SKILL.md, agent_skill_read_file) are read
   * from it with the plugin-root rules above, never over the remote runtime.
   */
  pluginFs?: PluginFs;
  /**
   * Plugin name for Agent Plugin skills, so callers can tell the model the
   * qualified names of this plugin's shadowed siblings (pluginSiblingNote.ts).
   */
  pluginName?: string;
  /**
   * A managed plugin skill's consent records: the `skill://` resolver checks the skill's workflow
   * script against them (#6629). Absent for unmanaged plugins and non-plugin skills.
   */
  pluginConsent?: ComponentConsent | undefined;
  /** A managed plugin skill's approved copies: the `skill://` resolver falls back to them. */
  pluginApprovedCopies?: ApprovedCopiesSource | undefined;
  /**
   * A Claude command (claudeCommands.ts): `skillDir` is its commands folder, not a skill folder
   * of its own, so the `skill://` resolver runs no script for it.
   */
  commandSkill?: true | undefined;
  /** The skill's plugin is skills-only (AgentPluginInfo.skillsOnly): the resolver runs no script. */
  skillsOnlyPlugin?: true | undefined;
  /** The skill's plugin is a Claude Code package (AgentPluginInfo.claudeFallback): no script runs. */
  claudePackagePlugin?: true | undefined;
}

/** Stamp a plugin skill's provenance on its read result (see ResolvedAgentSkill.pluginName). */
function withPluginName(
  resolved: ResolvedAgentSkill | null,
  candidate: Pick<
    AgentSkillScanCandidate,
    | "pluginName"
    | "pluginConsent"
    | "pluginApprovedCopies"
    | "commandSkill"
    | "skillsOnlyPlugin"
    | "claudePackagePlugin"
  >
): ResolvedAgentSkill | null {
  if (resolved == null || candidate.pluginName == null) return resolved;
  return {
    ...resolved,
    pluginName: candidate.pluginName,
    pluginConsent: candidate.pluginConsent,
    pluginApprovedCopies: candidate.pluginApprovedCopies,
    ...(candidate.commandSkill === true ? { commandSkill: true } : {}),
    ...(candidate.skillsOnlyPlugin === true ? { skillsOnlyPlugin: true } : {}),
    ...(candidate.claudePackagePlugin === true ? { claudePackagePlugin: true } : {}),
  };
}

/** Read a non-plugin SKILL.md for a direct skill read; every failure throws. */
async function readRuntimeSkillFile(
  runtime: Runtime,
  skillFilePath: string
): Promise<{ content: string; byteSize: number }> {
  const stat = await runtime.stat(skillFilePath);
  if (stat.isDirectory) {
    throw new Error(`SKILL.md is not a file: ${skillFilePath}`);
  }

  const sizeValidation = validateFileSize(stat);
  if (sizeValidation) {
    throw new Error(sizeValidation.error);
  }

  return { content: await readFileString(runtime, skillFilePath), byteSize: stat.size };
}

async function readAgentSkillFromDir(
  runtime: Runtime,
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope,
  pluginRoot?: string,
  skillConsent?: PluginSkillConsentGate,
  /** A Claude command: read `<name>.md` as SKILL.md text (plugin skills only). */
  commandSkill?: true,
  pluginFs?: PluginFs
): Promise<ResolvedAgentSkill | null> {
  const skillFilePath = candidateSkillFile({ runtime, commandSkill }, skillDir, directoryName);

  let content: string;
  let byteSize: number;
  if (pluginRoot != null) {
    // Plugin skills are host-local by construction (plugin scan candidates
    // pin a LocalRuntime): bounded post-open revalidation — see the
    // pluginRoot doc on ResolvedAgentSkill.
    const result = await readPluginSkillFile(pluginFs, {
      filePath: skillFilePath,
      pluginRoot,
      maxBytes: MAX_FILE_SIZE,
      label: `plugin skill '${directoryName}' SKILL.md`,
    });
    content = pluginSkillMarkdown(directoryName, result.content, commandSkill);
    byteSize = result.byteSize;
  } else {
    ({ content, byteSize } = await readRuntimeSkillFile(runtime, skillFilePath));
  }
  // An unreviewed plugin skill without a verified approved copy reads like a missing one, so a
  // lower-scope skill can serve.
  const parsed = await consentedPluginSkill(
    skillConsent,
    skillDir,
    parseSkillMarkdown({ content, byteSize, directoryName, allowDisplayName: true })
  );
  if (parsed === null) return null;

  const pkg: AgentSkillPackage = {
    scope,
    directoryName,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };

  const validated = AgentSkillPackageSchema.safeParse(pkg);
  if (!validated.success) {
    throw new Error(
      `Invalid agent skill package for '${directoryName}': ${validated.error.message}`
    );
  }

  return {
    package: validated.data,
    skillDir,
    sourceRuntime: runtime,
    ...(pluginRoot != null ? { pluginRoot } : {}),
    ...(pluginFs != null ? { pluginFs } : {}),
  };
}

/**
 * Split a lookup name for readAgentSkill. Bare names pass through unchanged.
 * A bare skill name never contains `:`, so an unparsable qualified lookup can
 * only miss.
 */
function resolveReadLookup(lookupName: SkillLookupName): {
  pluginName?: string;
  skillName: SkillName;
} {
  const lookup = parseSkillLookupName(lookupName);
  if (lookup != null) return lookup;
  if (lookupName.includes(":")) throw new Error(`Agent skill not found: ${lookupName}`);
  return { skillName: lookupName };
}

/** Qualified lookups consider only the named plugin; import selection hides non-imported skills. */
function isLookupCandidate(
  candidate: AgentSkillScanCandidate,
  pluginName: string | undefined,
  skillName: SkillName
): boolean {
  if (pluginName != null && candidate.pluginName !== pluginName) return false;
  return candidate.importedSkills == null || candidate.importedSkills.includes(skillName);
}

/**
 * The skill `candidate` serves under `name`, or null when it has none (missing, not contained,
 * invalid, or an unreviewed plugin skill), so the next candidate can serve.
 */
async function readCandidateSkill(
  candidate: AgentSkillScanCandidate,
  name: SkillName,
  containment: ProjectSkillContainment
): Promise<ResolvedAgentSkill | null> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await resolveCandidateRoot(candidate);
  } catch (error) {
    // An unreachable host is not a missing skill root: never fall back to a
    // lower-scope or built-in skill on a transport failure (#4438).
    if (isRuntimeTransportError(error)) throw error;
    return null;
  }

  // A single-skill root serves only its own name.
  if (candidate.singleSkillName != null && candidate.singleSkillName !== name) return null;
  const skillDir = await lookupCandidateSkillDir(candidate, resolvedRoot, name);
  const skillFilePath = candidateSkillFile(candidate, skillDir, name);

  const contained = await isCandidateSkillContained({
    candidate,
    containment,
    skillDir,
    skillFilePath,
    directoryName: name,
  });
  if (!contained) return null;

  try {
    if (!(await isCandidateSkillDirectory(candidate, skillDir))) return null;

    return withPluginName(
      await readAgentSkillFromDir(
        candidate.runtime,
        skillDir,
        name,
        candidate.scope,
        candidate.pluginRoot,
        candidate.skillConsent,
        candidate.commandSkill,
        candidate.pluginFs
      ),
      candidate
    );
  } catch (error) {
    // An unreadable skill (transport, permission) must not let a lower-scope
    // skill with the same name win (#4438, #4827).
    if (isRuntimeReadFailure(error)) throw error;
    return null;
  }
}

/**
 * Resolve a skill by lookup name. A bare name follows scan precedence with the
 * built-in fallback. `<plugin>:<skill>` considers only that plugin's candidates
 * (project plugin before global plugin) and never falls back to non-plugin or
 * built-in skills.
 */
export async function readAgentSkill(
  runtime: Runtime,
  workspacePath: string,
  lookupName: SkillLookupName,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    /** claude-skills-compat experiment: also scan .claude/skills roots (used only when `roots` is absent). */
    includeClaudeSkills?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
    /** #6426: only `true` adds project plugin containers (used only when `roots` is absent). */
    projectPluginsTrusted?: boolean;
  }
): Promise<ResolvedAgentSkill> {
  if (!workspacePath) {
    throw new Error("readAgentSkill: workspacePath is required");
  }

  const roots = resolveSkillRoots(runtime, workspacePath, options);

  const containment = resolveProjectSkillContainment(options);

  const { pluginName, skillName: name } = resolveReadLookup(lookupName);

  // Scan order encodes precedence: earlier roots win when names collide.
  const candidates = await buildScanCandidates(runtime, workspacePath, roots, containment);

  for (const candidate of candidates) {
    if (!isLookupCandidate(candidate, pluginName, name)) continue;
    const resolved = await readCandidateSkill(candidate, name, containment);
    if (resolved !== null) return resolved;
  }

  // Check built-in skills as fallback (bare lookups only)
  const builtIn = pluginName == null ? getBuiltInSkillByName(name) : undefined;
  if (builtIn) {
    return {
      package: builtIn,
      // Built-in skills don't have a real skillDir on disk.
      // agent_skill_read_file handles built-in skills specially; this is a sentinel value.
      skillDir: `<built-in:${name}>`,
      sourceRuntime: null,
    };
  }

  throw new Error(`Agent skill not found: ${lookupName}`);
}

export type AgentSkillsContext = Pick<
  ORPCContext,
  "config" | "aiService" | "experimentsService" | "initStateManager"
>;

async function resolveAgentSkillDiscoveryContext(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<SkillStorageContext> {
  const resolved = await resolveAgentDiscoveryContext(context, input);
  const options = {
    includeClaudeSkills: context.experimentsService.isExperimentEnabled(
      EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
    ),
  };
  if (resolved.metadata == null) {
    const projectPath = input.projectPath ?? resolved.discoveryPath;
    const creationScope = resolveWorkspaceCreationScope(
      projectPath,
      context.config.loadConfigOrDefault().projects
    );
    return resolveSkillStorageContext({
      runtime: resolved.runtime,
      workspacePath: resolved.discoveryPath,
      xumScope: {
        type: "project",
        xumHome: context.config.rootDir,
        projectRoot: resolved.discoveryPath,
        projectStorageAuthority: "host-local",
        checkoutRoot: creationScope.projectPath,
        // #6426: no workspace yet, so the project's config trust decides (isProjectTrusted
        // resolves a sub-project to its parent).
        projectPluginsTrusted: isProjectTrusted(context.config, projectPath),
      },
      ...options,
    });
  }
  const workspacePath = input.disableWorkspaceAgents
    ? resolved.discoveryPath
    : appendSubProjectRelativePath(
        resolved.metadata,
        resolved.runtime,
        resolveWorkspaceRootPath(resolved.metadata, resolved.runtime)
      );
  const xumScope = context.aiService.resolveXumToolScopeForWorkspace(
    resolved.metadata,
    resolved.runtime,
    workspacePath
  );
  return resolveSkillStorageContext({
    runtime: resolved.runtime,
    workspacePath,
    xumScope:
      input.disableWorkspaceAgents && xumScope.type === "project"
        ? { ...xumScope, checkoutRoot: workspacePath }
        : xumScope,
    ...options,
  });
}

async function getAgentSkillContext(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
) {
  if (input.workspaceId) await context.initStateManager.waitForInit(input.workspaceId);
  return resolveAgentSkillDiscoveryContext(context, input);
}

export async function listAgentSkills(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<AgentSkillListResult> {
  const skillContext = await getAgentSkillContext(context, input);
  const result = await discoverAgentSkills(skillContext.runtime, skillContext.workspacePath, {
    roots: skillContext.roots,
    containment: skillContext.containment,
  });
  // Passes shadowedPluginSkills and skillWarnings through only when discovery set them.
  const { unavailableSources, ...rest } = result;
  return {
    ...rest,
    unavailableSources: unavailableSources.map(({ scope, displayPath, message }) => ({
      scope,
      displayPath,
      message,
    })),
  };
}

export async function getAgentSkill(
  context: AgentSkillsContext,
  input: {
    projectPath?: string;
    workspaceId?: string;
    disableWorkspaceAgents?: boolean;
    skillName: string;
  }
) {
  const skillContext = await getAgentSkillContext(context, input);
  const result = await readAgentSkill(
    skillContext.runtime,
    skillContext.workspacePath,
    input.skillName,
    { roots: skillContext.roots, containment: skillContext.containment }
  );
  return result.package;
}
