import * as path from "node:path";
import assert from "@/common/utils/assert";

import {
  isRemoteRuntime,
  isRuntimeReadFailure,
  isRuntimeTransportError,
  type Runtime,
} from "@/node/runtime/Runtime";
import type { ORPCContext } from "@/node/orpc/context";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { isAgentEffectivelyDisabled } from "./agentEnablement";
import { resolveAgentVisibility } from "./agentVisibility";
import { resolveGlobalRuntime } from "@/node/runtime/hostGlobalXumHome";
import { getErrorMessage } from "@/common/utils/errors";
import {
  applySettingsBaseChain,
  collectDefinitionLayers,
  settingsBaseHop,
} from "@/common/utils/ai/agentAncestorLayers";
import {
  execBuffered,
  readFileString,
  throwIfTransportFailure,
} from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/node/runtime/backgroundCommands";

import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionFrontmatterSchema,
  AgentDefinitionPackageSchema,
  AgentIdSchema,
} from "@/common/orpc/schemas";
import type {
  AgentDefinitionDescriptor,
  AgentDefinitionPackage,
  AgentDefinitionScope,
  AgentId,
} from "@/common/types/agentDefinition";
import { log } from "@/node/services/log";
import {
  isProjectTrusted,
  isWorkspaceProjectTrusted,
  projectPluginContainerPaths,
} from "@/node/utils/projectTrust";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";

import type { RuntimeFactory } from "@/node/services/runtimeFactory/runtimeFactoryService";
import {
  discoverAgentPluginsOnHost,
  hostPluginFs,
  UNIVERSAL_AGENT_PLUGINS_CONTAINER,
  type AgentPluginContainer,
  type PluginFileReadArgs,
  type PluginFileReadResult,
  type PluginFs,
} from "@/node/services/agentPlugins/discovery";
import { getRemoteProjectPluginSnapshot } from "@/node/services/agentPlugins/remoteProjectPlugins";
import {
  isPluginAgentConsented,
  type ComponentConsent,
} from "@/node/services/agentPlugins/componentConsent";
import { ambiguousPluginAgentIds, pluginAgentIdOf } from "@/node/services/agentPlugins/agentFiles";
import { expandPluginPlaceholders } from "@/node/services/agentPlugins/expansion";
import {
  describeWorkspaceRuntime,
  isPluginPathUsableFrom,
  toAgentBodyPath,
} from "@/node/services/agentPlugins/pluginPathAvailability";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

import { getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";
import {
  AgentDefinitionParseError,
  parseAgentDefinitionMarkdown,
  type ParsedAgentDefinitionMarkdown,
} from "./parseAgentDefinitionMarkdown";
import { formatPluginAgentRefusal, PluginAgentRefusalError } from "./pluginAgentRefusal";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";

export const MAX_INHERITANCE_DEPTH = 10;

/**
 * Generate a unique visit key for cycle detection that distinguishes
 * same-name agents at different scopes (e.g., project/exec vs built-in/exec).
 */
export function agentVisitKey(id: AgentId, scope: AgentDefinitionScope): string {
  return `${id}:${scope}`;
}

/**
 * When the caller already knows which scope supplied an agent definition, skip any higher-priority
 * scopes so resolution stays anchored to that package instead of re-probing more specific roots.
 *
 * Examples:
 * - Known global agent → skip project scope
 * - Known built-in agent → skip project + global scopes
 */
export function getSkipScopesAboveForKnownScope(
  scope: AgentDefinitionScope
): AgentDefinitionScope | undefined {
  switch (scope) {
    case "project":
      return undefined;
    case "global":
      return "project";
    case "built-in":
      return "global";
  }
}

/**
 * Compute the skipScopesAbove value when resolving a base agent.
 *
 * Same-name inheritance (for example project/exec -> global|built-in exec) still skips the current
 * scope entirely. Otherwise, keep the lookup anchored to the current package's scope so a known
 * global or built-in agent does not widen back into project/global overrides during inheritance.
 */
export function computeBaseSkipScope(
  baseId: AgentId,
  currentId: AgentId,
  currentScope: AgentDefinitionScope
): AgentDefinitionScope | undefined {
  if (baseId === currentId) {
    return currentScope;
  }

  return getSkipScopesAboveForKnownScope(currentScope);
}

const GLOBAL_AGENTS_ROOT = "~/.xum/agents";

export interface AgentDefinitionsRoots {
  projectRoots: string[];
  globalRoot: string;
  /** Agent Plugins container dirs, e.g. <projectRoot>/.xum/plugins (read-only). */
  projectPluginRoots?: string[];
  /** Agent Plugins container dirs, e.g. ~/.xum/plugins (read-only). */
  globalPluginRoots?: string[];
  /**
   * #6426: plugin container dirs of a TRUSTED remote checkout (remote paths). Their agents are
   * read from the host's cached snapshot (getRemoteProjectPluginSnapshot), never per turn.
   */
  remoteProjectPluginRoots?: string[];
}

export function getDefaultAgentDefinitionsRoots(
  runtime: Runtime,
  workspacePath: string,
  /** #6426: only `true` adds the project's plugin containers (see projectPluginsAllowed). */
  projectPluginsTrusted?: boolean
): AgentDefinitionsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAgentDefinitionsRoots: workspacePath is required");
  }

  return {
    projectRoots: listProjectMetadataRelativePaths("agents").map((relativePath) =>
      runtime.normalizePath(relativePath, workspacePath)
    ),
    globalRoot: GLOBAL_AGENTS_ROOT,
    ...pluginRootsOf(
      runtime,
      projectPluginContainerPaths(runtime, workspacePath, projectPluginsTrusted)
    ),
  };
}

/**
 * Remote runtimes (SSH/Docker) get the GLOBAL host plugin containers (read through a host
 * LocalRuntime). Their checkout's own plugin containers are remote paths, read from a cached
 * snapshot of the remote checkout (#6426), as in agentSkillsService. A project plugin's agents
 * load only in a trusted project (projectPluginContainerPaths gives none otherwise).
 */
function pluginRootsOf(
  runtime: Runtime,
  projectContainers: string[]
): Pick<
  AgentDefinitionsRoots,
  "projectPluginRoots" | "remoteProjectPluginRoots" | "globalPluginRoots"
> {
  if (isRemoteRuntime(runtime)) {
    return {
      ...(projectContainers.length > 0 ? { remoteProjectPluginRoots: projectContainers } : {}),
      // Tilde form: the host LocalRuntime maps ~/.xum to the host Xum home.
      globalPluginRoots: ["~/.xum/plugins", UNIVERSAL_AGENT_PLUGINS_CONTAINER],
    };
  }
  return {
    ...(projectContainers.length > 0 ? { projectPluginRoots: projectContainers } : {}),
    globalPluginRoots: [`${runtime.getXumHome()}/plugins`, UNIVERSAL_AGENT_PLUGINS_CONTAINER],
  };
}

interface AgentDefinitionScanCandidate {
  scope: Exclude<AgentDefinitionScope, "built-in">;
  root: string;
  runtime: Runtime;
  /** Agent Plugins only: canonical plugin root anchoring per-file realpath containment. */
  pluginRoot?: string;
  /** Agent Plugins only: contributing plugin name for descriptor attribution. */
  pluginName?: string;
  /** Managed plugins only: the reviewed fingerprints (#6629). Unmanaged plugins have none. */
  pluginConsent?: ComponentConsent | undefined;
  /**
   * #6426: a remote checkout's plugin agents. Their files are read from this snapshot (no remote
   * round trip), and every path stays a remote path; `runtime` is the RemoteRuntime.
   */
  pluginFs?: PluginFs;
  /**
   * The host filesystem of the scan's RuntimeFactory (hostPluginFs): the listing, containment
   * and plugin reads of a host-local root that do not go through `runtime` (phase 5).
   */
  hostFs: PluginFs;
}

