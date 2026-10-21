import * as crypto from "node:crypto";
import * as path from "node:path";

import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillScope, SkillName } from "@/common/types/agentSkill";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { isRuntimeTransportError, type Runtime } from "@/node/runtime/Runtime";
import {
  discoverAgentPlugins,
  readPluginFileWithinRootCapped,
  type AgentPluginContainer,
  type AgentPluginInfo,
} from "@/node/services/agentPlugins/discovery";
import { isPluginWorkflowConsented } from "@/node/services/agentPlugins/componentConsent";
import {
  consentedPluginWorkflowSource,
  type ApprovedCopiesReads,
} from "@/node/services/agentPlugins/approvedCopies";
import { pluginSkillScriptKey } from "@/node/services/agentPlugins/workflowFiles";
import { isValidAgentPluginName } from "@/node/services/agentPlugins/manifest";
import {
  getDefaultAgentSkillsRoots,
  readAgentSkill,
  type AgentSkillsRoots,
  type ResolvedAgentSkill,
  getPluginManagedHome,
} from "@/node/services/agentSkills/agentSkillsService";
import { readBuiltInSkillFile } from "@/node/services/agentSkills/builtInSkillDefinitions";
import type {
  ProjectSkillContainment,
  SkillStorageContext,
} from "@/node/services/agentSkills/skillStorageContext";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";
import {
  ensureRuntimePathWithinWorkspace,
  resolveContainedSkillFilePathOnRuntime,
} from "@/node/services/tools/runtimeSkillPathUtils";
import { ensurePathContained, isAbsolutePathAny } from "@/node/services/tools/skillFileUtils";
import { readFileString } from "@/node/utils/runtime/helpers";

export type WorkflowScriptSourceKind = "skill" | "workspace-file" | "inline" | "plugin";

export interface ResolvedWorkflowScript {
  requestedScriptPath: string;
  canonicalScriptPath: string;
  source: string;
  sourceHash: string;
  sourceKind: WorkflowScriptSourceKind;
  scope?: AgentSkillScope;
  skillName?: SkillName;
  /** Agent Plugins: contributing plugin name (plugin:// scripts only). */
  pluginName?: string;
  /** Non-built-in skill:// scripts only: the skill's plugin, or `null` outside any plugin (#6826). */
  skillPluginName?: string | null;
  relativePath?: string;
  resolvedPath?: string;
}

export interface ResolveWorkflowScriptInput {
  scriptPath?: string | null;
  scriptSource?: string | null;
  runtime: Runtime;
  workspacePath: string;
  /** Inclusive checkout/repository boundary for inherited project skills. */
  projectSearchRoot?: string;
  projectTrusted: boolean;
  roots?: AgentSkillsRoots;
  containment?: ProjectSkillContainment;
  /** Separate skill I/O context when workflow files execute in another runtime. */
  skillStorageContext?: SkillStorageContext;
  /** Shared by the resolutions of one listing: each install's approved copies are read once. */
  approvedCopiesReads?: ApprovedCopiesReads;
}

const SKILL_SCRIPT_PATH_PREFIX = "skill://";
const INLINE_SCRIPT_PATH_PREFIX = "inline://";
const PLUGIN_SCRIPT_PATH_PREFIX = "plugin://";

export async function resolveWorkflowScript(
  input: ResolveWorkflowScriptInput
): Promise<ResolvedWorkflowScript> {
  const hasPath = input.scriptPath != null;
  const hasSource = input.scriptSource != null;
  assert(
    hasPath !== hasSource,
    "resolveWorkflowScript: provide exactly one of scriptPath or scriptSource"
  );
  assert(input.workspacePath.length > 0, "resolveWorkflowScript: workspacePath is required");

  if (hasSource) {
    assert(input.scriptSource != null, "resolveWorkflowScript: scriptSource is required");
    return buildInlineWorkflowScript({
      source: input.scriptSource,
      projectTrusted: input.projectTrusted,
    });
  }

  assert(input.scriptPath != null, "resolveWorkflowScript: scriptPath is required");
  const scriptPath = input.scriptPath.trim();
  assert(scriptPath.length > 0, "resolveWorkflowScript: scriptPath is required");
  if (scriptPath.startsWith(INLINE_SCRIPT_PATH_PREFIX)) {
    throw new Error("inline:// workflow paths are provenance only; use script_source instead");
  }

  if (scriptPath.startsWith(SKILL_SCRIPT_PATH_PREFIX)) {
    return await resolveSkillWorkflowScript({ ...input, scriptPath });
  }

  if (scriptPath.startsWith(PLUGIN_SCRIPT_PATH_PREFIX)) {
    return await resolvePluginWorkflowScript({ ...input, scriptPath });
  }

  return await resolveWorkspaceFileWorkflowScript({ ...input, scriptPath });
}

