/**
 * Component consent fingerprints (#6498, #6629). A managed plugin's skill, MCP server, workflow
 * script, agent or slash command is bound to the fingerprint the user reviewed, not to its name: when a newer Xum parses
 * more of an installed package (a Codex dialect field, an extra skills root), the component's
 * fingerprint changes and it needs a new review instead of loading under an approved name.
 *
 * The same functions run at review time (install, component picker, update, re-review) and at
 * load time, so the two cannot drift. Accepted limitations: a bare command resolves through PATH
 * at launch, and the bytes of a `./` command and of other files in a skill directory are not
 * hashed (a local writer inside the plugin directory can change reviewed bytes either way).
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

import type {
  MCPHttpServerInfo,
  MCPServerInfo,
  MCPServerOAuthConfig,
  MCPServerPluginProvenance,
  MCPStdioServerInfo,
} from "@/common/types/mcp";
import { getOwn } from "@/common/utils/getOwn";
import { stableStringify } from "@/common/utils/stableStringify";

/** Bump when the fingerprint input changes: every record then needs a new review (fails closed). */
const CONSENT_SCHEME = 1;

/** "presence": only whether the field is set counts (a secret's location and value do not). */
type FieldRule = "include" | "exclude" | "presence";

/**
 * Every server field, by name. A new field is a compile error here until someone decides, so a
 * parser widening changes the fingerprint (fails closed) instead of slipping past it. Excluded:
 * fields the user or the UI owns (`disabled`, `toolAllowlist` only narrows). `plugin` has its own
 * table (PROVENANCE_FIELDS), applied in serverConsentSubject.
 */
const STDIO_FIELDS: Record<keyof MCPStdioServerInfo, FieldRule> = {
  transport: "include",
  command: "include",
  args: "include",
  env: "include",
  // Each named host variable reaches the server (Codex `env_vars`), so a new name needs review.
  forwardEnv: "include",
  cwd: "include",
  disabled: "exclude",
  toolAllowlist: "exclude",
  plugin: "exclude", // per field: PROVENANCE_FIELDS
  configLayer: "exclude",
};
const HTTP_FIELDS: Record<keyof MCPHttpServerInfo, FieldRule> = {
  transport: "include",
  url: "include",
  headers: "include",
  oauth: "include",
  managed: "include",
  disabled: "exclude",
  toolAllowlist: "exclude",
  plugin: "exclude", // per field: PROVENANCE_FIELDS
  configLayer: "exclude",
};
/**
 * Plugin provenance, field by field (#6630). Each one says which plugin and install the server
 * comes from, not what it launches, so none is in the fingerprint today. A new provenance field
 * is a compile error here: decide whether it changes launch behavior before it ships.
 */
const PROVENANCE_FIELDS: Record<keyof MCPServerPluginProvenance, FieldRule> = {
  pluginName: "exclude", // identity: the registry row, not the launch
  serverName: "exclude", // identity: the consent record's key
  sourceScope: "exclude", // where the plugin was found
  sourceLocation: "exclude", // display text for the install location
  componentPolicy: "exclude", // which registry row gates the server
  consentFingerprint: "exclude", // this function's own output
};
/**
 * `clientSecretSource` says where Xum rereads the secret, so its value is not behavior. Whether a
 * secret is sent at all is: a newer parser that starts reading one must ask for review again.
 */
const OAUTH_FIELDS: Record<keyof MCPServerOAuthConfig, FieldRule> = {
  clientId: "include",
  tokenEndpointAuthMethod: "include",
  discovery: "include",
  baseScopes: "include",
  defaultScopes: "include",
  resource: "include",
  clientSecretSource: "presence",
};

export interface ConsentPaths {
  /**
   * Plugin root spellings that mean "this plugin": the tree this load or review reads, plus the
   * final install path when a review reads a staged clone (a manifest can name it literally).
   */
  rootPaths: readonly string[];
  /** The instance's PLUGIN_DATA directory spellings, the same way. */
  dataPaths: readonly string[];
}

