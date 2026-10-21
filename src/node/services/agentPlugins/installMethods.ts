/**
 * Install methods: how Xum reads a staged repository as a managed plugin.
 *
 * - `agent-plugin`: the repository's plugin.json (or .codex-plugin/plugin.json).
 * - `claude-plugin`: its .claude-plugin/plugin.json.
 * - `skills`: SKILL.md folders only. Xum writes a plugin.json into the staged tree before the
 *   review, so the consent preview, receipts and updates treat it like any plugin.
 * - `claude-marketplace`: one entry of a Claude Code marketplace whose folder has no manifest.
 *   Xum writes a plugin.json from the entry (the Claude rule: the entry is the manifest).
 *
 * Xum never overwrites or shadows a root or Codex manifest: `skills` fits only without them. A
 * Claude manifest does not block `skills`: the generated root plugin.json wins by discovery order,
 * which is the user's explicit choice.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { AGENT_PLUGIN_INSTALL_METHOD_LABELS } from "@/common/constants/agentPluginInstallMethods";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentPluginInstallMethod } from "@/common/orpc/schemas/agentPlugins";
import {
  AGENT_PLUGIN_NAME_MAX_LENGTH,
  isValidAgentPluginName,
} from "@/common/utils/agentPluginName";
import { displayRepoUrl } from "@/common/utils/agentPluginSource";
import assert from "@/common/utils/assert";
import { SKILL_FILENAME } from "@/node/services/tools/skillFileUtils";
import {
  CLAUDE_PLUGIN_MANIFEST_RELATIVE_PATH,
  CODEX_PLUGIN_MANIFEST_RELATIVE_PATH,
  MAX_PLUGIN_MANIFEST_BYTES,
  PLUGIN_MANIFEST_RELATIVE_PATH,
  ensurePluginPathContained,
  readPluginFileWithinRootCapped,
} from "./discovery";
import { normalizeClaudeManifest } from "./claudeManifest";
import {
  CLAUDE_MARKETPLACE_RELATIVE_PATH,
  entryAsManifest,
  entryDeclaresComponents,
  findMarketplaceEntry,
  parseClaudeMarketplace,
  resolveEntrySource,
  type ClaudeMarketplaceEntry,
} from "./claudeMarketplace";
import {
  AGENT_PLUGIN_SCHEMA_ID_1_0_0,
  MAX_SKILLS_ROOTS,
  isPlainObject,
  readGeneratedFrom,
  type GeneratedFrom,
} from "./manifest";

/**
 * The skill containers of the skills CLI (skills@1.7.4, docs "Skill Discovery"), in its order,
 * so a repository installs the same skills as Skills and with the CLI.
 */
const SKILL_CONTAINERS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".aider-desk/skills",
  ".agents/skills",
  "data/skills",
  ".autohand/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".devin/skills",
  "agent/skills",
  ".forge/skills",
  ".goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".vibe/skills",
  ".moxby/skills",
  ".mux/skills",
  ".openhands/skills",
  ".ona/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
] as const;

/** The CLI walks each container this deep: `c/<name>`, `c/<group>/<name>`, `c/<g>/<g>/<name>`. */
const MAX_CONTAINER_DEPTH = 3;

/** One `contributes.skills` entry of a generated manifest. */
export interface SkillsPackageRoot {
  /** Root-relative and "/"-separated. "." when the repository root holds SKILL.md. */
  root: string;
  /**
   * The skill folder names under `root`, sorted, or `[basename]` when `root` holds SKILL.md
   * itself. Empty for ".": that skill takes the plugin name (discovery's single-root rule).
   */
  skills: string[];
}

interface WalkContext {
  rootReal: string;
  /** Real paths already walked: two containers (or a symlink) can reach one folder. */
  visited: Set<string>;
  roots: SkillsPackageRoot[];
}

