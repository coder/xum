/**
 * Install methods: how Xum reads a staged repository as a managed plugin.
 *
 * - `agent-plugin`: the repository's plugin.json with `$schema` (or .codex-plugin/plugin.json).
 * - `claude-plugin`: its .claude-plugin/plugin.json.
 * - `cursor-plugin`: its .cursor-plugin/plugin.json.
 * - `skills`: SKILL.md folders only. Xum writes a plugin.json into the staged tree before the
 *   review, so the consent preview, receipts and updates treat it like any plugin.
 * - `claude-marketplace`: one entry of a Claude Code marketplace whose folder has no manifest.
 *   Xum writes a plugin.json from the entry (the Claude rule: the entry is the manifest).
 * - `cursor-marketplace`: one entry of a Cursor marketplace, for a preview only. The entry
 *   installs through its folder's own manifest; Xum writes none for it and refuses an entry
 *   whose folder has none.
 *
 * Which manifest methods are offered: each manifest file a repository has is one method
 * (the table in discovery.ts, in the fixed order), except that a root plugin.json with `$schema`
 * (a Xum-native package, which can load hooks.js and workflows/) is offered alone, so that no
 * choice can hide code the review never showed. A manifest that fails validation is not offered.
 * The install saves a manifest method in the registry row (`installMethod`), and an update keeps
 * it: it refuses a commit that no longer fits the saved method (chooseUpdateMethod).
 *
 * Xum never overwrites or shadows a root or Codex manifest: `skills` fits only without them. A
 * Claude or Cursor manifest does not block `skills`: the generated root plugin.json wins by
 * discovery order, which is the user's explicit choice.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import YAML from "yaml";

import { AGENT_PLUGIN_INSTALL_METHOD_LABELS } from "@/common/constants/agentPluginInstallMethods";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import { SkillNameSchema } from "@/common/orpc/schemas";
import {
  SavedInstallMethodSchema,
  type AgentPluginInstallMethod,
  type SavedInstallMethod,
} from "@/common/orpc/schemas/agentPlugins";
import {
  AGENT_PLUGIN_NAME_MAX_LENGTH,
  isValidAgentPluginName,
} from "@/common/utils/agentPluginName";
import { displayRepoUrl } from "@/common/utils/agentPluginSource";
import assert from "@/common/utils/assert";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { SKILL_FILENAME } from "@/node/services/tools/skillFileUtils";
import {
  AGENT_PLUGIN_MANIFEST_TABLE,
  CODEX_PLUGIN_MANIFEST_RELATIVE_PATH,
  MAX_PLUGIN_MANIFEST_BYTES,
  PLUGIN_MANIFEST_RELATIVE_PATH,
  ensurePluginPathContained,
  manifestFilesOf,
  isSchemaLessRootManifest,
  readPluginFileWithinRootCapped,
} from "./discovery";
import { normalizeClaudeManifest } from "./claudeManifest";
import {
  MARKETPLACE_RELATIVE_PATHS,
  entryAsManifest,
  entryDeclaresComponents,
  findMarketplaceEntry,
  parseClaudeMarketplace,
  resolveEntrySource,
  type ClaudeMarketplaceEntry,
  type MarketplaceFile,
} from "./claudeMarketplace";
import {
  AGENT_PLUGIN_SCHEMA_ID_1_0_0,
  MAX_SKILLS_ROOTS,
  inertGeneratedComponents,
  isPlainObject,
  readGeneratedFrom,
  type GeneratedFrom,
} from "./manifest";

/**
 * The priority skill folders of the pinned skills CLI, in its order (skills@1.7.4, src/skills.ts:
 * `prioritySearchDirs` = the repository root, `skills`, its `.curated`, `.experimental` and
 * `.system` folders, then `AGENT_PROJECT_SKILL_DIRS`). The root itself is walked one level deep
 * (findSkillsPackageRoots); these containers are walked MAX_CONTAINER_DEPTH levels deep. Keep this
 * a plain copy of the pinned version so a repository installs the same skills as Skills and with
 * the CLI. Not mirrored: plugin-manifest skill paths and the CLI's deep fallback search when these
 * folders hold no skill (Xum then offers no Skills install).
 */