/** #6426: scan candidates for the plugin agents of a trusted remote checkout's snapshot. */
async function buildRemotePluginAgentCandidates(
  runtime: Runtime,
  roots: AgentDefinitionsRoots,
  workspacePath: string,
  hostFs: PluginFs
): Promise<AgentDefinitionScanCandidate[]> {
  const containers = roots.remoteProjectPluginRoots ?? [];
  if (containers.length === 0) return [];
  const snapshot = await getRemoteProjectPluginSnapshot(runtime, workspacePath, containers);
  return (snapshot?.plugins ?? []).flatMap((plugin) =>
    plugin.agentsDir == null
      ? []
      : [
          {
            scope: "project" as const,
            root: plugin.agentsDir,
            runtime,
            pluginRoot: plugin.rootPath,
            pluginName: plugin.name,
            pluginFs: snapshot?.fs,
            hostFs,
          },
        ]
  );
}

/**
 * Agent Plugins: expand plugin container dirs into per-plugin `agents/` scan
 * candidates (host-local filesystem only, mirroring plugin skill discovery).
 */
async function buildPluginAgentScanCandidates(args: {
  containers: string[];
  scope: Exclude<AgentDefinitionScope, "built-in">;
  workspacePath: string;
  /** Project scope: plugin roots must stay inside the checkout (repo-symlink posture). */
  projectContainmentRoot?: string;
  /** The Xum home that owns the plugin registry, so managed plugins carry consent (#6629). */
  managedHome: string;
  /** Builds the host-local runtime that resolves the containers. */
  runtimeFactory: RuntimeFactory;
}): Promise<AgentDefinitionScanCandidate[]> {
  if (args.containers.length === 0) {
    return [];
  }

  const localRuntime = args.runtimeFactory.createLocalRuntime(args.workspacePath);
  const hostFs = hostPluginFs(args.runtimeFactory.hostFiles);
  const resolvedContainers: AgentPluginContainer[] = [];
  for (const container of args.containers) {
    try {
      // Container paths may be tilde-form (e.g. ~/.agents/plugins).
      resolvedContainers.push({
        path: await localRuntime.resolvePath(container),
        scope: args.scope,
      });
    } catch (err) {
      log.warn(`Failed to resolve plugin container ${container}: ${getErrorMessage(err)}`);
    }
  }

  const { plugins } = await discoverAgentPluginsOnHost(hostFs, resolvedContainers, {
    managedHome: await localRuntime.resolvePath(args.managedHome),
  });

  const candidates: AgentDefinitionScanCandidate[] = [];
  for (const plugin of plugins) {
    if (plugin.agentsDir == null) {
      continue;
    }

    if (args.projectContainmentRoot != null) {
      try {
        await hostFs.ensureContained(args.projectContainmentRoot, plugin.rootPath);
      } catch (error) {
        log.warn(
          `Skipping project plugin '${plugin.name}' at '${plugin.rootPath}': plugin root escapes the project containment root: ${getErrorMessage(error)}`
        );
        continue;
      }
    }

    candidates.push({
      scope: args.scope,
      root: plugin.agentsDir,
      runtime: localRuntime,
      pluginRoot: plugin.rootPath,
      pluginName: plugin.name,
      pluginConsent: plugin.componentConsent,
      hostFs,
    });
  }

  return candidates;
}

/**
 * Scan/read candidates in precedence order (earlier wins): project agents,
 * project plugin agents, global agents, global plugin agents. Built-ins are
 * handled separately as the lowest layer.
 */
async function buildScanCandidates(
  runtime: Runtime,
  workspacePath: string,
  roots: AgentDefinitionsRoots,
  runtimeFactory: RuntimeFactory
): Promise<AgentDefinitionScanCandidate[]> {
  // The registry lives in the Xum home above the global agents root (tilde form maps to the host
  // home), as plugin skill discovery derives it.
  const managedHome = path.dirname(roots.globalRoot);
  const hostFs = hostPluginFs(runtimeFactory.hostFiles);
  const projectPluginCandidates = await buildPluginAgentScanCandidates({
    containers: roots.projectPluginRoots ?? [],
    scope: "project",
    workspacePath,
    projectContainmentRoot: workspacePath,
    managedHome,
    runtimeFactory,
  });
  const globalPluginCandidates = await buildPluginAgentScanCandidates({
    containers: roots.globalPluginRoots ?? [],
    scope: "global",
    workspacePath,
    managedHome,
    runtimeFactory,
  });

  return [
    ...roots.projectRoots.map((root) => ({
      scope: "project" as const,
      root,
      runtime,
      hostFs,
    })),
    ...projectPluginCandidates,
    ...(await buildRemotePluginAgentCandidates(runtime, roots, workspacePath, hostFs)),
    {
      scope: "global",
      root: roots.globalRoot,
      runtime: resolveGlobalRuntime(runtime, workspacePath, runtimeFactory),
      hostFs,
    },
    ...globalPluginCandidates,
  ];
}

/** Logs each refusal of `ambiguousPluginAgentIds` and returns the IDs. */
function warnAmbiguousPluginAgents(fileNames: readonly string[]): Set<string> {
  const warnings: string[] = [];
  const ambiguous = ambiguousPluginAgentIds(fileNames, warnings);
  for (const warning of warnings) log.warn(warning);
  return ambiguous;
}

/** A plugin agents dir without the IDs two files claim (#6629). Other roots keep first-wins. */
function withoutAmbiguousPluginAgents(
  scan: Pick<AgentDefinitionScanCandidate, "pluginRoot">,
  fileNames: string[]
): string[] {
  if (scan.pluginRoot == null) return fileNames;
  const ambiguous = warnAmbiguousPluginAgents(fileNames);
  return fileNames.filter((name) => !ambiguous.has(pluginAgentIdOf(name) ?? ""));
}

type PluginAgentFileLookup =
  | { kind: "file"; path: string }
  /** No file of this plugin claims the ID: the read goes on to the next candidate. */
  | { kind: "absent" }
  /** A file claims the ID but Xum refuses it: `ambiguous-file`, or a link out of the plugin. */
  | { kind: "refused"; refusal: PluginAgentRefusalError };

/**
 * The file the definition read of a plugin agent opens (#6629): the one file of its agents dir
 * that claims the ID, under its real name (`Helper.md` for ID `helper`), and contained in the
 * plugin. Discovery lists the same name, so both paths fingerprint the same bytes and file name.
 */