function buildInlineWorkflowScript(input: {
  source: string;
  projectTrusted: boolean;
}): ResolvedWorkflowScript {
  if (!input.projectTrusted) {
    throw new Error("Project trust is required to run inline workflow scripts");
  }
  assert(input.source.length > 0, "resolveWorkflowScript: inline source is required");
  if (input.source.trim().length === 0) {
    throw new Error("Inline workflow script source must not be blank");
  }
  validateInlineWorkflowSourceByteLength(Buffer.byteLength(input.source, "utf8"));
  const sourceHash = hashSource(input.source);
  const virtualPath = `${INLINE_SCRIPT_PATH_PREFIX}workflow-${sourceHash.slice(0, 12)}.js`;
  return buildResolvedScript({
    requestedScriptPath: virtualPath,
    canonicalScriptPath: virtualPath,
    source: input.source,
    sourceKind: "inline",
  });
}

function validateInlineWorkflowSourceByteLength(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_SIZE) {
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Inline workflow script source is too large (${sizeMB}MB). The maximum workflow script size is ${maxMB}MB.`
    );
  }
}

/** The skill a `skill://` path names, read the way discovery reads it (gates included). */
function readWorkflowSkill(
  input: ResolveWorkflowScriptInput,
  skillName: Parameters<typeof readAgentSkill>[2]
): ReturnType<typeof readAgentSkill> {
  // Discovery uses the skill storage context when there is one, else the workspace.
  const workspacePath = input.skillStorageContext?.workspacePath ?? input.workspacePath;
  const roots = workflowSkillRoots(input);
  const projectSearchRoot = roots?.projectSearchRoot ?? input.projectSearchRoot ?? workspacePath;
  return readAgentSkill(workflowSkillRuntime(input), workspacePath, skillName, {
    ...(roots != null ? { roots } : { projectSearchRoot }),
    containment: workflowSkillContainment(input, projectSearchRoot),
  });
}

function workflowSkillRuntime(input: ResolveWorkflowScriptInput) {
  return input.skillStorageContext?.runtime ?? input.runtime;
}

function workflowSkillRoots(input: ResolveWorkflowScriptInput) {
  return input.roots ?? input.skillStorageContext?.roots;
}

function workflowSkillContainment(input: ResolveWorkflowScriptInput, projectSearchRoot: string) {
  return (
    input.containment ??
    input.skillStorageContext?.containment ??
    ({ kind: "runtime", root: projectSearchRoot } as const)
  );
}

async function resolveSkillWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  const parsed = parseSkillWorkflowScriptPath(input.scriptPath);
  assertJavaScriptWorkflowPath(parsed.relativePath);

  const resolvedSkill = await readWorkflowSkill(input, parsed.skillName);

  // A Claude command's skill directory is its plugin's commands folder: a script there is not
  // part of the command, and a Claude package runs no Xum workflow code.
  if (resolvedSkill.commandSkill === true) {
    throw new Error(`Skill '${parsed.skillName}' is a Claude command and has no workflow scripts`);
  }
  // A Skills install loads skills only (installMethods.ts): its skills run no workflow scripts.
  if (resolvedSkill.skillsOnlyPlugin === true) {
    throw new Error(
      `Skill '${parsed.skillName}' comes from a skills-only plugin install and has no workflow scripts`
    );
  }
  // A Claude Code package runs no Xum code (docs/agents/agent-skills.mdx): no workflow scripts.
  if (resolvedSkill.claudePackagePlugin === true) {
    throw new Error(
      `Skill '${parsed.skillName}' comes from a Claude Code plugin and has no workflow scripts`
    );
  }

  if (resolvedSkill.package.scope === "project" && !input.projectTrusted) {
    throw new Error("Project trust is required to run project skill workflow scripts");
  }

  if (resolvedSkill.package.scope === "built-in") {
    const builtIn = readBuiltInSkillFile(parsed.skillName, parsed.relativePath);
    return buildResolvedScript({
      requestedScriptPath: input.scriptPath,
      canonicalScriptPath: `${SKILL_SCRIPT_PATH_PREFIX}${parsed.skillName}/${builtIn.resolvedPath}`,
      source: builtIn.content,
      sourceKind: "skill",
      scope: "built-in",
      skillName: parsed.skillName,
      relativePath: builtIn.resolvedPath,
    });
  }

  const skillRuntime = resolvedSkill.sourceRuntime;
  assert(skillRuntime != null, "resolveWorkflowScript: non-built-in skill runtime is required");

  const resolvedPath = (
    await resolveContainedSkillFilePathOnRuntime(
      skillRuntime,
      resolvedSkill.skillDir,
      parsed.relativePath
    )
  ).resolvedPath;

  const stat = await skillRuntime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, parsed.relativePath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  const source = await reviewedSkillScriptSource(
    resolvedSkill,
    parsed.relativePath,
    await readFileString(skillRuntime, resolvedPath),
    input.approvedCopiesReads
  );
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: `${SKILL_SCRIPT_PATH_PREFIX}${parsed.skillName}/${parsed.relativePath}`,
    source,
    sourceKind: "skill",
    scope: resolvedSkill.package.scope,
    skillName: parsed.skillName,
    skillPluginName: resolvedSkill.pluginName ?? null,
    relativePath: parsed.relativePath,
    resolvedPath,
  });
}