/**
 * Replace the plugin root and data directory with tags, so a staged clone and the installed tree
 * hash alike. Longer spellings go first, and `%` and `<` are escaped in the remaining text: a
 * literal `<root>/x` in a manifest must never hash like the plugin's own `x`.
 */
function normalizePaths(value: string, paths: ConsentPaths): string {
  const tokens = [
    ...paths.rootPaths.map((needle) => [needle, "<root>"] as const),
    ...paths.dataPaths.map((needle) => [needle, "<data>"] as const),
  ]
    .filter(([needle]) => needle.length > 0)
    .sort(([a], [b]) => b.length - a.length);
  const replace = (text: string, index: number): string => {
    if (index === tokens.length) return text.replaceAll("%", "%25").replaceAll("<", "%3C");
    const [needle, tag] = tokens[index];
    return text
      .split(needle)
      .map((part) => replace(part, index + 1))
      .join(tag);
  };
  return replace(value, 0);
}

function normalizeValue(value: unknown, paths: ConsentPaths): unknown {
  if (typeof value === "string") return normalizePaths(value, paths);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, paths));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry, paths)])
    );
  }
  return value;
}

function pick<T extends object>(
  value: T,
  rules: Record<keyof T, FieldRule>
): Partial<Record<keyof T, unknown>> {
  const picked: Partial<Record<keyof T, unknown>> = {};
  for (const key of Object.keys(rules) as Array<keyof T>) {
    if (value[key] === undefined || rules[key] === "exclude") continue;
    picked[key] = rules[key] === "presence" ? true : value[key];
  }
  return picked;
}