export async function resolvePluginAgentFile(args: {
  pluginRoot: string;
  pluginName: string;
  agentsDir: string;
  agentId: AgentId;
  /** A remote plugin's snapshot, else the host filesystem (the candidate's hostFs). */
  pluginFs: PluginFs;
}): Promise<PluginAgentFileLookup> {
  const names = await listAgentFiles(args.pluginFs, args.agentsDir);
  const ambiguous = warnAmbiguousPluginAgents(names);
  const claimants = names.filter((candidate) => pluginAgentIdOf(candidate) === args.agentId);
  if (claimants.length === 0) return { kind: "absent" };
  if (ambiguous.has(args.agentId)) {
    const detail = claimants.sort().join(", ");
    return {
      kind: "refused",
      refusal: new PluginAgentRefusalError("ambiguous-file", args.agentId, args.pluginName, detail),
    };
  }
  const filePath = path.join(args.agentsDir, claimants[0]);
  const containment = await pluginAgentContainment({ ...args, filePath });
  if (containment === "missing") return { kind: "absent" };
  if (containment === "escapes") {
    return {
      kind: "refused",
      refusal: new PluginAgentRefusalError(
        "invalid-definition",
        args.agentId,
        args.pluginName,
        "the agent file does not stay inside its plugin folder (a link leads out of it)"
      ),
    };
  }
  return { kind: "file", path: filePath };
}

/**
 * Agent Plugins: per-file realpath containment anchored at the canonical
 * plugin root, so a symlinked agents/<id>.md cannot escape the plugin.
 */
async function pluginAgentContainment(args: {
  pluginRoot: string;
  filePath: string;
  agentId: AgentId;
  /** A remote plugin's snapshot, else the host filesystem (the candidate's hostFs). */
  pluginFs: PluginFs;
}): Promise<"contained" | "missing" | "escapes"> {
  try {
    await args.pluginFs.ensureContained(args.pluginRoot, args.filePath);
    return "contained";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    log.warn(
      `Plugin agent '${args.agentId}' at '${args.filePath}' escapes the plugin root: ${getErrorMessage(error)}`
    );
    return "escapes";
  }
}