/**
 * Discover plugins eligible to provide `plugin://` workflow scripts. Project
 * containers apply only for trusted projects (running project plugin code is
 * running repo-controlled code); global containers always apply. Plugin
 * discovery is host-filesystem-only: remote runtimes (SSH/Docker) get only the
 * global host containers from the default roots, which is intended. Their
 * scripts are read on the host and the conductor runs in Xum, so they work the
 * same as in local workspaces.
 */
export async function discoverWorkflowPlugins(input: {
  runtime: Runtime;
  workspacePath: string;
  projectSearchRoot?: string;
  projectTrusted: boolean;
  roots?: AgentSkillsRoots;
  skillStorageContext?: SkillStorageContext;
}): Promise<AgentPluginInfo[]> {
  const roots =
    input.roots ??
    input.skillStorageContext?.roots ??
    getDefaultAgentSkillsRoots(input.runtime, input.workspacePath, {
      projectSearchRoot: input.projectSearchRoot,
    });
  const projectContainmentRoot =
    input.skillStorageContext?.containment.kind === "local"
      ? input.skillStorageContext.containment.root
      : (input.projectSearchRoot ?? input.workspacePath);
  const localRuntime = new LocalRuntime(projectContainmentRoot);

  const containers: AgentPluginContainer[] = [];
  const addContainers = async (
    containerPaths: string[],
    scope: AgentPluginContainer["scope"]
  ): Promise<void> => {
    for (const containerPath of containerPaths) {
      try {
        // Container paths may be tilde-form (e.g. ~/.agents/plugins).
        containers.push({ path: await localRuntime.resolvePath(containerPath), scope });
      } catch {
        // Unresolvable container: skip, like plugin skill discovery does.
      }
    }
  };

  if (input.projectTrusted) {
    await addContainers(roots.projectPluginRoots ?? [], "project");
  }
  await addContainers(roots.globalPluginRoots ?? [], "global");

  const { plugins } = await discoverAgentPlugins(
    containers,
    await managedHomeOption(localRuntime, roots)
  );

  // Project plugin roots keep the repo-symlink posture: a committed
  // .xum/plugins/<name> symlink must not resolve outside the checkout.
  const eligible: AgentPluginInfo[] = [];
  for (const plugin of plugins) {
    if (plugin.scope === "project") {
      try {
        await ensurePathContained(projectContainmentRoot, plugin.rootPath);
      } catch {
        continue;
      }
    }
    eligible.push(plugin);
  }
  return eligible;
}

/**
 * The managed home names the registry, so managed plugins carry their consent records (#6629), as
 * plugin skill discovery does.
 */
async function managedHomeOption(
  localRuntime: LocalRuntime,
  roots: AgentSkillsRoots
): Promise<{ managedHome?: string }> {
  const managedHome = getPluginManagedHome(roots);
  return managedHome !== undefined
    ? { managedHome: await localRuntime.resolvePath(managedHome) }
    : {};
}