function digest(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/** Everything a plugin MCP server launches or connects with, paths normalized (the hashed part). */
function serverConsentSubject(info: MCPServerInfo, paths: ConsentPaths): unknown {
  const server =
    info.transport === "stdio"
      ? pick(info, STDIO_FIELDS)
      : {
          ...pick(info, HTTP_FIELDS),
          ...(info.oauth !== undefined ? { oauth: pick(info.oauth, OAUTH_FIELDS) } : {}),
        };
  return normalizeValue({ ...server, ...provenanceSubject(info) }, paths);
}

/**
 * The included provenance fields, under `plugin`, only when there are any. None is included
 * today, so the key stays absent and existing consent records keep matching.
 */
function provenanceSubject(info: MCPServerInfo): { plugin?: Partial<Record<string, unknown>> } {
  const picked = info.plugin === undefined ? {} : pick(info.plugin, PROVENANCE_FIELDS);
  return Object.keys(picked).length > 0 ? { plugin: picked } : {};
}

/** Fingerprint of everything a plugin MCP server launches or connects with. */
export function serverConsentFingerprint(info: MCPServerInfo, paths: ConsentPaths): string {
  return digest({
    scheme: CONSENT_SCHEME,
    kind: "mcpServer",
    server: serverConsentSubject(info, paths),
  });
}

/**
 * The fingerprinted fields as text, for a review whose summary looks unchanged (a header or
 * OAuth scope change). Secret sources are excluded from the subject, so this shows no secret.
 */
export function serverConsentDetail(info: MCPServerInfo, paths: ConsentPaths): string {
  return stableStringify(serverConsentSubject(info, paths));
}

interface SkillConsentInput {
  relativeDir: string;
  frontmatter: Readonly<Record<string, unknown>>;
}

function skillConsentSubject(args: SkillConsentInput): { dir: string; frontmatter: unknown } {
  const { paths } = args.frontmatter;
  return {
    dir: args.relativeDir.replaceAll("\\", "/"),
    frontmatter: {
      ...args.frontmatter,
      ...(Array.isArray(paths) ? { paths: [...(paths as unknown[])].map(String).sort() } : {}),
    },
  };
}

/**
 * Fingerprint of one skill: where it lives in the plugin (the #6494 `extra/foo` vs `skills/foo`
 * case) and its whole parsed frontmatter, so a new frontmatter field fails closed. The body is
 * not covered: no review shows it, and the update review has always treated a body edit as
 * capability-neutral. `paths` patterns are OR-ed, so their order does not count.
 */
export function skillConsentFingerprint(args: SkillConsentInput): string {
  return digest({ scheme: CONSENT_SCHEME, kind: "skill", ...skillConsentSubject(args) });
}

/** The fingerprinted skill fields as text, for a review whose advertisement looks unchanged. */
export function skillConsentDetail(args: SkillConsentInput): string {
  return stableStringify(skillConsentSubject(args));
}

interface WorkflowConsentInput {
  /** The script's file name in the plugin's workflows directory (top level only). */
  file: string;
  /** The script source exactly as the runtime reads it. */
  source: string;
}

/**
 * Fingerprint of one plugin workflow script (#6629): its file name and the digest of its source.
 * A script executes, so any byte change needs a new review.
 */
export function workflowConsentFingerprint(args: WorkflowConsentInput): string {
  return digest({
    scheme: CONSENT_SCHEME,
    kind: "workflow",
    file: args.file,
    sourceSha256: createHash("sha256").update(args.source).digest("hex"),
  });
}

/** The reviewed workflow as text: the whole script, which is what the record approves. */
export function workflowConsentDetail(args: WorkflowConsentInput): string {
  return `sha256 ${createHash("sha256").update(args.source).digest("hex")}\n\n${args.source}`;
}

interface AgentConsentInput {
  /** The agent ID the runtime loads the definition under (the lowercased file stem). */
  id: string;
  /** The frontmatter as the runtime parses it (plugin format mapping applied). */
  frontmatter: unknown;
}

/**
 * The fingerprinted agent fields (#6629). Keyed by ID, not file name: the runtime lists an agent
 * by its file name but loads it as `<id>.md`, which can differ in case. The body (the agent's
 * system prompt) is not covered yet, the same as a skill body: #6617 decides for both, and
 * covering it is one more field here (`bodySha256`).
 */
function agentConsentSubject(args: AgentConsentInput): { id: string; frontmatter: unknown } {
  return { id: args.id, frontmatter: args.frontmatter };
}

/** Fingerprint of one plugin agent: its ID and its whole parsed frontmatter. */
export function agentConsentFingerprint(args: AgentConsentInput): string {
  return digest({ scheme: CONSENT_SCHEME, kind: "agent", ...agentConsentSubject(args) });
}

/** The reviewed agent fields as text. */
export function agentConsentDetail(args: AgentConsentInput): string {
  return stableStringify(agentConsentSubject(args));
}

interface SlashCommandConsentInput {
  name: string;
  description?: string;
  /** The full text the command inserts on use. */
  expansion: string;
}

/** The fingerprinted slash command fields (#6629): the whole parsed contribution. */
function slashCommandConsentSubject(args: SlashCommandConsentInput): SlashCommandConsentInput {
  return {
    name: args.name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    expansion: args.expansion,
  };
}

/** Fingerprint of one plugin slash command: its name, description and expansion. */
export function slashCommandConsentFingerprint(args: SlashCommandConsentInput): string {
  return digest({
    scheme: CONSENT_SCHEME,
    kind: "slashCommand",
    ...slashCommandConsentSubject(args),
  });
}

/** The reviewed slash command fields as text. */
export function slashCommandConsentDetail(args: SlashCommandConsentInput): string {
  return stableStringify(slashCommandConsentSubject(args));
}

/** Reviewed fingerprints of one install, by component name (registry `componentConsent`). */
export interface ComponentConsent {
  skills: Record<string, string>;
  mcpServers: Record<string, string>;
  /** Workflow scripts by file name (#6629). Absent in records an older build wrote: none reviewed. */
  workflows: Record<string, string>;
  /** Agents by ID (#6629). Absent in records an older build wrote: none reviewed. */
  agents: Record<string, string>;
  /** Slash commands by name (#6629). Absent in records an older build wrote: none reviewed. */
  slashCommands: Record<string, string>;
}

/** Every consent kind. A kind the component picker does not select is reviewed all-or-nothing. */
export const CONSENT_KINDS = [
  "skills",
  "mcpServers",
  "workflows",
  "agents",
  "slashCommands",
] as const satisfies ReadonlyArray<keyof ComponentConsent>;

/** The consent of an install without records (every install from before #6498): nothing reviewed. */
export function noComponentConsent(): ComponentConsent {
  return { skills: {}, mcpServers: {}, workflows: {}, agents: {}, slashCommands: {} };
}

/** True only when the user reviewed exactly this fingerprint. No record (every older install) means no. */
export function isComponentConsented(
  consent: ComponentConsent | undefined,
  kind: keyof ComponentConsent,
  name: string,
  fingerprint: string
): boolean {
  return consent !== undefined && getOwn(consent[kind], name) === fingerprint;
}

/** The kinds the component picker selects; the other kinds are imported whole. */
export interface ComponentSelection {
  skills: string[];
  mcpServers: string[];
}

/** Whether an install imports a component: the picker selects skills and servers only. */
export function isImportedComponent(
  selection: ComponentSelection | undefined,
  kind: keyof ComponentConsent,
  name: string
): boolean {
  if (kind !== "skills" && kind !== "mcpServers") return true;
  return selection === undefined || selection[kind].includes(name);
}

/**
 * Consent records after the user saves `selection`, given the fingerprints the review showed
 * (`shown`). Without `previous` (install), every selected component was in the consent preview.
 * With `previous` (the component picker), only components newly added to the selection were
 * shown for consent: a component that stays selected keeps its old record or stays without one,
 * so a picker save never approves a component that changed since its review (#6498 review B1).
 * Deselected components lose their record.
 */
export function consentForSelection(args: {
  selection: ComponentSelection;
  shown: ComponentConsent;
  previous?: { selection: ComponentSelection; consent: ComponentConsent | undefined };
}): ComponentConsent {
  // Built from entries, never by assignment: a component named `__proto__` must stay an own key.
  const records = (kind: keyof ComponentSelection): Record<string, string> =>
    Object.fromEntries(
      args.selection[kind].flatMap((name) => {
        const kept = args.previous?.selection[kind].includes(name) === true;
        const fingerprint = kept
          ? args.previous?.consent !== undefined
            ? getOwn(args.previous.consent[kind], name)
            : undefined
          : getOwn(args.shown[kind], name);
        return fingerprint !== undefined ? [[name, fingerprint] as const] : [];
      })
    );
  return {
    skills: records("skills"),
    mcpServers: records("mcpServers"),
    workflows: unpickedRecords(args.shown, args.previous, "workflows"),
    agents: unpickedRecords(args.shown, args.previous, "agents"),
    slashCommands: unpickedRecords(args.shown, args.previous, "slashCommands"),
  };
}

/**
 * Records of a kind the picker does not select (#6629): an install records every one its preview
 * showed, and a picker save keeps the old records (it showed none of them).
 */
function unpickedRecords(
  shown: ComponentConsent,
  previous: { consent: ComponentConsent | undefined } | undefined,
  kind: Exclude<keyof ComponentConsent, keyof ComponentSelection>
): Record<string, string> {
  if (previous === undefined) return { ...shown[kind] };
  return { ...previous.consent?.[kind] };
}

/** A copy of every kind's records; none when there is no record (an install before #6498). */
function copyConsent(consent: ComponentConsent | undefined): ComponentConsent {
  // Spread, never assigned: a component named `__proto__` must stay an own key.
  return {
    skills: { ...consent?.skills },
    mcpServers: { ...consent?.mcpServers },
    workflows: { ...consent?.workflows },
    agents: { ...consent?.agents },
    slashCommands: { ...consent?.slashCommands },
  };
}

export interface ComponentRef {
  kind: keyof ComponentConsent;
  name: string;
  fingerprint: string;
}

/**
 * Consent records after a confirmed review. A component gets a record only when it is in both
 * lists with the same fingerprint: `current` (what the backend recomputed under the lock) and
 * `reviewed` (what the renderer showed). A component that changed after the review keeps its old
 * record, so it still needs a review (#6498 review S1). Every other record is kept.
 */
export function recordReviewedComponents(args: {
  previous: ComponentConsent | undefined;
  current: readonly ComponentRef[];
  reviewed: readonly ComponentRef[];
}): ComponentConsent {
  const next = copyConsent(args.previous);
  // One lookup per component: a plugin can have thousands of them.
  const refKey = (ref: ComponentRef) => JSON.stringify([ref.kind, ref.name, ref.fingerprint]);
  const shown = new Set(args.reviewed.map(refKey));
  for (const ref of args.current) {
    if (shown.has(refKey(ref))) next[ref.kind][ref.name] = ref.fingerprint;
  }
  return next;
}

/**
 * Imported components without a consent record for their current fingerprint. `selection` absent
 * means a legacy import-all entry. A selected name the tree no longer has does not count.
 */
export function countUnreviewed(args: {
  current: ComponentConsent;
  selection: ComponentSelection | undefined;
  consent: ComponentConsent | undefined;
}): number {
  let count = 0;
  for (const kind of CONSENT_KINDS) {
    for (const [name, fingerprint] of Object.entries(args.current[kind])) {
      const imported = isImportedComponent(args.selection, kind, name);
      if (imported && !isComponentConsented(args.consent, kind, name, fingerprint)) count++;
    }
  }
  return count;
}

/** The skill consent of one managed plugin (absent for unmanaged plugins, which have no install). */
export interface PluginSkillConsentGate {
  /** Canonical plugin root: skill directories are fingerprinted relative to it. */
  pluginRoot: string;
  consented: Readonly<Record<string, string>>;
}

/** The skill gate of a discovered plugin. Only managed plugins carry consent records, so get one. */
export function pluginSkillConsentGate(plugin: {
  rootPath: string;
  componentConsent?: ComponentConsent;
}): PluginSkillConsentGate | undefined {
  return plugin.componentConsent !== undefined
    ? { pluginRoot: plugin.rootPath, consented: plugin.componentConsent.skills }
    : undefined;
}

/**
 * The one load-time skill predicate (#6498): every reader of a plugin skill (the skill index,
 * agent_skill_read, agent_skill_list, `skill://` scripts) calls it with the frontmatter it parsed.
 * `skillDir` must be canonical, like `pluginRoot`, so the relative path matches the install review.
 */
export function isPluginSkillConsented(
  gate: PluginSkillConsentGate | undefined,
  skillDir: string,
  frontmatter: Readonly<Record<string, unknown>> & { name: string }
): boolean {
  if (gate === undefined) return true;
  const fingerprint = skillConsentFingerprint({
    relativeDir: path.relative(gate.pluginRoot, skillDir),
    frontmatter,
  });
  return getOwn(gate.consented, frontmatter.name) === fingerprint;
}

/**
 * The one load-time workflow predicate (#6629): the resolver calls it with the source it is about
 * to run, so a script changed after its review cannot run. Unmanaged plugins have no records and
 * always pass.
 */
export function isPluginWorkflowConsented(
  consent: ComponentConsent | undefined,
  args: WorkflowConsentInput
): boolean {
  if (consent === undefined) return true;
  return getOwn(consent.workflows, args.file) === workflowConsentFingerprint(args);
}

/**
 * The one load-time agent predicate (#6629): agent discovery and the definition read call it with
 * the frontmatter they parsed, so an agent changed after its review is neither listed nor loaded.
 * Unmanaged plugins have no records and always pass.
 */
export function isPluginAgentConsented(
  consent: ComponentConsent | undefined,
  args: AgentConsentInput
): boolean {
  if (consent === undefined) return true;
  return getOwn(consent.agents, args.id) === agentConsentFingerprint(args);
}

/**
 * The one load-time slash command predicate (#6629): the command registry calls it with the
 * contribution it is about to offer, so a command changed after its review is not offered.
 * Unmanaged plugins have no records and always pass.
 */
export function isPluginSlashCommandConsented(
  consent: ComponentConsent | undefined,
  args: SlashCommandConsentInput
): boolean {
  if (consent === undefined) return true;
  return getOwn(consent.slashCommands, args.name) === slashCommandConsentFingerprint(args);
}