/** The agent files of a plugin agents dir: in a remote snapshot, else on the host. */
async function listAgentFiles(pluginFs: PluginFs, root: string): Promise<string[]> {
  try {
    const entries = await pluginFs.readdir(root);
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** A scan root's agent files: from its snapshot, over its remote runtime, or on the host. */
function listCandidateAgentFiles(
  scan: Pick<AgentDefinitionScanCandidate, "runtime" | "pluginFs" | "hostFs">,
  resolvedRoot: string,
  workspacePath: string
): Promise<string[]> {
  return scan.pluginFs == null && isRemoteRuntime(scan.runtime)
    ? listAgentFilesFromRuntime(scan.runtime, resolvedRoot, { cwd: workspacePath })
    : listAgentFiles(candidateFs(scan), resolvedRoot);
}

/** A scan root, resolved. A remote plugin root is already a real remote path: no round trip. */
function resolveCandidateRoot(
  candidate: Pick<AgentDefinitionScanCandidate, "runtime" | "root" | "pluginFs">
): Promise<string> {
  return candidate.pluginFs != null
    ? Promise.resolve(candidate.root)
    : candidate.runtime.resolvePath(candidate.root);
}

/** The filesystem of a candidate's plugin reads: its remote snapshot, else the host's. */
function candidateFs(
  candidate: Pick<AgentDefinitionScanCandidate, "pluginFs" | "hostFs">
): PluginFs {
  // mutation-equivalent: pluginFs is a PluginFs object or undefined, so ?? and || agree
  return candidate.pluginFs ?? candidate.hostFs;
}

/** A plugin agent file: from its remote snapshot, else the host's contained reader (hostFs). */
function readPluginAgentFile(
  pluginFs: PluginFs,
  args: PluginFileReadArgs
): Promise<PluginFileReadResult> {
  return pluginFs.readFileCapped(args);
}

async function listAgentFilesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  if (!options.cwd) {
    throw new Error("listAgentFilesFromRuntime: options.cwd is required");
  }

  const quotedRoot = shellQuote(root);
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find ${quotedRoot} -mindepth 1 -maxdepth 1 -type f -name '*.md' -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  throwIfTransportFailure(runtime, result, `Failed to read agents directory ${root}`);
  if (result.exitCode !== 0) {
    log.warn(`Failed to read agents directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getAgentIdFromFilename(filename: string): AgentId | null {
  const parsed = path.parse(filename);
  if (parsed.ext.toLowerCase() !== ".md") {
    return null;
  }

  const idRaw = parsed.name.trim().toLowerCase();
  const idParsed = AgentIdSchema.safeParse(idRaw);
  if (!idParsed.success) {
    return null;
  }

  return idParsed.data;
}

/** Plugin agents parse with the Claude Code / Cursor format mapping (pluginAgentFormat.ts). */
function parseSource(
  pluginRoot: string | undefined,
  agentId: AgentId
): { plugin?: { agentId: string } } {
  return pluginRoot != null ? { plugin: { agentId } } : {};
}

/**
 * Parse one agent file. A managed plugin agent must also match its review (#6629): discovery and
 * the definition read both parse through here, so an agent changed after its review neither lists
 * nor loads. It throws like an invalid definition, which both callers skip. The definition read
 * keeps the throw as the spawn error (`not-reviewed`) when no other scope has the ID.
 */
function parseAgentFile(
  args: { content: string; byteSize: number; agentId: AgentId; filePath: string },
  candidate: Pick<AgentDefinitionScanCandidate, "pluginRoot" | "pluginName" | "pluginConsent">
) {
  const parsed = parseAgentDefinitionMarkdown({
    content: args.content,
    byteSize: args.byteSize,
    ...parseSource(candidate.pluginRoot, args.agentId),
  });
  const consentInput = {
    id: args.agentId,
    file: path.basename(args.filePath),
    frontmatter: parsed.frontmatter,
  };
  if (!isPluginAgentConsented(candidate.pluginConsent, consentInput)) {
    throw new PluginAgentRefusalError("not-reviewed", args.agentId, pluginNameOf(candidate), "");
  }
  return parsed;
}

function pluginNameOf(candidate: Pick<AgentDefinitionScanCandidate, "pluginName" | "pluginRoot">) {
  // mutation-equivalent: a plugin candidate always has a non-empty name and root, so ?? and || agree
  return candidate.pluginName ?? path.basename(candidate.pluginRoot ?? "?");
}

const PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

/**
 * A foreign plugin agent whose body names its plugin folder (`${CLAUDE_PLUGIN_ROOT}`) cannot do
 * its job where the workspace cannot read that folder (RFC A2). Same rule as plugin skills'
 * directory line. A Xum-format agent body is never rewritten, so it needs no folder; neither
 * does an agent that never names it.
 */
function pluginFolderRefusal(args: {
  parsed: Pick<ParsedAgentDefinitionMarkdown, "foreign" | "body">;
  agentId: AgentId;
  candidate: Pick<AgentDefinitionScanCandidate, "runtime" | "pluginName" | "pluginRoot">;
  workspaceRuntime: Runtime;
}): PluginAgentRefusalError | undefined {
  if (!args.parsed.foreign || !args.parsed.body.includes(PLUGIN_ROOT_PLACEHOLDER)) {
    return undefined;
  }
  if (isPluginPathUsableFrom(args.candidate.runtime, args.workspaceRuntime)) return undefined;
  return new PluginAgentRefusalError(
    "folder-unreachable",
    args.agentId,
    pluginNameOf(args.candidate),
    describeWorkspaceRuntime(args.workspaceRuntime)
  );
}

/**
 * The body a plugin agent runs with: a foreign agent's `${CLAUDE_PLUGIN_ROOT}` becomes its plugin
 * folder's path. This runs after the consent check on the text sent to the model, so it never
 * changes the consent fingerprint (it covers the ID, file name and frontmatter, not the body).
 * `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_DATA}`, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}` stay literal.
 */
function pluginAgentBody(args: {
  parsed: ParsedAgentDefinitionMarkdown;
  agentId: AgentId;
  candidate: Pick<AgentDefinitionScanCandidate, "runtime" | "pluginName" | "pluginRoot">;
  workspaceRuntime: Runtime;
  refuseUnreachablePluginFolder: boolean;
}): string {
  const { parsed, candidate } = args;
  if (!parsed.foreign) return parsed.body;
  const refusal = pluginFolderRefusal(args);
  if (refusal !== undefined) {
    if (args.refuseUnreachablePluginFolder) throw refusal;
    // A folder path that is not valid here would only mislead: keep the placeholder as written.
    return parsed.body;
  }
  assert(candidate.pluginRoot != null, "a foreign agent file is read only from a plugin");
  return expandPluginPlaceholders(parsed.body, {
    CLAUDE_PLUGIN_ROOT: toAgentBodyPath(candidate.pluginRoot, candidate.runtime),
  });
}

function unavailableFields(
  refusal: PluginAgentRefusalError | undefined,
  filePath: string
): Pick<AgentDefinitionDescriptor, "unavailableReason" | "unavailablePath"> {
  if (refusal === undefined) return {};
  return { unavailableReason: formatPluginAgentRefusal(refusal), unavailablePath: filePath };
}

async function readAgentDescriptorFromFile(
  runtime: Runtime,
  filePath: string,
  agentId: AgentId,
  scope: Exclude<AgentDefinitionScope, "built-in">,
  pluginName: string | undefined,
  /**
   * Plugin agents (host-local by construction): the consuming read must
   * revalidate containment + file identity through a bounded post-open
   * handle. pluginAgentContainment ran BEFORE this call, and a managed
   * update promoted in between can replace agents/<id>.md (or an ancestor)
   * with an absolute symlink to an outside definition — staged validation
   * reads that as a capability removal, and the outside frontmatter would
   * otherwise control agent policy (runnable/base/tools).
   */
  pluginRoot: string | undefined,
  pluginConsent: ComponentConsent | undefined,
  /** The remote snapshot or the host filesystem of a plugin agent (see readPluginAgentFile). */
  pluginFs: PluginFs,
  /** The workspace's own runtime: `runtime` above is the one that read the file. */
  workspaceRuntime: Runtime
): Promise<AgentDefinitionDescriptor | null> {
  let content: string;
  let byteSize: number;
  if (pluginRoot != null) {
    try {
      const result = await readPluginAgentFile(pluginFs, {
        filePath,
        pluginRoot,
        maxBytes: MAX_FILE_SIZE,
        label: `plugin agent '${agentId}'`,
      });
      content = result.content;
      byteSize = result.byteSize;
    } catch (err) {
      log.warn(`Failed to read plugin agent definition ${filePath}: ${getErrorMessage(err)}`);
      return null;
    }
  } else {
    let stat;
    try {
      stat = await runtime.stat(filePath);
    } catch (error) {
      if (isRuntimeTransportError(error)) throw error;
      return null;
    }

    if (stat.isDirectory) {
      return null;
    }

    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      log.warn(`Skipping agent '${agentId}' (${scope}): ${sizeValidation.error}`);
      return null;
    }

    try {
      content = await readFileString(runtime, filePath);
    } catch (err) {
      if (isRuntimeTransportError(err)) throw err;
      log.warn(`Failed to read agent definition ${filePath}: ${getErrorMessage(err)}`);
      return null;
    }
    byteSize = stat.size;
  }

  try {
    const parsed = parseAgentFile(
      { content, byteSize, agentId, filePath },
      { pluginRoot, pluginName, pluginConsent }
    );

    const { selectable } = resolveAgentVisibility(parsed.frontmatter.ui);
    // Listed, but not runnable here (RFC A2): the `task` list leaves it out, a direct spawn
    // names the reason, and the composition inspector reports it.
    const unavailable = pluginFolderRefusal({
      parsed,
      agentId,
      candidate: { runtime, pluginName, pluginRoot },
      workspaceRuntime,
    });

    const descriptor: AgentDefinitionDescriptor = {
      id: agentId,
      scope,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      uiSelectable: selectable,
      uiColor: parsed.frontmatter.ui?.color,
      subagentRunnable: parsed.frontmatter.subagent?.runnable ?? false,
      ...backgroundHintField(parsed.frontmatter),
      base: parsed.frontmatter.base,
      aiDefaults: parsed.frontmatter.ai,
      tools: parsed.frontmatter.tools,
      ...(pluginName !== undefined ? { pluginName } : {}),
      ...unavailableFields(unavailable, filePath),
    };

    const validated = AgentDefinitionDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent definition descriptor for ${agentId}: ${validated.error.message}`);
      return null;
    }

    return validated.data;
  } catch (err) {
    const message = err instanceof AgentDefinitionParseError ? err.message : getErrorMessage(err);
    log.warn(`Skipping invalid agent definition '${agentId}' (${scope}): ${message}`);
    return null;
  }
}

export function backgroundHintField(
  frontmatter: Pick<AgentDefinitionPackage["frontmatter"], "subagent">
): { backgroundHint?: true } {
  return frontmatter.subagent?.background_hint === true ? { backgroundHint: true } : {};
}

function buildAgentDescriptor(pkg: AgentDefinitionPackage): AgentDefinitionDescriptor {
  const { selectable } = resolveAgentVisibility(pkg.frontmatter.ui);

  return {
    id: pkg.id,
    scope: pkg.scope,
    name: pkg.frontmatter.name,
    description: pkg.frontmatter.description,
    uiSelectable: selectable,
    uiColor: pkg.frontmatter.ui?.color,
    subagentRunnable: pkg.frontmatter.subagent?.runnable ?? false,
    ...backgroundHintField(pkg.frontmatter),
    base: pkg.frontmatter.base,
    aiDefaults: pkg.frontmatter.ai,
    tools: pkg.frontmatter.tools,
  };
}

export async function discoverAgentDefinitions(
  runtime: Runtime,
  workspacePath: string,
  options: {
    roots?: AgentDefinitionsRoots;
    /**
     * When false, return every discovered descriptor in precedence order
     * (shadowed ids included) instead of only the effective one per id.
     * Used by the plugin composition inspector to report shadowing.
     */
    dedupeById?: boolean;
    /** #6426: only `true` adds project plugin agents (used only when `roots` is absent). */
    projectPluginsTrusted?: boolean;
    /** Builds the host-local runtimes of the plugin and global scans. */
    runtimeFactory: RuntimeFactory;
  }
): Promise<AgentDefinitionDescriptor[]> {
  if (!workspacePath) {
    throw new Error("discoverAgentDefinitions: workspacePath is required");
  }

  const roots = resolveAgentDefinitionsRoots(runtime, workspacePath, options);
  const dedupeById = options.dedupeById ?? true;

  const byId = new Map<AgentId, AgentDefinitionDescriptor>();
  const discovered: AgentDefinitionDescriptor[] = [];

  // Scan order encodes precedence: earlier roots win when ids collide.
  const scans = await buildScanCandidates(runtime, workspacePath, roots, options.runtimeFactory);

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await resolveCandidateRoot(scan);
    } catch (err) {
      if (isRuntimeTransportError(err)) throw err;
      log.warn(`Failed to resolve agents root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const filenames = withoutAmbiguousPluginAgents(
      scan,
      await listCandidateAgentFiles(scan, resolvedRoot, workspacePath)
    );

    for (const filename of filenames) {
      const agentId = getAgentIdFromFilename(filename);
      if (!agentId) {
        log.warn(`Skipping invalid agent filename '${filename}' in ${resolvedRoot}`);
        continue;
      }

      if (dedupeById && byId.has(agentId)) {
        continue;
      }

      const filePath = scan.runtime.normalizePath(filename, resolvedRoot);

      if (scan.pluginRoot != null) {
        const containment = await pluginAgentContainment({
          pluginRoot: scan.pluginRoot,
          filePath,
          agentId,
          pluginFs: candidateFs(scan),
        });
        if (containment !== "contained") continue;
      }

      const descriptor = await readAgentDescriptorFromFile(
        scan.runtime,
        filePath,
        agentId,
        scan.scope,
        scan.pluginName,
        scan.pluginRoot,
        scan.pluginConsent,
        candidateFs(scan),
        runtime
      );
      if (!descriptor) continue;

      if (dedupeById) {
        // First discovered descriptor wins because duplicates are skipped above. An unavailable
        // plugin agent keeps its place: it hides a lower scope's agent of that ID from the list,
        // and a spawn of that ID is refused instead of starting the lower agent (A2, A4).
        byId.set(agentId, descriptor);
      } else {
        discovered.push(descriptor);
      }
    }
  }

  // Built-ins are lowest precedence and are omitted when overridden.
  for (const pkg of getBuiltInAgentDefinitions()) {
    if (dedupeById) {
      if (!byId.has(pkg.id)) {
        byId.set(pkg.id, buildAgentDescriptor(pkg));
      }
      continue;
    }

    discovered.push(buildAgentDescriptor(pkg));
  }

  // Return all discovered agents (including those disabled by front-matter).
  // Filtering is applied at higher layers (e.g., agents.list) so Settings can still surface opt-in agents.
  const agents = dedupeById ? Array.from(byId.values()) : discovered;
  // Sort same-ID duplicates as one group keyed by the WINNING (first
  // discovered, highest precedence) definition's display name: sorting on each
  // row's own name could reorder rows within an ID group, and composition
  // consumers treat the first row per ID as the effective definition.
  const groupNameById = new Map<string, string>();
  for (const agent of agents) {
    if (!groupNameById.has(agent.id)) {
      groupNameById.set(agent.id, agent.name);
    }
  }
  return agents.sort((a, b) => {
    const byGroupName = (groupNameById.get(a.id) ?? a.name).localeCompare(
      groupNameById.get(b.id) ?? b.name
    );
    if (byGroupName !== 0) {
      return byGroupName;
    }
    // Same group name, different IDs: keep the order deterministic. Same ID:
    // 0 lets the stable sort preserve discovery (precedence) order.
    return a.id.localeCompare(b.id);
  });
}

/**
 * Request-scoped memo for `readAgentDefinition`.
 *
 * One stream request resolves the same definitions several times (agent
 * resolution, disablement checks, inheritance, prompt body, frontmatter, and
 * sub-agent discovery); on SSH runtimes every probe is a remote round-trip.
 * Create one cache per request and drop it with the request. Nothing is shared
 * across requests, so edits between turns are always picked up.
 *
 * The key covers every input that can change the winning definition (runtime
 * identity, workspace path, agent id, roots identity, plugin inclusion, and
 * skipped scopes), so precedence and base resolution are exactly as uncached.
 * Promises are memoized so concurrent lookups in one request share one read.
 */
export class AgentDefinitionRequestCache {
  private readonly definitions = new Map<string, Promise<AgentDefinitionPackage>>();
  /** Identity keys: distinct runtime, roots or runtime factory objects never share entries. */
  private readonly objectIds = new WeakMap<
    Runtime | AgentDefinitionsRoots | RuntimeFactory,
    number
  >();
  private nextObjectId = 1;

  private objectId(value: Runtime | AgentDefinitionsRoots | RuntimeFactory): number {
    let id = this.objectIds.get(value);
    if (id == null) {
      id = this.nextObjectId++;
      this.objectIds.set(value, id);
    }
    return id;
  }

  read(
    runtime: Runtime,
    workspacePath: string,
    agentId: AgentId,
    options: ReadAgentDefinitionOptions,
    load: () => Promise<AgentDefinitionPackage>
  ): Promise<AgentDefinitionPackage> {
    const key = JSON.stringify([
      this.objectId(runtime),
      workspacePath,
      agentId,
      options.roots != null ? this.objectId(options.roots) : null,
      options.skipScopesAbove ?? null,
      // #6426: the default roots differ with trust (project plugin agents).
      options.projectPluginsTrusted === true,
      this.objectId(options.runtimeFactory),
      options.refuseUnreachablePluginFolder === true,
    ]);
    let definition = this.definitions.get(key);
    if (definition == null) {
      definition = load();
      this.definitions.set(key, definition);
    }
    return definition;
  }
}

export interface ReadAgentDefinitionOptions {
  roots?: AgentDefinitionsRoots;
  /** Per-request reuse of resolved definitions; the caller owns its lifetime. */
  cache?: AgentDefinitionRequestCache;
  /**
   * Skip scopes at or above this level when resolving.
   * Used for base resolution: when a project-scope agent has `base: exec`,
   * we skip project scope to find the global/built-in exec, avoiding self-reference.
   */
  skipScopesAbove?: AgentDefinitionScope;
  /**
   * Cancels the underlying runtime stat/read work (e.g. SSH commands) and stops
   * probing further candidates; readAgentDefinition then rejects with the abort reason.
   */
  abortSignal?: AbortSignal;
  /** #6426: only `true` adds project plugin agents (used only when `roots` is absent). */
  projectPluginsTrusted?: boolean;
  /** Builds the host-local runtimes of the plugin and global scans. */
  runtimeFactory: RuntimeFactory;
  /**
   * Opt-in for a spawn by ID (the two `task` paths): a foreign plugin agent that names its plugin
   * folder, which this workspace cannot read, ends the lookup with a `folder-unreachable`
   * refusal. The agent keeps its ID, so no lower scope's agent starts in its place (A4). Other
   * reads (the main chat, a base chain, settings) keep loading the agent with its placeholder
   * as written, so an unreachable agent never breaks them. Applies to the agent read by ID, not
   * to its bases.
   */
  refuseUnreachablePluginFolder?: boolean;
}

const SCOPE_PRIORITY: AgentDefinitionScope[] = ["project", "global", "built-in"];

/** The skip scope of a base read in an inheritance walk: whichever of the two skips more. */
function mergeSkipScopesAbove(
  a: AgentDefinitionScope | undefined,
  b: AgentDefinitionScope | undefined
): AgentDefinitionScope | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  const aIndex = SCOPE_PRIORITY.indexOf(a);
  const bIndex = SCOPE_PRIORITY.indexOf(b);

  // Defensive fallback. (In practice, both should always be in SCOPE_PRIORITY.)
  if (aIndex === -1 || bIndex === -1) {
    return a;
  }

  // Prefer the scope that skips *more* (e.g. global skips project+global).
  return aIndex > bIndex ? a : b;
}

/** The caller's roots, else the default roots for its trust (discovery and reads share it). */
function resolveAgentDefinitionsRoots(
  runtime: Runtime,
  workspacePath: string,
  options: { roots?: AgentDefinitionsRoots; projectPluginsTrusted?: boolean } | undefined
): AgentDefinitionsRoots {
  if (options?.roots != null) return options.roots;
  return getDefaultAgentDefinitionsRoots(runtime, workspacePath, options?.projectPluginsTrusted);
}

/** The options each inherited read keeps from the caller (its skip scope is per base). */
function pickInheritedReadOptions(
  options: Pick<
    ReadAgentDefinitionOptions,
    "roots" | "cache" | "projectPluginsTrusted" | "runtimeFactory"
  >
): Pick<
  ReadAgentDefinitionOptions,
  "roots" | "cache" | "projectPluginsTrusted" | "runtimeFactory"
> {
  return {
    roots: options.roots,
    cache: options.cache,
    projectPluginsTrusted: options.projectPluginsTrusted,
    runtimeFactory: options.runtimeFactory,
  };
}

export async function readAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage> {
  if (!workspacePath) {
    throw new Error("readAgentDefinition: workspacePath is required");
  }
  const cache = options.cache;
  if (cache != null) {
    return cache.read(runtime, workspacePath, agentId, options, () =>
      loadAgentDefinition(runtime, workspacePath, agentId, options)
    );
  }
  return loadAgentDefinition(runtime, workspacePath, agentId, options);
}

async function loadAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage> {
  const roots = resolveAgentDefinitionsRoots(runtime, workspacePath, options);
  const skipScopesAbove = options.skipScopesAbove;

  // Determine which scopes to skip based on skipScopesAbove
  const skipScopes = new Set<AgentDefinitionScope>();
  if (skipScopesAbove) {
    const skipIndex = SCOPE_PRIORITY.indexOf(skipScopesAbove);
    if (skipIndex !== -1) {
      // Skip this scope and all higher-priority scopes
      for (let i = 0; i <= skipIndex; i++) {
        skipScopes.add(SCOPE_PRIORITY[i]);
      }
    }
  }

  // Precedence: project overrides plugin(project) overrides global overrides
  // plugin(global) overrides built-in.
  const candidates = await buildScanCandidates(
    runtime,
    workspacePath,
    roots,
    options.runtimeFactory
  );

  const abortSignal = options.abortSignal;
  // A plugin candidate that fails to load (not-reviewed, ambiguous-file, invalid-definition) is
  // skipped, as discovery skips it: a lower scope's agent of that ID starts. Its refusal is the
  // spawn error only when no scope has the ID (A4).
  const refusals: PluginAgentRefusalError[] = [];
  for (const candidate of candidates) {
    abortSignal?.throwIfAborted();
    if (skipScopes.has(candidate.scope)) {
      continue;
    }

    let resolvedRoot: string;
    try {
      resolvedRoot = await resolveCandidateRoot(candidate);
    } catch (error) {
      // An unreachable host is not a missing root: never fall through to a
      // lower scope or the built-in agent on a transport failure (#4438).
      if (isRuntimeTransportError(error)) throw error;
      continue;
    }

    try {
      const pkg = await readCandidateDefinition({
        candidate,
        resolvedRoot,
        agentId,
        workspaceRuntime: runtime,
        refuseUnreachablePluginFolder: options.refuseUnreachablePluginFolder === true,
        abortSignal,
      });
      if (pkg !== undefined) return pkg;
    } catch (error) {
      // An aborted or failed read (transport, permission) is not a missing
      // candidate: stop probing instead of falling through to a lower scope
      // (#4438, #4827). Parse and validation errors still skip the candidate.
      if (abortSignal?.aborted || isRuntimeReadFailure(error)) throw error;
      const refusal = pluginAgentRefusalOf(error, candidate, agentId);
      // The agent is listed here, so it must not hand its ID to a lower scope (A2, A4).
      if (refusal?.reason === "folder-unreachable") throw refusal;
      if (refusal !== undefined) refusals.push(refusal);
    }
  }

  if (!skipScopes.has("built-in")) {
    const builtIn = getBuiltInAgentDefinitions().find((pkg) => pkg.id === agentId);
    if (builtIn) {
      const validated = AgentDefinitionPackageSchema.safeParse({ ...builtIn, source: "built-in" });
      if (!validated.success) {
        throw new Error(
          `Invalid built-in agent definition '${agentId}': ${validated.error.message}`
        );
      }
      return validated.data;
    }
  }

  if (refusals.length > 0) throw refusals[0];
  throw new Error(`Agent definition not found: ${agentId}`);
}

/**
 * Undefined when the candidate has no such agent. Throws when it has one that cannot load.
 */
async function readCandidateDefinition(args: {
  candidate: AgentDefinitionScanCandidate;
  resolvedRoot: string;
  agentId: AgentId;
  workspaceRuntime: Runtime;
  refuseUnreachablePluginFolder: boolean;
  abortSignal: AbortSignal | undefined;
}): Promise<AgentDefinitionPackage | undefined> {
  const { candidate, agentId, abortSignal } = args;
  let filePath = candidate.runtime.normalizePath(`${agentId}.md`, args.resolvedRoot);

  if (candidate.pluginRoot != null) {
    const lookup = await resolvePluginAgentFile({
      pluginRoot: candidate.pluginRoot,
      pluginName: pluginNameOf(candidate),
      agentsDir: args.resolvedRoot,
      agentId,
      pluginFs: candidateFs(candidate),
    });
    if (lookup.kind === "absent") return undefined;
    if (lookup.kind === "refused") throw lookup.refusal;
    filePath = lookup.path;
  }

  let content: string;
  let byteSize: number;
  if (candidate.pluginRoot != null) {
    // Plugin agents: bounded post-open revalidation (containment + file
    // identity) — see the pluginRoot doc on readAgentDescriptorFromFile.
    // This frontmatter controls agent policy (runnable/base/tools), so a
    // replacement symlink promoted after pluginAgentContainment must not
    // have its outside target read here.
    const result = await readPluginAgentFile(candidateFs(candidate), {
      filePath,
      pluginRoot: candidate.pluginRoot,
      maxBytes: MAX_FILE_SIZE,
      label: `plugin agent '${agentId}'`,
    });
    content = result.content;
    byteSize = result.byteSize;
  } else {
    const stat = await candidate.runtime.stat(filePath, abortSignal);
    if (stat.isDirectory) {
      return undefined;
    }

    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      throw new Error(sizeValidation.error);
    }

    content = await readFileString(candidate.runtime, filePath, abortSignal);
    byteSize = stat.size;
  }
  const parsed = parseAgentFile({ content, byteSize, agentId, filePath }, candidate);

  const pkg: AgentDefinitionPackage = {
    id: agentId,
    scope: candidate.scope,
    frontmatter: parsed.frontmatter,
    body: pluginAgentBody({
      parsed,
      agentId,
      candidate,
      workspaceRuntime: args.workspaceRuntime,
      refuseUnreachablePluginFolder: args.refuseUnreachablePluginFolder,
    }),
    // Exact provenance for strict-send pinning; per-plugin candidate roots are
    // unique per plugin, so root identity distinguishes file vs plugin sources.
    source: candidate.root,
  };

  const validated = AgentDefinitionPackageSchema.safeParse(pkg);
  if (!validated.success) {
    throw new Error(
      `Invalid agent definition package for '${agentId}' (${candidate.scope}): ${validated.error.message}`
    );
  }

  return validated.data;
}