const SKILL_CONTAINERS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".claude/skills",
  ".cline/skills",
  ".codebuddy/skills",
  ".codex/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".factory/skills",
  ".github/skills",
  ".goose/skills",
  ".grok/skills",
  ".iflow/skills",
  ".junie/skills",
  ".kilo/skills",
  ".kilocode/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".minimax/skills",
  ".mux/skills",
  ".neovate/skills",
  ".opencode/skills",
  ".openhands/skills",
  ".pi/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
] as const;

/** The CLI walks each container this deep: `c/<name>`, `c/<group>/<name>`, `c/<g>/<g>/<name>`. */
const MAX_CONTAINER_DEPTH = 3;
/** The CLI walks the repository root one level deep only: `<repo>/<name>/SKILL.md`. */
const ROOT_WALK_DEPTH = 1;

/** One `contributes.skills` entry of a generated manifest. */
export interface SkillsPackageRoot {
  /**
   * Root-relative and "/"-separated. "." is the repository root: one skill when the root holds
   * SKILL.md (`skills` empty), else the folder of the root's own skill folders.
   */
  root: string;
  /**
   * The skill folder names under `root`, sorted, or `[basename]` when `root` holds SKILL.md
   * itself. Empty for the root skill: it takes the plugin name (discovery's single-root rule).
   */
  skills: string[];
}

interface WalkContext {
  rootReal: string;
  /**
   * Real paths already walked, with the child depth of that walk: two containers (or a symlink)
   * can reach one folder. A folder reached again at a smaller depth (an explicit container such
   * as `skills/.curated` after the walk of `skills/`) is walked again for its deeper levels.
   */
  visited: Map<string, number>;
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
  depth: number,
  maxDepth: number
): Promise<void> {
  const seenDepth = ctx.visited.get(dirReal);
  if (seenDepth !== undefined && seenDepth <= depth) return;
  ctx.visited.set(dirReal, depth);
  const skills: string[] = [];
  const groups: Array<{ name: string; real: string }> = [];
  for (const name of await childNames(dirReal)) {
    // Symlinks are followed only while they stay inside the tree.
    const real = await containedDirectory(ctx.rootReal, path.join(dirReal, name));
    if (real === undefined) continue;
    if (await holdsSkillFile(ctx.rootReal, real)) {
      // As in the CLI (tryAddSkillAt): a SKILL.md that does not parse is no skill, and the
      // walk does not go below it.
      if ((await readSkillsCliName(ctx.rootReal, real)) !== undefined) skills.push(name);
    } else if (depth < maxDepth) groups.push({ name, real });
  }
  // A walk again from a smaller depth finds the same children: record them once.
  if (skills.length > 0 && seenDepth === undefined) ctx.roots.push({ root: relative, skills });
  for (const group of groups) {
    await walkSkillParent(ctx, `${relative}/${group.name}`, group.real, depth + 1, maxDepth);
  }
}

/**
 * The skills CLI identity of the skill in `dirReal` (skills@1.7.4 parseSkillMd): its frontmatter
 * `name`, when SKILL.md starts with YAML frontmatter that has a non-empty string `name` and
 * `description`. Undefined when the CLI would skip the file.
 */