async function resolvePluginWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  const parsed = parsePluginWorkflowScriptPath(input.scriptPath);
  assertJavaScriptWorkflowPath(parsed.relativePath);

  const plugins = await discoverWorkflowPlugins(input);
  // First match in container precedence order wins (project before global).
  const plugin = plugins.find(
    (candidate) => candidate.name === parsed.pluginName && candidate.workflowsDir != null
  );
  if (plugin?.workflowsDir == null) {
    throw new Error(`Plugin workflow script not found: ${input.scriptPath}`);
  }

  // Realpath containment inside the plugin's workflows dir: symlinked entries
  // cannot escape the contribution directory.
  let resolvedPath: string;
  try {
    resolvedPath = await ensurePathContained(
      plugin.workflowsDir,
      path.join(plugin.workflowsDir, parsed.relativePath)
    );
  } catch (error) {
    throw new Error(`Plugin workflow script not readable: ${getErrorMessage(error)}`);
  }

  const localRuntime = new LocalRuntime(input.workspacePath);
  const stat = await localRuntime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, parsed.relativePath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  // Consuming read revalidates against the PLUGIN ROOT (not just
  // workflowsDir) with post-open containment + file identity, mirroring
  // hooks.js and mcp.json: a managed update can replace `workflows/` itself
  // with an absolute symlink to an outside directory, and the containment
  // check above would then canonicalize root and file through the SAME link
  // and accept an outside file as executable workflow source.
  let liveSource: string;
  try {
    liveSource = (
      await readPluginFileWithinRootCapped({
        filePath: resolvedPath,
        pluginRoot: plugin.rootPath,
        maxBytes: MAX_FILE_SIZE,
        label: "plugin workflow script",
      })
    ).content;
  } catch (error) {
    throw new Error(`Plugin workflow script not readable: ${getErrorMessage(error)}`);
  }
  const source = await reviewedWorkflowSource(
    plugin,
    parsed.relativePath,
    liveSource,
    input.approvedCopiesReads
  );
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: `${PLUGIN_SCRIPT_PATH_PREFIX}${plugin.name}/${parsed.relativePath}`,
    source,
    sourceKind: "plugin",
    scope: plugin.scope,
    pluginName: plugin.name,
    relativePath: parsed.relativePath,
    resolvedPath,
  });
}

/**
 * The consent gate of a managed plugin skill's script (#6629). The skill's own consent (#6498)
 * covers its SKILL.md frontmatter, not the bytes `skill://` runs, so the script needs its own
 * record, keyed by its plugin-relative path. Only the skill's `workflow.js` can have a record
 * (the install review lists no other script). This check is for a stored run's snapshot: it must
 * itself match the record.
 */
function assertSkillScriptReviewed(
  skill: Pick<ResolvedAgentSkill, "pluginConsent" | "pluginRoot" | "pluginName" | "skillDir">,
  relativePath: string,
  source: string
): void {
  if (skill.pluginConsent === undefined || skill.pluginRoot === undefined) return;
  const file = pluginSkillScriptKey(skill.pluginRoot, path.join(skill.skillDir, relativePath));
  if (isPluginWorkflowConsented(skill.pluginConsent, { file, source })) return;
  throw unreviewedWorkflowError(file, skill.pluginName ?? "?");
}

/**
 * The source a `skill://` script runs: the live source when its record matches, else the approved
 * copy when it verifies (approvedCopies.ts). Otherwise the script does not run.
 */
async function reviewedSkillScriptSource(
  skill: Pick<
    ResolvedAgentSkill,
    "pluginConsent" | "pluginApprovedCopies" | "pluginRoot" | "pluginName" | "skillDir"
  >,
  relativePath: string,
  source: string,
  reads: ApprovedCopiesReads | undefined
): Promise<string> {
  if (skill.pluginConsent === undefined || skill.pluginRoot === undefined) return source;
  const file = pluginSkillScriptKey(skill.pluginRoot, path.join(skill.skillDir, relativePath));
  const reviewed = await consentedPluginWorkflowSource(
    { componentConsent: skill.pluginConsent, approvedCopies: skill.pluginApprovedCopies },
    { file, source },
    reads
  );
  if (reviewed !== undefined) return reviewed;
  throw unreviewedWorkflowError(file, skill.pluginName ?? "?");
}

function unreviewedWorkflowError(file: string, pluginName: string): Error {
  return new Error(
    `Plugin workflow '${file}' has not been reviewed on this install, so it does not run. Open Settings → Plugins and select Review on plugin '${pluginName}'.`
  );
}

/**
 * The consent gate for a stored plugin run (#6629). Resume, checkpoint retry and crash recovery
 * run the source snapshotted in the run record and never reread the plugin file, so they check
 * that snapshot against the plugin's current consent record. A run started before the upgrade, or
 * on bytes whose review an update replaced, cannot resume. A plugin that is gone fails closed.
 */