/**
 * Why a plugin candidate that failed to load is refused: a typed refusal as it is, any other
 * failure of a plugin agent file (parse, mapping, read, containment) as `invalid-definition`.
 * None for a non-plugin candidate, whose failures stay a skip.
 */
function pluginAgentRefusalOf(
  error: unknown,
  candidate: Pick<AgentDefinitionScanCandidate, "pluginName" | "pluginRoot">,
  agentId: AgentId
): PluginAgentRefusalError | undefined {
  if (error instanceof PluginAgentRefusalError) return error;
  if (candidate.pluginRoot == null) return undefined;
  return new PluginAgentRefusalError(
    "invalid-definition",
    agentId,
    pluginNameOf(candidate),
    getErrorMessage(error)
  );
}

/**
 * Resolve the effective system prompt body for an agent, including inherited content.
 *
 * By default (or with `prompt.append: true`), the agent's body is appended to its base's body.
 * Set `prompt.append: false` to replace the base body entirely.
 *
 * When resolving a base, we skip the current agent's scope to allow overriding built-ins:
 * - Project-scope `exec.md` with `base: exec` → resolves to global/built-in exec
 * - Global-scope `exec.md` with `base: exec` → resolves to built-in exec
 */
export async function resolveAgentBody(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options: {
    roots?: AgentDefinitionsRoots;
    skipScopesAbove?: AgentDefinitionScope;
    cache?: AgentDefinitionRequestCache;
    /** #6426: see ReadAgentDefinitionOptions.projectPluginsTrusted. */
    projectPluginsTrusted?: boolean;
    /** See ReadAgentDefinitionOptions.runtimeFactory. */
    runtimeFactory: RuntimeFactory;
  }
): Promise<string> {
  const visited = new Set<string>();
  const baseReadOptions = pickInheritedReadOptions(options);

  async function resolve(
    id: AgentId,
    depth: number,
    skipScopesAbove?: AgentDefinitionScope
  ): Promise<string> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    const pkg = await readAgentDefinition(runtime, workspacePath, id, {
      ...baseReadOptions,
      skipScopesAbove,
    });

    const visitKey = agentVisitKey(pkg.id, pkg.scope);
    if (visited.has(visitKey)) {
      throw new Error(`Circular agent inheritance detected: ${pkg.id} (${pkg.scope})`);
    }
    visited.add(visitKey);

    const baseId = pkg.frontmatter.base;
    const shouldAppend = pkg.frontmatter.prompt?.append !== false;

    if (!baseId || !shouldAppend) {
      return pkg.body;
    }

    const baseBody = await resolve(
      baseId,
      depth + 1,
      mergeSkipScopesAbove(skipScopesAbove, computeBaseSkipScope(baseId, id, pkg.scope))
    );
    const separator = baseBody.trim() && pkg.body.trim() ? "\n\n" : "";
    return `${baseBody}${separator}${pkg.body}`;
  }

  return resolve(agentId, 0, options.skipScopesAbove);
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepMergeAgentFrontmatter(
  base: unknown,
  overlay: unknown,
  path: readonly string[]
): unknown {
  // Inherit base when the overlay isn't specified.
  if (overlay === undefined) {
    return base;
  }

  const pathKey = path.join(".");
  if (Array.isArray(base) && Array.isArray(overlay) && pathKey === "tools.require") {
    // Require semantics are "last layer wins" to avoid inheriting multiple
    // required-tool patterns that can make policy application ambiguous.
    return [...(overlay as unknown[])];
  }

  if (
    Array.isArray(base) &&
    Array.isArray(overlay) &&
    (pathKey === "tools.add" || pathKey === "tools.remove")
  ) {
    // Tool layers are processed in order (base first, then child).
    return [...(base as unknown[]), ...(overlay as unknown[])];
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, overlayValue] of Object.entries(overlay)) {
      merged[key] = deepMergeAgentFrontmatter(merged[key], overlayValue, [...path, key]);
    }

    return merged;
  }

  // Primitive, array (non-tools), or mismatched types: overlay wins.
  return overlay;
}