export async function readSkillsCliName(
  rootReal: string,
  dirReal: string
): Promise<string | undefined> {
  try {
    const { content } = await readPluginFileWithinRootCapped({
      filePath: path.join(dirReal, SKILL_FILENAME),
      pluginRoot: rootReal,
      maxBytes: MAX_FILE_SIZE,
      label: SKILL_FILENAME,
    });
    // The CLI's frontmatter pattern (src/frontmatter.ts).
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
    if (match === null) return undefined;
    const data: unknown = YAML.parse(match[1] ?? "");
    if (!isPlainObject(data)) return undefined;
    const { name, description } = data;
    const valid =
      typeof name === "string" &&
      name !== "" &&
      typeof description === "string" &&
      description !== "";
    return valid ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The skills of a repository by the skills CLI rules, as `contributes.skills` entries (skill
 * PARENT folders, so 16 roots can hold many skills). A root SKILL.md makes the repository one
 * skill. Empty when no SKILL.md exists.
 */
export async function findSkillsPackageRoots(dir: string): Promise<SkillsPackageRoot[]> {
  const rootReal = await fsPromises.realpath(dir);
  const ctx: WalkContext = { rootReal, visited: new Map(), roots: [] };
  if (await holdsSkillFile(rootReal, rootReal)) {
    // The CLI returns the root skill alone only when its SKILL.md parses (parseSkillMd).
    if ((await readSkillsCliName(rootReal, rootReal)) !== undefined) {
      return [{ root: ".", skills: [] }];
    }
    // An invalid root SKILL.md: the CLI skips it and walks the folders below. Xum walks the
    // containers but not the root's own skill folders: discovery would read a declared "." that
    // holds SKILL.md as that one (invalid) skill.
    ctx.visited.set(rootReal, 0);
  } else {
    await walkSkillParent(ctx, ".", rootReal, 1, ROOT_WALK_DEPTH);
  }
  for (const container of SKILL_CONTAINERS) {
    const real = await containedDirectory(rootReal, path.join(rootReal, container));
    if (real === undefined) continue;
    const seenDepth = ctx.visited.get(real);
    if (seenDepth !== undefined && seenDepth <= 1) continue;
    if (seenDepth === undefined && (await holdsSkillFile(rootReal, real))) {
      // Discovery reads a declared path that holds SKILL.md as one skill, so the folders
      // below it are not skills either.
      ctx.visited.set(real, 0);
      if ((await readSkillsCliName(rootReal, real)) !== undefined) {
        ctx.roots.push({ root: container, skills: [path.posix.basename(container)] });
      }
      continue;
    }
    await walkSkillParent(ctx, container, real, 1, MAX_CONTAINER_DEPTH);
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
  /** Every method that fits, in order: the manifest methods, then skills. */
  methods: AgentPluginInstallMethod[];
  /** The skills CLI view of the tree (empty without SKILL.md), for the "Skills CLI" choice. */
  skillsRoots: SkillsPackageRoot[];
  /**
   * The root plugin.json is the package's own manifest (it has `$schema`, or discovery cannot
   * read it): only `agent-plugin` is offered, and a saved Claude or Cursor method gives way.
   */
  nativeRoot: boolean;
  /** The root plugin.json exists and has no `$schema`: it is never a method of its own. */
  schemaLessRoot: boolean;
}

/**
 * True when discovery reads the root plugin.json as schema-less, so it yields to the other
 * manifests. It uses discovery's own reader, which follows a symlink inside the tree and refuses
 * one that leaves it, so the method always names the manifest discovery loads. A refused or
 * unreadable file stays the own manifest: discovery then reports its error.
 */
async function rootManifestIsSchemaLess(stagedDir: string): Promise<boolean> {
  return isSchemaLessRootManifest(await fsPromises.realpath(stagedDir));
}

/** The manifest files of the table that exist in the tree (an entry of any kind counts). */
async function presentManifests(stagedDir: string): Promise<Set<string>> {
  const present = new Set<string>();
  for (const spec of AGENT_PLUGIN_MANIFEST_TABLE) {
    if (await entryExists(stagedDir, spec.relative)) present.add(spec.relative);
  }
  return present;
}

/**
 * The manifest methods of the files that exist, in the table's order (the fixed order, so the
 * first one is the method discovery loads). A schema-less root is never a method of its own
 * (discovery rejects it): it counts only as the sole manifest, so that its validation error
 * reaches the user.
 */
function manifestMethodKinds(present: Set<string>): SavedInstallMethod[] {
  const kinds: SavedInstallMethod[] = [];
  for (const spec of AGENT_PLUGIN_MANIFEST_TABLE) {
    if (spec.relative === PLUGIN_MANIFEST_RELATIVE_PATH) continue;
    if (present.has(spec.relative) && !kinds.includes(spec.method)) kinds.push(spec.method);
  }
  if (kinds.length === 0 && present.has(PLUGIN_MANIFEST_RELATIVE_PATH)) kinds.push("agent-plugin");
  return kinds;
}

async function detectManifests(dir: string): Promise<{
  present: Set<string>;
  rootEntry: boolean;
  nativeRoot: boolean;
  schemaLessRoot: boolean;
  kinds: SavedInstallMethod[];
}> {
  const present = await presentManifests(dir);
  const rootEntry = present.has(PLUGIN_MANIFEST_RELATIVE_PATH);
  const nativeRoot = rootEntry && !(await rootManifestIsSchemaLess(dir));
  return {
    present,
    rootEntry,
    nativeRoot,
    schemaLessRoot: rootEntry && !nativeRoot,
    kinds: nativeRoot ? ["agent-plugin"] : manifestMethodKinds(present),
  };
}

export async function detectManifestMethods(dir: string): Promise<SavedInstallMethod[]> {
  return (await detectManifests(dir)).kinds;
}

export async function detectInstallMethods(stagedDir: string): Promise<DetectedInstallMethods> {
  const { present, rootEntry, nativeRoot, schemaLessRoot, kinds } =
    await detectManifests(stagedDir);
  const skillsRoots = await findSkillsPackageRoots(stagedDir);
  const methods: AgentPluginInstallMethod[] = kinds.map((kind) => ({ kind }));
  // A root entry or a Codex manifest blocks the generated plugin.json (Xum never shadows them).
  const blocked = rootEntry || present.has(CODEX_PLUGIN_MANIFEST_RELATIVE_PATH);
  if (!nativeRoot && !blocked && skillsRoots.length > 0) methods.push({ kind: "skills" });
  return { methods, skillsRoots, nativeRoot, schemaLessRoot };
}

export interface RejectedInstallMethod {
  method: AgentPluginInstallMethod;
  problem: string;
}

export interface CheckedInstallMethods extends DetectedInstallMethods {
  rejected: RejectedInstallMethod[];
}

/** Which method a staged clone must use. */
export type InstallMethodRequest =
  /** Preview without a method: the first that fits. */
  | { mode: "first" }
  /** Preview with a method, and install: exactly this one. */
  | { mode: "exact"; method: AgentPluginInstallMethod }
  /**
   * Update. With a saved method (B3): that method, or a refusal when the commit does not fit it.
   * Without one: the repository's own manifest when it has one now, else the generator of the
   * installed plugin.json (`generatedFrom`), else a Claude manifest. A tree that only fits
   * `skills` does not update an install that Xum did not generate.
   */
  | {
      mode: "update";
      generatedFrom: GeneratedFrom | undefined;
      saved: SavedInstallMethod | undefined;
    };

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
    case "cursor-plugin":
    case "skills":
      return b.kind === a.kind;
    case "claude-marketplace":
    case "cursor-marketplace":
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
      return chooseUpdateMethod(methods, request.generatedFrom, request.saved);
  }
}

/**
 * See InstallMethodRequest's `update` mode. A saved method is the only candidate: when it does
 * not fit, nothing replaces it (undefined), because the update would change what the user chose.
 */
export function chooseUpdateMethod(
  methods: AgentPluginInstallMethod[],
  generated: GeneratedFrom | undefined,
  saved: SavedInstallMethod | undefined
): AgentPluginInstallMethod | undefined {
  if (saved !== undefined) return methods.find((method) => method.kind === saved);
  const own = methods.find((method) => method.kind === "agent-plugin");
  if (own !== undefined) return own;
  // A marketplace entry that now ships a Claude or Cursor manifest switches to it (the update
  // review covers every component); a generated skills install keeps its generator.
  const kinds: Array<AgentPluginInstallMethod["kind"]> =
    generated === undefined
      ? ["claude-plugin", "cursor-plugin"]
      : generated.kind === "claude-marketplace"
        ? ["claude-plugin", "cursor-plugin", generated.kind]
        : [generated.kind];
  return methods.find((method) => kinds.includes(method.kind));
}

/** The error when no method fits: it names every format Xum looked for. */
export function noInstallMethodMessage(subpath: string | undefined): string {
  const formats =
    "No plugin.json (or .codex-plugin/plugin.json, .claude-plugin/plugin.json or .cursor-plugin/plugin.json) and no SKILL.md files";
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
  // A Windows path (`C:\Users\me\repo`) separates with backslashes.
  const trimmed = url.replace(/[/\\]+$/, "").replace(/\.git$/, "");
  return trimmed.split(/[/\\:]/).pop() ?? trimmed;
}

/** The generated plugin name: the subpath's last folder, or the repository name. */
export function generatedPluginName(source: Pick<AgentPluginGitSource, "url" | "subpath">): string {
  return toPluginName(
    source.subpath !== undefined ? path.posix.basename(source.subpath) : repositoryName(source.url)
  );
}

/**
 * Skill names for the skills CLI's `--skill` (valid skill names only, no repeats). The CLI names
 * a skill by its SKILL.md frontmatter `name` (skills@1.7.4 parseSkillMd, filterSkills), so these
 * are the frontmatter names, also for a root SKILL.md (not the repository name). A name that is
 * not a valid skill name cannot be passed safely, so that skill is not offered. Two folders with
 * the same name are both left out, with a warning: `--skill` would install every copy under that
 * one name, so a later copy could replace the reviewed one.
 */
export async function skillsCliSkillNames(
  stagedDir: string,
  roots: SkillsPackageRoot[]
): Promise<{ names: string[]; warnings: string[] }> {
  const rootReal = await fsPromises.realpath(stagedDir);
  const names: string[] = [];
  // One folder can be listed twice (`skills/SKILL.md` is a root child and the `skills`
  // container), so each canonical folder counts once before the shared-name check below.
  const seen = new Set<string>();
  const add = async (dir: string): Promise<boolean> => {
    const name = await readSkillsCliName(rootReal, dir);
    if (name === undefined) return false;
    const real = await fsPromises.realpath(dir);
    if (!seen.has(real)) names.push(name);
    seen.add(real);
    return true;
  };
  for (const root of roots) {
    const rootDir = path.join(rootReal, root.root);
    // A root that holds SKILL.md is one skill (the repository root, or a container path).
    if (await add(rootDir)) continue;
    for (const skill of root.skills) await add(path.join(rootDir, skill));
  }
  const valid = names.filter((name) => SkillNameSchema.safeParse(name).success);
  const shared = new Set(valid.filter((name, index) => valid.indexOf(name) !== index));
  return {
    names: valid.filter((name) => !shared.has(name)),
    warnings: [...shared].map(
      (name) =>
        `Skills CLI: more than one skill folder has the SKILL.md name '${name}', so the Skills CLI choice leaves it out`
    ),
  };
}

/** A marketplace entry being previewed, installed or updated (claudeMarketplace.ts). */
export interface MarketplaceEntryContext {
  /** The marketplace file that lists the entry. */
  file: MarketplaceFile;
  entry: ClaudeMarketplaceEntry;
  /** The entry is a folder of the marketplace repository, so Xum can write its plugin.json. */
  relative: boolean;
  /** The entry source is the marketplace root: entry `skills` replace the default skills/. */
  rootSource: boolean;
}

/**
 * The method a registry row saves for `method`: the methods that read a folder's own manifest.
 * Generated methods keep their `generatedFrom` marker, and a marketplace entry installs through
 * its folder's manifest with nothing saved.
 */
export function savedMethodOf(method: AgentPluginInstallMethod): SavedInstallMethod | undefined {
  const saved = SavedInstallMethodSchema.safeParse(method.kind);
  return saved.success ? saved.data : undefined;
}

/** The methods that read a folder's own manifest, so Xum writes no plugin.json for them. */
export function isOwnManifestMethod(method: AgentPluginInstallMethod): boolean {
  return savedMethodOf(method) !== undefined;
}

/**
 * The methods of a marketplace entry's folder: its own manifest when it has one; else the entry
 * as the manifest, for a relative source only (an update must find the entry again in the same
 * repository); else Skills for a remote repository of SKILL.md files. A manifest plus entry
 * components is the Claude conflict for `strict: false`; with `strict` Xum uses only the
 * manifest and warns (Claude would merge them). A Cursor entry installs only through its own
 * manifest (Cursor plugin RFC, D23).
 */
export function entryInstallMethods(
  detected: AgentPluginInstallMethod[],
  ctx: MarketplaceEntryContext
): { methods: AgentPluginInstallMethod[]; warnings: string[] } {
  const name = ctx.entry.name;
  const own = detected.find(isOwnManifestMethod);
  if (own === undefined && ctx.file === "cursor") {
    throw new Error(
      `The Cursor marketplace entry '${name}' has no plugin manifest in its folder. Xum does not install it.`
    );
  }
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
  // In Claude Code the entry is this plugin's manifest. Xum does not generate one for another
  // repository (an update must find the entry again), so an entry that names components would
  // install a different component set as Skills: refuse it instead.
  if (entryDeclaresComponents(ctx.entry)) {
    throw new Error(
      `The marketplace entry '${name}' lists its own components, and the repository it points to has no plugin manifest. Xum does not install such an entry; install the repository as Skills instead.`
    );
  }
  const skills = detected.find((method) => method.kind === "skills");
  return { methods: skills !== undefined ? [skills] : [], warnings: [] };
}

/**
 * The context of a relative entry at an install or update commit: the entry named `entryName` in
 * the marketplace file `file` of that commit. Its source must still resolve to the folder of
 * `source` (a direct API install cannot pair one entry with another folder, and an update does
 * not follow an entry that moved).
 */
export function relativeEntryContext(
  marketplaceJson: string | undefined,
  entryName: string,
  source: Pick<AgentPluginGitSource, "url" | "subpath">,
  file: MarketplaceFile
): MarketplaceEntryContext {
  const relativePath = MARKETPLACE_RELATIVE_PATHS[file];
  if (marketplaceJson === undefined) {
    throw new Error(
      `The repository has no ${relativePath} at this commit, so Xum cannot read the entry '${entryName}'.`
    );
  }
  const marketplace = parseClaudeMarketplace(marketplaceJson, file);
  const entry = findMarketplaceEntry(marketplace, entryName);
  const resolved = resolveEntrySource(marketplace, source.url, entry);
  if (resolved.kind !== "relative" || resolved.subpath !== source.subpath) {
    throw new Error(
      `The marketplace entry '${entryName}' now points to another location. Uninstall it and install it again.`
    );
  }
  return { file, entry, relative: true, rootSource: resolved.subpath === undefined };
}

/** The error when a marketplace entry's folder fits no method. */
export function noEntryMethodMessage(
  entry: string,
  source: Pick<AgentPluginGitSource, "url" | "subpath">
): string {
  const where = `${displayRepoUrl(source.url)}${source.subpath !== undefined ? `/${source.subpath}` : ""}`;
  return `The marketplace entry '${entry}' points to ${where}, which has no plugin.json (or .codex-plugin/plugin.json, .claude-plugin/plugin.json or .cursor-plugin/plugin.json) and no SKILL.md files.`;
}

/** The methods that fit a staged tree, the one to use, and what the preview shows about them. */
export interface StagedMethodChoice {
  method: AgentPluginInstallMethod;
  methods: AgentPluginInstallMethod[];
  warnings: string[];
  skillsCliSkills: string[];
}

/**
 * An update that Xum will not apply because the commit no longer fits the install (B5). Nothing
 * is applied: the plugin stays on its commit and keeps tracking its branch.
 */
export class UpdateRefusedError extends Error {}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function savedMethodMisfit(
  saved: SavedInstallMethod,
  checked: CheckedInstallMethods,
  subpath: string | undefined
): string {
  const rejected = checked.rejected.find((entry) => entry.method.kind === saved);
  if (rejected !== undefined)
    return sentence(`${AGENT_PLUGIN_INSTALL_METHOD_LABELS[saved]}: ${rejected.problem}`);
  const files = manifestFilesOf(saved, subpath);
  if (saved === "agent-plugin" && checked.schemaLessRoot) {
    // The commit lost the root's `$schema` and has no Codex manifest to fall back to.
    return `${files[0]} has no $schema in this commit, and ${files[1]} is gone.`;
  }
  if (checked.nativeRoot) {
    return `This commit has a plugin.json with $schema (a Xum-native package), which takes precedence over ${files.join(" and ")}.`;
  }
  return files.length === 1
    ? `${files[0]} is gone in this commit.`
    : `Neither ${files.join(" nor ")} is in this commit.`;
}

function updateRefusal(reason: string, methods: AgentPluginInstallMethod[]): UpdateRefusedError {
  if (methods.length === 0) {
    return new UpdateRefusedError(`${reason} No install method fits this commit.`);
  }
  const fits = methods.map(methodLabel).join(", ");
  return new UpdateRefusedError(
    `${reason} Methods that fit this commit: ${fits}. To switch, uninstall the plugin and install it again.`
  );
}

function hasProblem(checked: CheckedInstallMethods, method: AgentPluginInstallMethod): boolean {
  return checked.rejected.some((entry) => sameInstallMethod(entry.method, method));
}

/**
 * The methods a request chooses among. A preview without a method and an update with a saved one
 * choose among the methods that validate. A method asked for by name, and an update without a
 * saved method, choose among the detected ones: a manifest that fails validation then says why,
 * as it always has.
 */
function candidateMethods(
  checked: CheckedInstallMethods,
  fitting: AgentPluginInstallMethod[],
  request: InstallMethodRequest
): AgentPluginInstallMethod[] {
  switch (request.mode) {
    case "first":
      return fitting;
    case "update":
      return request.saved !== undefined ? fitting : checked.methods;
    case "exact": {
      const detected = checked.methods.some((method) => sameInstallMethod(method, request.method));
      return detected ? checked.methods : fitting;
    }
  }
}

function noMethodError(
  checked: CheckedInstallMethods,
  fitting: AgentPluginInstallMethod[],
  request: InstallMethodRequest,
  subpath: string | undefined
): Error {
  const saved = request.mode === "update" ? request.saved : undefined;
  if (saved !== undefined)
    return updateRefusal(savedMethodMisfit(saved, checked, subpath), fitting);
  if (request.mode === "update" && checked.methods.length > 0) {
    // The installed plugin.json is the repository's own, or a Claude one: Xum does not turn it
    // into a generated skills install on update (InstallMethodRequest).
    return updateRefusal(
      "The repository no longer has the manifest this plugin was installed from.",
      fitting
    );
  }
  if (checked.rejected.length > 0) return new Error(checked.rejected[0].problem);
  return new Error(noInstallMethodMessage(subpath));
}

/**
 * Choose the method of a staged tree (`marketplace`: the tree is that entry's folder). Throws
 * the message that names every format Xum looked for when none fits, the problem of a method that
 * failed validation when it is the one asked for, and an UpdateRefusedError when an update does
 * not fit the install.
 */
export async function chooseStagedMethod(
  stagedDir: string,
  checked: CheckedInstallMethods,
  request: InstallMethodRequest,
  source: Pick<AgentPluginGitSource, "url" | "subpath">,
  marketplace: MarketplaceEntryContext | undefined
): Promise<StagedMethodChoice> {
  if (marketplace !== undefined) {
    const { methods, warnings } = entryInstallMethods(checked.methods, marketplace);
    const method = chooseInstallMethod(methods, request);
    if (method === undefined) throw new Error(noEntryMethodMessage(marketplace.entry.name, source));
    // A marketplace entry is one plugin: the Skills CLI choice is for a whole repository.
    return { method, methods, warnings, skillsCliSkills: [] };
  }
  const fitting = checked.methods.filter((method) => !hasProblem(checked, method));
  const method = chooseInstallMethod(candidateMethods(checked, fitting, request), request);
  if (method === undefined) throw noMethodError(checked, fitting, request, source.subpath);
  const problem = checked.rejected.find((entry) =>
    sameInstallMethod(entry.method, method)
  )?.problem;
  if (problem !== undefined) throw new Error(problem);
  const cli = await skillsCliSkillNames(stagedDir, checked.skillsRoots);
  return {
    method,
    methods: fitting,
    warnings: [
      ...checked.rejected.map((entry) => `${methodLabel(entry.method)}: ${entry.problem}`),
      ...cli.warnings,
    ],
    skillsCliSkills: cli.names,
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
  // An entry name can hold what a plugin name cannot (`_`, capitals): the plugin takes the
  // nearest valid name, and the marker keeps the entry name for updates.
  raw.name = toPluginName(ctx.entry.name);
  const normalized = normalizeClaudeManifest(raw, {
    label: `the marketplace entry '${ctx.entry.name}'`,
    replaceDefaultSkills: ctx.rootSource,
  });
  assert(isPlainObject(normalized.manifest), "marketplaceManifest: the entry is an object");
  const { commands, agentFiles } = normalized.claude;
  const generatedFrom: GeneratedFrom = {
    kind: "claude-marketplace",
    entry: ctx.entry.name,
    ...(commands !== undefined ? { commands } : {}),
    ...(agentFiles !== undefined ? { agentFiles } : {}),
  };
  const contributes = isPlainObject(normalized.manifest.contributes)
    ? normalized.manifest.contributes
    : {};
  // Downgrade safety (inertGeneratedComponents): an older build reads this file as a plain
  // plugin.json, so every component the entry does not declare points at the inert path. This
  // build reads an inert agents or MCP path as "not declared" (claudeMarketplaceManifest), so
  // the Claude defaults (agents/, .mcp.json) still apply here.
  const inert = inertGeneratedComponents();
  return {
    manifest: {
      ...normalized.manifest,
      contributes: {
        ...contributes,
        hooks: inert.contributes.hooks,
        workflows: inert.contributes.workflows,
        agents: contributes.agents ?? inert.contributes.agents,
        mcp: contributes.mcp ?? inert.contributes.mcp,
      },
      extensions: { mux: { generatedFrom }, "com.openai": inert.openai },
    },
    warnings: [...warnings, ...normalized.warnings],
  };
}

/**
 * Write the plugin.json of a `skills` or `claude-marketplace` install into the staged tree and
 * return preview warnings. The file is part of the tree that the receipts hash and that install
 * promotes, and preview and install generate it from the same commit, so their consent digests
 * match. Callers run it only when the method fits (no root, Codex, Claude or Cursor manifest
 * for a marketplace entry; no root or Codex manifest for skills).
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