export async function assertStoredPluginWorkflowReviewed(
  input: ResolveWorkflowScriptInput & {
    scriptPath: string;
    source: string;
    /** The discovery scope of the plugin the run started from (its descriptor's scope). */
    scope: AgentPluginContainer["scope"];
    /** skill:// runs: the descriptor's skillPluginName. Absent on legacy records (#6826). */
    skillPluginName?: string | null;
  }
): Promise<void> {
  if (input.scriptPath.startsWith(SKILL_SCRIPT_PATH_PREFIX)) {
    await assertStoredSkillWorkflowReviewed(input);
    return;
  }
  const parsed = parsePluginWorkflowScriptPath(input.scriptPath);
  const plugins = await discoverWorkflowPlugins(input);
  // Bound to the scope the run started in: a project plugin of the same name must not stand in
  // for a managed global one (project plugins carry no consent, so it would pass any snapshot).
  const plugin = plugins.find(
    (candidate) =>
      candidate.name === parsed.pluginName &&
      candidate.scope === input.scope &&
      candidate.workflowsDir != null
  );
  if (plugin === undefined) {
    throw new Error(
      `Plugin '${parsed.pluginName}' is no longer installed, so its workflow run cannot resume.`
    );
  }
  assertWorkflowReviewed(plugin, parsed.relativePath, input.source);
}

/**
 * The stored-run gate of a `skill://` run (#6777): the skill of that name, in the scope the run
 * started in, must still vouch for the snapshot. A managed plugin skill checks it against its
 * consent record, as the resolver does. Other skills carry no record and pass. A skill that is
 * gone, or that another scope now serves (an unreviewed plugin skill reads as missing), fails
 * closed: the skill found then is not the one whose script the run snapshotted. So does a skill
 * whose origin changed (#6826): a same-name user skill that now shadows the plugin skill the run
 * started from carries no consent record and would pass any snapshot. Legacy records, which do not
 * store the origin, keep the name + scope check.
 */
async function assertStoredSkillWorkflowReviewed(
  input: ResolveWorkflowScriptInput & {
    scriptPath: string;
    source: string;
    scope: AgentPluginContainer["scope"];
    skillPluginName?: string | null;
  }
): Promise<void> {
  const parsed = parseSkillWorkflowScriptPath(input.scriptPath);
  const skill = await readWorkflowSkill(input, parsed.skillName).catch((error: unknown) => {
    // A transport failure (an SSH host down) says nothing about the skill: refuse as retryable,
    // never as "no longer available" (#6826). Any other read failure reads as a missing skill.
    if (isRuntimeTransportError(error)) {
      throw new Error(
        `Skill '${parsed.skillName}' could not be read (${getErrorMessage(error)}), so its workflow run cannot resume now. Try again once the workspace is reachable.`
      );
    }
    return undefined;
  });
  if (skill?.package.scope !== input.scope) {
    throw new Error(
      `Skill '${parsed.skillName}' is no longer available in its ${input.scope} scope, so its workflow run cannot resume.`
    );
  }
  const foundPluginName = skill.pluginName ?? null;
  if (input.skillPluginName !== undefined && input.skillPluginName !== foundPluginName) {
    throw new Error(
      `Skill '${parsed.skillName}' now comes from ${skillOrigin(foundPluginName)}, but its workflow run started from ${skillOrigin(input.skillPluginName)}, so the run cannot resume.`
    );
  }
  assertSkillScriptReviewed(skill, parsed.relativePath, input.source);
}

function skillOrigin(pluginName: string | null): string {
  return pluginName === null ? "a skill outside any plugin" : `plugin '${pluginName}'`;
}

/** The stored-run consent gate (#6629): the snapshot itself must match the record. */
function assertWorkflowReviewed(plugin: AgentPluginInfo, file: string, source: string): void {
  if (isPluginWorkflowConsented(plugin.componentConsent, { file, source })) return;
  throw unreviewedWorkflowError(file, plugin.name);
}

/**
 * The consent gate (#6629) of the source the resolver is about to run: a script changed after its
 * review does not run. Its approved copy runs instead when it verifies (approvedCopies.ts).
 * Listing goes through the resolver too, so it hides a script with neither.
 */
async function reviewedWorkflowSource(
  plugin: AgentPluginInfo,
  file: string,
  source: string,
  reads: ApprovedCopiesReads | undefined
): Promise<string> {
  const reviewed = await consentedPluginWorkflowSource(plugin, { file, source }, reads);
  if (reviewed !== undefined) return reviewed;
  throw unreviewedWorkflowError(file, plugin.name);
}