interface ResolvedAgentDefinitionWithAiChain {
  definition: AgentDefinitionPackage;
  /**
   * Each hop's own (unmerged) `ai`, target first. The walk skips the scopes that
   * resolveAgentInheritanceChain skips, so collectDefinitionLayers over it gives the layers a
   * run of the agent resolves.
   */
  aiChain: AiChainHop[];
}

interface AiChainHop {
  id: AgentId;
  ai?: AgentDefinitionPackage["frontmatter"]["ai"];
  scope: AgentDefinitionScope;
}

/**
 * Resolve prompt and frontmatter in one base-chain walk so callers authorize
 * and execute the same definition snapshot. Frontmatter always inherits when
 * `base` is set, even when the child replaces the base prompt.
 */
export async function resolveAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage> {
  return (await resolveAgentDefinitionWithAiChain(runtime, workspacePath, agentId, options))
    .definition;
}

async function resolveAgentDefinitionWithAiChain(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options: ReadAgentDefinitionOptions
): Promise<ResolvedAgentDefinitionWithAiChain> {
  if (!workspacePath) {
    throw new Error("resolveAgentFrontmatter: workspacePath is required");
  }

  const visited = new Set<string>();
  const baseReadOptions = pickInheritedReadOptions(options);

  async function resolve(
    id: AgentId,
    depth: number,
    skipScopesAbove?: AgentDefinitionScope,
    /** Set for the agent read by ID only: its bases keep loading an unreachable agent. */
    refuseUnreachablePluginFolder?: boolean
  ): Promise<ResolvedAgentDefinitionWithAiChain> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    const pkg = await readAgentDefinition(runtime, workspacePath, id, {
      ...baseReadOptions,
      skipScopesAbove,
      refuseUnreachablePluginFolder,
    });

    const visitKey = agentVisitKey(pkg.id, pkg.scope);
    if (visited.has(visitKey)) {
      throw new Error(`Circular agent inheritance detected: ${pkg.id} (${pkg.scope})`);
    }
    visited.add(visitKey);

    const hop = { id: pkg.id, ai: pkg.frontmatter.ai, scope: pkg.scope };
    const baseId = pkg.frontmatter.base;
    if (!baseId) {
      return { definition: pkg, aiChain: [hop] };
    }

    const resolvedBase = await resolve(
      baseId,
      depth + 1,
      mergeSkipScopesAbove(skipScopesAbove, computeBaseSkipScope(baseId, id, pkg.scope))
    );
    const base = resolvedBase.definition;

    const mergedRaw = deepMergeAgentFrontmatter(base.frontmatter, pkg.frontmatter, []);
    const merged = AgentDefinitionFrontmatterSchema.safeParse(mergedRaw);
    if (!merged.success) {
      throw new Error(
        `Invalid merged frontmatter for '${id}': ${formatZodIssues(merged.error.issues)}`
      );
    }

    const separator = base.body.trim() && pkg.body.trim() ? "\n\n" : "";
    return {
      definition: {
        ...pkg,
        frontmatter: merged.data,
        body:
          pkg.frontmatter.prompt?.append === false
            ? pkg.body
            : `${base.body}${separator}${pkg.body}`,
      },
      aiChain: [hop, ...resolvedBase.aiChain],
    };
  }

  return resolve(agentId, 0, options.skipScopesAbove, options.refuseUnreachablePluginFolder);
}