/** The real path of a directory inside the tree; undefined when missing, outside it or in .git. */
async function containedDirectory(
  rootReal: string,
  candidate: string
): Promise<string | undefined> {
  try {
    const real = await ensurePluginPathContained(rootReal, candidate);
    return (await fsPromises.stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

async function holdsSkillFile(rootReal: string, dirReal: string): Promise<boolean> {
  try {
    const real = await ensurePluginPathContained(rootReal, path.join(dirReal, SKILL_FILENAME));
    return (await fsPromises.stat(real)).isFile();
  } catch {
    return false;
  }
}

async function childNames(dirReal: string): Promise<string[]> {
  const entries = await fsPromises.readdir(dirReal, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Record `relative` as a skills root when a child holds SKILL.md, then walk the other children.
 * A folder with SKILL.md is a skill: Xum does not look below it (a shallower SKILL.md shadows
 * deeper ones, as in the CLI). `depth` is the level of the children (1 = `c/<name>`).
 */
async function walkSkillParent(
  ctx: WalkContext,
  relative: string,
  dirReal: string,
  depth: number
): Promise<void> {
  if (ctx.visited.has(dirReal)) return;
  ctx.visited.add(dirReal);
  const skills: string[] = [];
  const groups: Array<{ name: string; real: string }> = [];
  for (const name of await childNames(dirReal)) {
    // Symlinks are followed only while they stay inside the tree.
    const real = await containedDirectory(ctx.rootReal, path.join(dirReal, name));
    if (real === undefined) continue;
    if (await holdsSkillFile(ctx.rootReal, real)) skills.push(name);
    else if (depth < MAX_CONTAINER_DEPTH) groups.push({ name, real });
  }
  if (skills.length > 0) ctx.roots.push({ root: relative, skills });
  for (const group of groups) {
    await walkSkillParent(ctx, `${relative}/${group.name}`, group.real, depth + 1);
  }
}

/**
 * The skills of a repository by the skills CLI rules, as `contributes.skills` entries (skill
 * PARENT folders, so 16 roots can hold many skills). A root SKILL.md makes the repository one
 * skill. Empty when no SKILL.md exists.
 */
export async function findSkillsPackageRoots(dir: string): Promise<SkillsPackageRoot[]> {
  const rootReal = await fsPromises.realpath(dir);
  if (await holdsSkillFile(rootReal, rootReal)) return [{ root: ".", skills: [] }];
  const ctx: WalkContext = { rootReal, visited: new Set([rootReal]), roots: [] };
  for (const container of SKILL_CONTAINERS) {
    const real = await containedDirectory(rootReal, path.join(rootReal, container));
    if (real === undefined || ctx.visited.has(real)) continue;
    if (await holdsSkillFile(rootReal, real)) {
      // Discovery reads a declared path that holds SKILL.md as one skill, so the folders
      // below it are not skills either.
      ctx.visited.add(real);
      ctx.roots.push({ root: container, skills: [path.posix.basename(container)] });
      continue;
    }
    await walkSkillParent(ctx, container, real, 1);
  }
  assert(
    ctx.roots.every((root) => !path.isAbsolute(root.root) && !root.root.split("/").includes("..")),
    "findSkillsPackageRoots: roots must be relative paths inside the tree"
  );
  return ctx.roots;
}

/** True when anything exists at `relative`, even a dangling symlink or a folder. */
async function entryExists(dir: string, relative: string): Promise<boolean> {
  return (await fsPromises.lstat(path.join(dir, relative)).catch(() => null)) !== null;
}

export interface DetectedInstallMethods {
  /** Every method that fits, in order: agent-plugin, claude-plugin, skills. */
  methods: AgentPluginInstallMethod[];
  /** The skills CLI view of the tree (empty without SKILL.md), for the "Skills CLI" choice. */
  skillsRoots: SkillsPackageRoot[];
}

/** The install methods that fit a staged tree (see the module comment for the rules). */
export async function detectInstallMethods(stagedDir: string): Promise<DetectedInstallMethods> {
  // An entry of any kind counts: Xum never writes over a link or a folder named plugin.json.
  const ownManifest =
    (await entryExists(stagedDir, PLUGIN_MANIFEST_RELATIVE_PATH)) ||
    (await entryExists(stagedDir, CODEX_PLUGIN_MANIFEST_RELATIVE_PATH));
  const skillsRoots = await findSkillsPackageRoots(stagedDir);
  if (ownManifest) return { methods: [{ kind: "agent-plugin" }], skillsRoots };
  const methods: AgentPluginInstallMethod[] = [];
  if (await entryExists(stagedDir, CLAUDE_PLUGIN_MANIFEST_RELATIVE_PATH)) {
    methods.push({ kind: "claude-plugin" });
  }
  if (skillsRoots.length > 0) methods.push({ kind: "skills" });
  return { methods, skillsRoots };
}

/** Which method a staged clone must use. */
export type InstallMethodRequest =
  /** Preview without a method: the first that fits. */
  | { mode: "first" }
  /** Preview with a method, and install: exactly this one. */
  | { mode: "exact"; method: AgentPluginInstallMethod }
  /**
   * Update: the repository's own manifest when it has one now, else the generator of the
   * installed plugin.json (`generatedFrom`), else a Claude manifest. A tree that only fits
   * `skills` does not update an install that Xum did not generate.
   */
  | { mode: "update"; generatedFrom: GeneratedFrom | undefined };

/** The request of a preview or an install: the given method, or the first that fits. */
export function installMethodRequest(
  method: AgentPluginInstallMethod | null | undefined
): InstallMethodRequest {
  return method != null ? { mode: "exact", method } : { mode: "first" };
}

function sameInstallMethod(a: AgentPluginInstallMethod, b: AgentPluginInstallMethod): boolean {
  // Exhaustive: a method with fields (a marketplace entry) must compare them here.
  switch (a.kind) {
    case "agent-plugin":
    case "claude-plugin":
    case "skills":
      return b.kind === a.kind;
    case "claude-marketplace":
      return b.kind === a.kind && b.entry === a.entry;
  }
}

export function methodLabel(method: AgentPluginInstallMethod): string {
  return AGENT_PLUGIN_INSTALL_METHOD_LABELS[method.kind];
}

/** The method to use, or undefined when none fits (the caller names every format). */
export function chooseInstallMethod(
  methods: AgentPluginInstallMethod[],
  request: InstallMethodRequest
): AgentPluginInstallMethod | undefined {
  switch (request.mode) {
    case "first":
      return methods[0];
    case "exact": {
      if (methods.some((method) => sameInstallMethod(method, request.method))) {
        return request.method;
      }
      const fits = methods.map(methodLabel).join(", ");
      throw new Error(
        `This repository cannot be installed as ${methodLabel(request.method)}${fits.length > 0 ? `; it fits: ${fits}` : ""}. Preview it again.`
      );
    }
    case "update":
      return chooseUpdateMethod(methods, request.generatedFrom);
  }
}

/** See InstallMethodRequest's `update` mode. */
function chooseUpdateMethod(
  methods: AgentPluginInstallMethod[],
  generated: GeneratedFrom | undefined
): AgentPluginInstallMethod | undefined {
  const own = methods.find((method) => method.kind === "agent-plugin");
  if (own !== undefined) return own;
  // A marketplace entry that now ships a Claude manifest switches to it (the update review
  // covers every component); a generated skills install keeps its generator.
  const kinds: Array<AgentPluginInstallMethod["kind"]> =
    generated === undefined
      ? ["claude-plugin"]
      : generated.kind === "claude-marketplace"
        ? ["claude-plugin", generated.kind]
        : [generated.kind];
  return methods.find((method) => kinds.includes(method.kind));
}

/** The error when no method fits: it names every format Xum looked for. */
export function noInstallMethodMessage(subpath: string | undefined): string {
  const formats =
    "No plugin.json (or .codex-plugin/plugin.json or .claude-plugin/plugin.json) and no SKILL.md files";
  return subpath === undefined
    ? `${formats} found at the repository root. The repo is not a plugin — if the plugin lives in a subdirectory, install it as owner/repo/path/to/plugin.`
    : `${formats} found in '${subpath}'. The folder is not a plugin.`;
}

/**
 * A plugin name from free text: lowercase, every run of other characters becomes "-", and runs
 * of "-" or "." collapse, trimmed to the name grammar (isValidAgentPluginName). Throws when the
 * result is still invalid (for example a Windows device name or no letters at all).
 */
export function toPluginName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, AGENT_PLUGIN_NAME_MAX_LENGTH)
    .replace(/[^a-z0-9]+$/, "");
  if (!isValidAgentPluginName(name)) {
    throw new Error(
      `Xum cannot make a plugin name from '${raw}'. Install the skills from a folder with a name of letters and digits.`
    );
  }
  return name;
}

/** The last segment of a clone URL without `.git` ("skills" for github.com/anthropics/skills). */
function repositoryName(url: string): string {
  const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
  return trimmed.split(/[/:]/).pop() ?? trimmed;
}

/** The generated plugin name: the subpath's last folder, or the repository name. */
export function generatedPluginName(source: Pick<AgentPluginGitSource, "url" | "subpath">): string {
  return toPluginName(
    source.subpath !== undefined ? path.posix.basename(source.subpath) : repositoryName(source.url)
  );
}

/** Skill names for the skills CLI's `--skill` (valid skill names only, no repeats). */
export function skillsCliSkillNames(
  roots: SkillsPackageRoot[],
  source: Pick<AgentPluginGitSource, "url" | "subpath">
): string[] {
  const names = roots.flatMap((root) => {
    if (root.root !== ".") return root.skills;
    try {
      return [generatedPluginName(source)];
    } catch {
      return [];
    }
  });
  return [...new Set(names)].filter((name) => SkillNameSchema.safeParse(name).success);
}

/** A Claude marketplace entry being previewed, installed or updated (claudeMarketplace.ts). */
export interface MarketplaceEntryContext {
  entry: ClaudeMarketplaceEntry;
  /** The entry is a folder of the marketplace repository, so Xum can write its plugin.json. */
  relative: boolean;
  /** The entry source is the marketplace root: entry `skills` replace the default skills/. */
  rootSource: boolean;
}

/**
 * SECURITY AUDIT (downgrade): a build that predates `generatedFrom` reads a generated plugin.json
 * as an ordinary Agent Plugin and fills in the default component paths: hooks.js, agents/,
 * workflows/, mcp.json or .mcp.json (`contributes`), and hooks/hooks.json (Codex hooks, which an
 * `extensions["com.openai"].hooks` list replaces). So the generated manifest names each of them
 * explicitly: `contributes` paths point into `.git`, which no commit can create (git refuses to
 * track a `.git` path), so they never resolve, and an empty Codex hooks list turns the default
 * file off. Those builds then load only the skills roots the manifest lists. Builds before
 * `contributes` existed (#3872, the experimental flag) read only skills/ and mcp.json.
 */
export const INERT_COMPONENT_PATH = ".git/xum-generated-no-component";

/** The `contributes` and `extensions["com.openai"]` members that keep older builds inert. */
export function inertGeneratedComponents(): {
  contributes: Record<"hooks" | "agents" | "workflows" | "mcp", string>;
  openai: { hooks: [] };
} {
  return {
    contributes: {
      hooks: INERT_COMPONENT_PATH,
      agents: INERT_COMPONENT_PATH,
      workflows: INERT_COMPONENT_PATH,
      mcp: INERT_COMPONENT_PATH,
    },
    openai: { hooks: [] },
  };
}

/**
 * The methods of a marketplace entry's folder: its own manifest when it has one; else the entry
 * as the manifest, for a relative source only (an update must find the entry again in the same
 * repository); else Skills for a remote repository of SKILL.md files. A manifest plus entry
 * components is the Claude conflict for `strict: false`; with `strict` Xum uses only the
 * manifest and warns (Claude would merge them).
 */
export function entryInstallMethods(
  detected: AgentPluginInstallMethod[],
  ctx: MarketplaceEntryContext
): { methods: AgentPluginInstallMethod[]; warnings: string[] } {
  const name = ctx.entry.name;
  const own = detected.find(
    (method) => method.kind === "agent-plugin" || method.kind === "claude-plugin"
  );
  if (own !== undefined) {
    if (!entryDeclaresComponents(ctx.entry)) return { methods: [own], warnings: [] };
    if (!ctx.entry.strict) {
      throw new Error(
        `The marketplace entry '${name}' sets strict: false and declares components, and its folder has a plugin manifest too. Claude Code refuses these conflicting manifests, and so does Xum.`
      );
    }
    return {
      methods: [own],
      warnings: [
        `Xum reads only the plugin manifest of '${name}'; the components its marketplace entry adds do not load`,
      ],
    };
  }
  if (ctx.relative) {
    return { methods: [{ kind: "claude-marketplace", entry: name }], warnings: [] };
  }
  const skills = detected.find((method) => method.kind === "skills");
  return { methods: skills !== undefined ? [skills] : [], warnings: [] };
}

/**
 * The context of a relative entry at an install or update commit: the entry named `entryName` in
 * the marketplace.json of that commit. Its source must still resolve to the folder of `source`
 * (a direct API install cannot pair one entry with another folder, and an update does not follow
 * an entry that moved).
 */
export function relativeEntryContext(
  marketplaceJson: string | undefined,
  entryName: string,
  source: Pick<AgentPluginGitSource, "url" | "subpath">
): MarketplaceEntryContext {
  if (marketplaceJson === undefined) {
    throw new Error(
      `The repository has no ${CLAUDE_MARKETPLACE_RELATIVE_PATH} at this commit, so Xum cannot read the entry '${entryName}'.`
    );
  }
  const marketplace = parseClaudeMarketplace(marketplaceJson);
  const entry = findMarketplaceEntry(marketplace, entryName);
  const resolved = resolveEntrySource(marketplace, source.url, entry);
  if (resolved.kind !== "relative" || resolved.subpath !== source.subpath) {
    throw new Error(
      `The marketplace entry '${entryName}' now points to another location. Uninstall it and install it again.`
    );
  }
  return { entry, relative: true, rootSource: resolved.subpath === undefined };
}

/** The error when a marketplace entry's folder fits no method. */
export function noEntryMethodMessage(
  entry: string,
  source: Pick<AgentPluginGitSource, "url" | "subpath">
): string {
  const where = `${displayRepoUrl(source.url)}${source.subpath !== undefined ? `/${source.subpath}` : ""}`;
  return `The marketplace entry '${entry}' points to ${where}, which has no plugin.json (or .codex-plugin/plugin.json or .claude-plugin/plugin.json) and no SKILL.md files.`;
}

/** The methods that fit a staged tree, the one to use, and what the preview shows about them. */
export interface StagedMethodChoice {
  method: AgentPluginInstallMethod;
  methods: AgentPluginInstallMethod[];
  warnings: string[];
  skillsCliSkills: string[];
}

/**
 * Choose the method of a staged tree (`marketplace`: the tree is that entry's folder). Throws
 * the message that names every format Xum looked for when none fits.
 */
export function chooseStagedMethod(
  detected: DetectedInstallMethods,
  request: InstallMethodRequest,
  source: Pick<AgentPluginGitSource, "url" | "subpath">,
  marketplace: MarketplaceEntryContext | undefined
): StagedMethodChoice {
  if (marketplace !== undefined) {
    const { methods, warnings } = entryInstallMethods(detected.methods, marketplace);
    const method = chooseInstallMethod(methods, request);
    if (method === undefined) throw new Error(noEntryMethodMessage(marketplace.entry.name, source));
    // A marketplace entry is one plugin: the Skills CLI choice is for a whole repository.
    return { method, methods, warnings, skillsCliSkills: [] };
  }
  const method = chooseInstallMethod(detected.methods, request);
  if (method === undefined && request.mode === "update" && detected.methods.length > 0) {
    // The installed plugin.json is the repository's own, or a Claude one: Xum does not turn it
    // into a generated skills install on update (InstallMethodRequest).
    throw new Error(
      `The repository no longer has the manifest this plugin was installed from; it fits: ${detected.methods.map(methodLabel).join(", ")}. Uninstall the plugin and install it again to choose a method.`
    );
  }
  if (method === undefined) throw new Error(noInstallMethodMessage(source.subpath));
  return {
    method,
    methods: detected.methods,
    warnings: [],
    skillsCliSkills: skillsCliSkillNames(detected.skillsRoots, source),
  };
}

/** The methods for which Xum writes the plugin.json (writeGeneratedManifest). */
export function generatesManifest(
  method: AgentPluginInstallMethod
): method is Extract<AgentPluginInstallMethod, { kind: "skills" | "claude-marketplace" }> {
  return method.kind === "skills" || method.kind === "claude-marketplace";
}

/** The plugin.json of a `skills` install, and the warnings for skills past the roots cap. */
async function skillsManifest(
  stagedDir: string,
  source: Pick<AgentPluginGitSource, "url" | "subpath">
): Promise<{ manifest: Record<string, unknown>; warnings: string[] }> {
  const roots = await findSkillsPackageRoots(stagedDir);
  if (roots.length === 0) throw new Error(noInstallMethodMessage(source.subpath));
  // manifest.ts reads at most MAX_SKILLS_ROOTS roots; name the skills past the cap instead of
  // losing them without a word.
  const kept = roots.slice(0, MAX_SKILLS_ROOTS);
  const dropped = roots
    .slice(MAX_SKILLS_ROOTS)
    .flatMap((root) => root.skills.map((skill) => `${root.root}/${skill}`));
  const inert = inertGeneratedComponents();
  const manifest = {
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name: generatedPluginName(source),
    description: `Skills from ${displayRepoUrl(source.url)}${source.subpath !== undefined ? `/${source.subpath}` : ""}`,
    contributes: { skills: kept.map((root) => root.root), ...inert.contributes },
    extensions: {
      mux: { generatedFrom: { kind: "skills" } satisfies GeneratedFrom },
      "com.openai": inert.openai,
    },
  };
  const warnings =
    dropped.length > 0
      ? [
          `Xum reads at most ${MAX_SKILLS_ROOTS} skill folders; these skills do not install: ${dropped.join(", ")}`,
        ]
      : [];
  return { manifest, warnings };
}

/**
 * The plugin.json of a marketplace entry without one: the entry read as a Claude manifest
 * (normalizeClaudeManifest), with the marker last. Discovery gives the result the capabilities
 * of a Claude package (see discoverPluginAt).
 */
export function marketplaceManifest(ctx: MarketplaceEntryContext): {
  manifest: Record<string, unknown>;
  warnings: string[];
} {
  const { raw, warnings } = entryAsManifest(ctx.entry);
  const normalized = normalizeClaudeManifest(raw, {
    label: `the marketplace entry '${ctx.entry.name}'`,
    replaceDefaultSkills: ctx.rootSource,
  });
  assert(isPlainObject(normalized.manifest), "marketplaceManifest: the entry is an object");
  const commands = normalized.claude.commands;
  const generatedFrom: GeneratedFrom = {
    kind: "claude-marketplace",
    entry: ctx.entry.name,
    ...(commands !== undefined ? { commands } : {}),
  };
  return {
    manifest: { ...normalized.manifest, extensions: { mux: { generatedFrom } } },
    warnings: [...warnings, ...normalized.warnings],
  };
}

/**
 * Write the plugin.json of a `skills` or `claude-marketplace` install into the staged tree and
 * return preview warnings. The file is part of the tree that the receipts hash and that install
 * promotes, and preview and install generate it from the same commit, so their consent digests
 * match. Callers run it only when the method fits (no root, Codex or Claude manifest for a
 * marketplace entry; no root or Codex manifest for skills).
 */
export async function writeGeneratedManifest(
  stagedDir: string,
  method: Extract<AgentPluginInstallMethod, { kind: "skills" | "claude-marketplace" }>,
  source: Pick<AgentPluginGitSource, "url" | "subpath">,
  marketplace?: MarketplaceEntryContext
): Promise<string[]> {
  let generated: { manifest: Record<string, unknown>; warnings: string[] };
  if (method.kind === "skills") {
    generated = await skillsManifest(stagedDir, source);
  } else {
    assert(
      marketplace?.entry.name === method.entry,
      "writeGeneratedManifest: a marketplace method needs its entry"
    );
    generated = marketplaceManifest(marketplace);
  }
  // "wx": fail instead of replacing an entry. A dangling symlink at plugin.json would otherwise
  // redirect the write outside the staged tree.
  await fsPromises.writeFile(
    path.join(stagedDir, PLUGIN_MANIFEST_RELATIVE_PATH),
    `${JSON.stringify(generated.manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  return generated.warnings;
}

/**
 * The `generatedFrom` marker of an installed plugin.json, read through the capped contained
 * reader. Undefined when the file is missing, unreadable or has no known marker.
 */
export async function readInstalledGeneratedFrom(
  pluginRoot: string
): Promise<GeneratedFrom | undefined> {
  try {
    const rootReal = await fsPromises.realpath(pluginRoot);
    const { content } = await readPluginFileWithinRootCapped({
      filePath: path.join(rootReal, PLUGIN_MANIFEST_RELATIVE_PATH),
      pluginRoot: rootReal,
      maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
      label: PLUGIN_MANIFEST_RELATIVE_PATH,
    });
    const raw: unknown = JSON.parse(content);
    if (!isPlainObject(raw) || !isPlainObject(raw.extensions)) return undefined;
    return readGeneratedFrom({ extensions: raw.extensions });
  } catch {
    return undefined;
  }
}