function parsePluginWorkflowScriptPath(scriptPath: string): {
  pluginName: string;
  relativePath: string;
} {
  const remainder = scriptPath.slice(PLUGIN_SCRIPT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    throw new Error("plugin:// workflow script paths must include a relative .js file path");
  }

  const pluginName = remainder.slice(0, slashIndex);
  if (!isValidAgentPluginName(pluginName)) {
    throw new Error(`Invalid workflow plugin name: ${pluginName}`);
  }

  const relativePath = normalizeRelativeWorkflowPath(remainder.slice(slashIndex + 1), "plugin");
  // Consent alignment: the install preview and the update capability
  // comparison fingerprint TOP-LEVEL workflows/*.js only (mirroring the
  // runtime lister), so nested paths must not be executable either — an
  // attacker-controlled upstream could otherwise add a nested workflow the
  // consent surface never names and later direct workflow_run at it.
  if (relativePath.includes("/")) {
    throw new Error(
      `plugin:// workflow scripts must be top-level files in the plugin's workflows directory: ${relativePath}`
    );
  }
  return { pluginName, relativePath };
}

async function resolveWorkspaceFileWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  if (!input.projectTrusted) {
    throw new Error("Project trust is required to run workspace workflow scripts");
  }
  assertJavaScriptWorkflowPath(input.scriptPath);

  const resolvedPath = input.runtime.normalizePath(input.scriptPath, input.workspacePath);
  await ensureRuntimePathWithinWorkspace(
    input.runtime,
    input.workspacePath,
    resolvedPath,
    "Workflow script path"
  ).catch((error: unknown) => {
    throw new Error(
      `Workflow script path resolves outside the workspace: ${getErrorMessage(error)}`
    );
  });

  const stat = await input.runtime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, input.scriptPath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  const source = await readFileString(input.runtime, resolvedPath);
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: input.scriptPath,
    source,
    sourceKind: "workspace-file",
    resolvedPath,
  });
}

function parseSkillWorkflowScriptPath(scriptPath: string): {
  skillName: SkillName;
  relativePath: string;
} {
  const remainder = scriptPath.slice(SKILL_SCRIPT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    throw new Error("skill:// workflow script paths must include a relative .js file path");
  }

  const parsedName = SkillNameSchema.safeParse(remainder.slice(0, slashIndex));
  if (!parsedName.success) {
    throw new Error(`Invalid workflow skill name: ${parsedName.error.message}`);
  }

  const relativePath = normalizeRelativeWorkflowPath(remainder.slice(slashIndex + 1), "skill");
  return { skillName: parsedName.data, relativePath };
}

function normalizeRelativeWorkflowPath(filePath: string, scheme: "skill" | "plugin"): string {
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  const stripped = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  // On the normalized path, so `./~run.js` is refused like `~run.js`: the workflow lister
  // (workflowFiles.ts isResolvableWorkflowName) drops such names, and the two must agree (#6777).
  if (isAbsolutePathAny(filePath) || stripped.startsWith("~")) {
    throw new Error(`Invalid ${scheme} workflow path (must be relative): ${filePath}`);
  }
  if (stripped === "" || stripped === "." || stripped.endsWith("/")) {
    throw new Error(`${scheme}:// workflow script paths must include a relative .js file path`);
  }
  if (stripped === ".." || stripped.startsWith("../") || stripped.includes("/../")) {
    throw new Error(`Invalid ${scheme} workflow path (path traversal): ${filePath}`);
  }
  return stripped;
}

function assertJavaScriptWorkflowPath(scriptPath: string): void {
  if (!scriptPath.endsWith(".js")) {
    throw new Error(`Workflow script paths must point to a .js file: ${scriptPath}`);
  }
}

function assertRegularJavaScriptFile(isDirectory: boolean, scriptPath: string): void {
  assertJavaScriptWorkflowPath(scriptPath);
  if (isDirectory) {
    throw new Error(`Workflow script path must point to a regular JavaScript file: ${scriptPath}`);
  }
}

function buildResolvedScript(
  input: Omit<ResolvedWorkflowScript, "sourceHash">
): ResolvedWorkflowScript {
  assert(input.source.length > 0, "resolveWorkflowScript: workflow script source is empty");
  return {
    ...input,
    sourceHash: hashSource(input.source),
  };
}

function hashSource(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}