export async function resolveAgentFrontmatter(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage["frontmatter"]> {
  return (await resolveAgentDefinition(runtime, workspacePath, agentId, options)).frontmatter;
}

/**
 * Resolve a headless agent definition: a user override at <muxRoot>/agents/<agentId>.md
 * (global agent scope) shadows the built-in definition, like any other agent.
 * `muxRoot` is Config.rootDir — NOT a hardcoded ~/.xum — so dev builds
 * (~/.xum-dev), MUX_ROOT sandboxes, and tests all stay isolated.
 * Host-side read only — headless runs are runtime-independent, so project-scope
 * agent overrides (which need a live checkout) are intentionally not resolved.
 * Shared with the debug CLI.
 */
export async function resolveHeadlessAgentDefinition(
  muxRoot: string,
  agentId: string,
  runtimeFactory: RuntimeFactory
): Promise<AgentDefinitionPackage | null> {
  assert(/^[a-z0-9][a-z0-9_-]*$/.test(agentId), "headless agent ID must be path-safe");
  try {
    const definition = await resolveAgentDefinition(
      runtimeFactory.createLocalRuntime(muxRoot),
      muxRoot,
      agentId,
      {
        // Headless tools have no live checkout: never consult repo overrides or plugins.
        roots: { projectRoots: [], globalRoot: path.join(muxRoot, "agents") },
        runtimeFactory,
      }
    );
    const body = definition.body.trim();
    // Preserve legacy frontmatter-only overrides without discarding their effective metadata.
    const fallbackBody = getBuiltInAgentDefinitions().find((entry) => entry.id === agentId)?.body;
    return { ...definition, body: body || (fallbackBody ?? "") };
  } catch (error) {
    // Invalid inheritance must not silently send memory using another definition/model.
    log.warn("[HeadlessAgent] failed to resolve definition", {
      agentId,
      error: getErrorMessage(error),
    });
    return null;
  }
}

export type AgentDefinitionsContext = Pick<ORPCContext, "config"> & {
  aiService: Pick<ORPCContext["aiService"], "getWorkspaceMetadata" | "runtimeFactory">;
  initStateManager: Pick<ORPCContext["initStateManager"], "waitForInit">;
};

export async function resolveAgentDiscoveryContext(
  context: AgentDefinitionsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<{
  runtime: Runtime;
  discoveryPath: string;
  metadata?: WorkspaceMetadata;
  /** #6426: whether project plugin agents may load for this discovery. */
  projectPluginsTrusted: boolean;
}> {
  if (!input.projectPath && !input.workspaceId)
    throw new Error("Either projectPath or workspaceId must be provided");
  if (input.workspaceId) {
    const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
    if (!metadataResult.success) throw new Error(metadataResult.error);
    const metadata = metadataResult.data;
    const runtime = createRuntimeForWorkspace(metadata);
    return {
      runtime,
      discoveryPath: input.disableWorkspaceAgents
        ? metadata.projectPath
        : runtime.getWorkspacePath(metadata.projectPath, metadata.name),
      metadata,
      projectPluginsTrusted: isWorkspaceProjectTrusted(context.config, metadata),
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
  const projectPath = input.projectPath!;
  return {
    runtime: createRuntime({ type: "local", srcBaseDir: context.config.srcDir }, { projectPath }),
    discoveryPath: projectPath,
    projectPluginsTrusted: isProjectTrusted(context.config, projectPath),
  };
}

/**
 * A listed agent's `aiLayers`, and its `aiSettingsBase` only when applied (D26). The settings
 * base is read as a run reads it (resolveAgentAiSettingsChain): anchored to the declaring hop's
 * scope, and whether or not it is disabled.
 */
async function listedAgentAiSettings(
  agentId: AgentId,
  aiChain: AiChainHop[],
  readAiChain: (id: AgentId, skipScopesAbove?: AgentDefinitionScope) => Promise<AiChainHop[] | null>
): Promise<Pick<AgentDefinitionDescriptor, "aiLayers" | "aiSettingsBase">> {
  const hop = settingsBaseHop(aiChain);
  const settingsBase = hop?.ai?.settingsBase;
  if (hop == null || settingsBase == null) {
    return { aiLayers: collectDefinitionLayers(agentId, aiChain) };
  }
  const skipScopesAbove = computeBaseSkipScope(settingsBase, hop.id, hop.scope);
  const result = applySettingsBaseChain(
    agentId,
    aiChain,
    await readAiChain(settingsBase, skipScopesAbove)
  );
  const aiLayers = collectDefinitionLayers(agentId, result.chain);
  if (result.ignored == null) return { aiLayers, aiSettingsBase: settingsBase };
  log.warn("settingsBase ignored", { agentId, settingsBase, reason: result.ignored });
  return { aiLayers };
}

export async function listAgentDefinitions(
  context: AgentDefinitionsContext,
  input: {
    projectPath?: string;
    workspaceId?: string;
    disableWorkspaceAgents?: boolean;
    includeDisabled?: boolean;
  }
) {
  if (input.workspaceId) await context.initStateManager.waitForInit(input.workspaceId);
  const { runtime, discoveryPath, projectPluginsTrusted } = await resolveAgentDiscoveryContext(
    context,
    input
  );
  const runtimeFactory = context.aiService.runtimeFactory;
  const descriptors = await discoverAgentDefinitions(runtime, discoveryPath, {
    projectPluginsTrusted,
    runtimeFactory,
  });
  const cfg = context.config.loadConfigOrDefault();
  const readAiChain = (agentId: AgentId, skipScopesAbove?: AgentDefinitionScope) =>
    resolveAgentDefinitionWithAiChain(runtime, discoveryPath, agentId, {
      skipScopesAbove,
      projectPluginsTrusted,
      runtimeFactory,
    }).then(
      (resolvedDefinition) => resolvedDefinition.aiChain,
      () => null
    );
  const resolved = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        const resolvedDefinition = await resolveAgentDefinitionWithAiChain(
          runtime,
          discoveryPath,
          descriptor.id,
          {
            skipScopesAbove: getSkipScopesAboveForKnownScope(descriptor.scope),
            projectPluginsTrusted,
            runtimeFactory,
          }
        );
        const resolvedFrontmatter = resolvedDefinition.definition.frontmatter;
        if (
          isAgentEffectivelyDisabled({ cfg, agentId: descriptor.id, resolvedFrontmatter }) &&
          input.includeDisabled !== true
        )
          return null;
        return {
          descriptor,
          resolvedFrontmatter,
          aiSettings: await listedAgentAiSettings(
            descriptor.id,
            resolvedDefinition.aiChain,
            readAiChain
          ),
        };
      } catch {
        return { descriptor };
      }
    })
  );
  return resolved.flatMap((entry) => {
    if (entry == null) return [];
    if (entry.resolvedFrontmatter == null) return [entry.descriptor];
    const frontmatter = entry.resolvedFrontmatter;
    return [
      {
        ...entry.descriptor,
        name: frontmatter.name,
        description: frontmatter.description,
        uiSelectable: resolveAgentVisibility(frontmatter.ui).selectable,
        uiColor: frontmatter.ui?.color,
        subagentRunnable: frontmatter.subagent?.runnable ?? false,
        ...backgroundHintField(frontmatter),
        base: frontmatter.base,
        aiDefaults: frontmatter.ai,
        ...entry.aiSettings,
        tools: frontmatter.tools,
      },
    ];
  });
}

export async function getAgentDefinition(
  context: AgentDefinitionsContext,
  input: {
    projectPath?: string;
    workspaceId?: string;
    disableWorkspaceAgents?: boolean;
    agentId: AgentId;
  }
) {
  if (input.workspaceId) await context.initStateManager.waitForInit(input.workspaceId);
  const { runtime, discoveryPath, projectPluginsTrusted } = await resolveAgentDiscoveryContext(
    context,
    input
  );
  return readAgentDefinition(runtime, discoveryPath, input.agentId, {
    projectPluginsTrusted,
    runtimeFactory: context.aiService.runtimeFactory,
  });
}
