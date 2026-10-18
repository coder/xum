/**
 * Approved copies of managed plugin skills and workflow scripts. A managed component loads only
 * while its consent fingerprint matches its record (componentConsent.ts). When the live file
 * stops matching (it changed after the user approved it), a skill or workflow script falls back
 * to the copy saved here at review time, so the user keeps the version they approved while the
 * new one waits for review. Xum stores one file per plugin instance:
 *
 *   <xumHome>/plugin-approved-copies/<instanceId>.json
 *     { version: 1, installedAt,
 *       skills: { <name>: { fingerprint, relativeDir, content } },
 *       workflows: { <consent key>: { fingerprint, source } } }
 *
 * - A copy serves only after the current build's load-time predicate passes on its content
 *   against the current record, so a tampered, stale or drifted copy fails closed (blocked).
 * - Known limit: the check uses this build's fingerprint, so a newer Xum that fingerprints
 *   unchanged files differently, or a component with no record at all, still needs a review.
 * - Bound to one installation by `installedAt`, like the hook trust file (pluginHookTrust.ts): a
 *   reinstall never inherits copies. Same file rules (pluginStateFiles.ts).
 * - Only the SKILL.md and the script source are copied. Other files of a skill directory stay
 *   live; consent does not cover them either.
 * - A live file that is missing or unreadable is not replaced by its copy: removal wins.
 */
import * as path from "node:path";
import { z } from "zod";
import type { AgentPluginImportedComponents } from "@/common/config/schemas/agentPluginInstalls";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { getOwn } from "@/common/utils/getOwn";
import { stableStringify } from "@/common/utils/stableStringify";
import {
  parseSkillMarkdown,
  skillConsentFrontmatter,
  type ParsedSkillMarkdown,
} from "@/node/services/agentSkills/parseSkillMarkdown";
import { log } from "@/node/services/log";
import {
  isImportedComponent,
  isPluginSkillConsented,
  isPluginWorkflowConsented,
  type ComponentConsent,
  type PluginSkillConsentGate,
} from "./componentConsent";
import { computePluginInstanceId } from "./mcpConfig";
import {
  isNewerVersionFor,
  parseStateJson,
  readBoundedStateFile,
  removeStateFile,
  writeStateFile,
} from "./pluginStateFiles";

const COPIES_DIR = "plugin-approved-copies";
const COPIES_STORE_LABEL = "Plugin approved-copies store";
const COPIES_FILE_LABEL = {
  file: "Plugin approved-copies file",
  failClosed: "serving no approved copies",
};
/** Far above a real plugin's skills and scripts; a larger file is malformed (and never written). */
export const MAX_APPROVED_COPIES_FILE_BYTES = 32 * 1024 * 1024;

const SkillCopySchema = z.object({
  fingerprint: z.string(),
  relativeDir: z.string(),
  content: z.string(),
});
const WorkflowCopySchema = z.object({ fingerprint: z.string(), source: z.string() });
/** Entries are checked one by one (validEntries), so one malformed entry drops only itself. */
const CopiesFileSchema = z.object({
  version: z.literal(1),
  installedAt: z.string(),
  skills: z.record(z.string(), z.unknown()),
  workflows: z.record(z.string(), z.unknown()),
});

export type ApprovedSkillCopy = z.infer<typeof SkillCopySchema>;
export type ApprovedWorkflowCopy = z.infer<typeof WorkflowCopySchema>;
export interface ApprovedCopies {
  /** By skill name. `relativeDir` is the skill directory relative to the plugin root. */
  skills: Record<string, ApprovedSkillCopy>;
  /** By workflow consent key (componentConsent `workflows`). */
  workflows: Record<string, ApprovedWorkflowCopy>;
}

/** Where one managed install keeps its copies (AgentPluginInfo.approvedCopies). */
export interface ApprovedCopiesSource {
  xumHome: string;
  /** The registry name: the instance identity is `<xumHome>/plugins/<name>`, as for hook trust. */
  pluginName: string;
  /** The registry entry's `installedAt`: copies of another install never apply. */
  installedAt: string;
}

export function noApprovedCopies(): ApprovedCopies {
  return { skills: {}, workflows: {} };
}

export function getApprovedCopiesPath(xumHome: string, instanceId: string): string {
  // instanceId is a hex digest (computePluginInstanceId); never a path segment from a plugin.
  if (!/^[0-9a-f]+$/.test(instanceId)) throw new Error(`Invalid plugin instance id: ${instanceId}`);
  return path.join(xumHome, COPIES_DIR, `${instanceId}.json`);
}

function copiesFileOf(source: ApprovedCopiesSource): string {
  const instanceId = computePluginInstanceId(
    path.join(source.xumHome, "plugins", source.pluginName)
  );
  return getApprovedCopiesPath(source.xumHome, instanceId);
}

/** This install's copies; none when the file is missing, malformed, oversized or for another install. */
export async function readApprovedCopies(source: ApprovedCopiesSource): Promise<ApprovedCopies> {
  const copies = await readCopiesFile(copiesFileOf(source), source.installedAt);
  return copies === "newer-version" ? noApprovedCopies() : copies;
}

/**
 * The copies of this install, none when missing, malformed or for another install, and
 * "newer-version" for a file a newer Xum wrote: reads use none of it, writes must keep it.
 */
async function readCopiesFile(
  file: string,
  installedAt: string
): Promise<ApprovedCopies | "newer-version"> {
  const raw = await readBoundedStateFile(file, MAX_APPROVED_COPIES_FILE_BYTES, COPIES_FILE_LABEL);
  if (raw === undefined) return noApprovedCopies();
  const json = parseStateJson(raw);
  const parsed = CopiesFileSchema.safeParse(json);
  if (parsed.success) {
    // Copies saved for an earlier install under this name never carry over.
    if (parsed.data.installedAt !== installedAt) return noApprovedCopies();
    return {
      skills: validEntries(parsed.data.skills, SkillCopySchema, file),
      workflows: validEntries(parsed.data.workflows, WorkflowCopySchema, file),
    };
  }
  if (isNewerVersionFor(json, installedAt)) return "newer-version";
  log.warn("Plugin approved-copies file is malformed; serving no approved copies", { file });
  return noApprovedCopies();
}

/** The well-formed entries; a malformed one is dropped alone (self-healing, see AGENTS.md). */
function validEntries<T>(
  entries: Record<string, unknown>,
  schema: z.ZodType<T>,
  file: string
): Record<string, T> {
  const valid = Object.entries(entries).flatMap(([key, value]) => {
    const entry = schema.safeParse(value);
    return entry.success ? [[key, entry.data] as const] : [];
  });
  const dropped = Object.keys(entries).length - valid.length;
  if (dropped > 0) {
    log.warn("Plugin approved-copies file has malformed entries; skipping them", {
      file,
      dropped,
    });
  }
  // fromEntries, never assignment: a key named `__proto__` must stay an own key.
  return Object.fromEntries(valid);
}

/**
 * The copies after a sweep. For each live, imported component with a record R: a live
 * fingerprint equal to R refreshes the copy from the live file; otherwise a previous copy whose
 * fingerprint is R is kept; otherwise there is none. Components gone from the live tree, not
 * imported, or without a record lose their copy (removal wins).
 */
export function nextApprovedCopies(args: {
  previous: ApprovedCopies;
  consent: ComponentConsent | undefined;
  selection: AgentPluginImportedComponents | undefined;
  live: ApprovedCopies;
}): ApprovedCopies {
  return {
    skills: nextEntries(args, "skills", args.previous.skills, args.live.skills),
    workflows: nextEntries(args, "workflows", args.previous.workflows, args.live.workflows),
  };
}

function nextEntries<T extends { fingerprint: string }>(
  args: Pick<Parameters<typeof nextApprovedCopies>[0], "consent" | "selection">,
  kind: keyof ApprovedCopies,
  previous: Record<string, T>,
  live: Record<string, T>
): Record<string, T> {
  const records = args.consent?.[kind] ?? {};
  const kept = Object.entries(live).flatMap(([name, current]) => {
    const record = getOwn(records, name);
    if (record === undefined || !isImportedComponent(args.selection, kind, name)) return [];
    if (current.fingerprint === record) return [[name, current] as const];
    const earlier = getOwn(previous, name);
    return earlier?.fingerprint === record ? [[name, earlier] as const] : [];
  });
  return Object.fromEntries(kept);
}

export interface ApprovedCopiesSweep {
  source: ApprovedCopiesSource;
  consent: ComponentConsent | undefined;
  selection: AgentPluginImportedComponents | undefined;
  live: ApprovedCopies;
}

/**
 * Save this install's copies after an approval (installService sweeps). Writes only when they
 * changed. A file a newer Xum wrote is never overwritten, and over the size bound nothing is
 * written (the old file stays, and each copy in it is still checked before it serves).
 */
export async function updateApprovedCopies(args: ApprovedCopiesSweep): Promise<void> {
  const write = await plannedWrite(args);
  if (write === undefined) return;
  await writeStateFile(
    path.join(args.source.xumHome, COPIES_DIR),
    write.file,
    write.text,
    COPIES_STORE_LABEL
  );
}

/** Whether a sweep would write: the startup sweep takes the mutation lock only then. */
export async function approvedCopiesOutdated(args: ApprovedCopiesSweep): Promise<boolean> {
  return (await plannedWrite(args)) !== undefined;
}

async function plannedWrite(
  args: ApprovedCopiesSweep
): Promise<{ file: string; text: string } | undefined> {
  const file = copiesFileOf(args.source);
  const previous = await readCopiesFile(file, args.source.installedAt);
  if (previous === "newer-version") return undefined;
  const next = nextApprovedCopies({ ...args, previous });
  if (stableStringify(next) === stableStringify(previous)) return undefined;
  const text = JSON.stringify({ version: 1, installedAt: args.source.installedAt, ...next });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_APPROVED_COPIES_FILE_BYTES) {
    log.warn("Plugin approved copies exceed the size bound; not saving them", { file, bytes });
    return undefined;
  }
  return { file, text };
}

/** Uninstall: a later install under the same name must not inherit copies. */
export async function removeApprovedCopies(xumHome: string, instanceId: string): Promise<void> {
  await removeStateFile(
    path.join(xumHome, COPIES_DIR),
    getApprovedCopiesPath(xumHome, instanceId),
    COPIES_STORE_LABEL
  );
}

/**
 * The skill gate of a discovered plugin. Only managed plugins carry consent records, so get one.
 * The copies file is read at most once per gate (one discovery scan), and only when a live skill
 * fails its check.
 */
export function pluginSkillConsentGate(plugin: {
  rootPath: string;
  componentConsent?: ComponentConsent;
  approvedCopies?: ApprovedCopiesSource;
}): PluginSkillConsentGate | undefined {
  if (plugin.componentConsent === undefined) return undefined;
  const source = plugin.approvedCopies;
  const gate: PluginSkillConsentGate = {
    pluginRoot: plugin.rootPath,
    consented: plugin.componentConsent.skills,
  };
  if (source !== undefined) {
    let loaded: Promise<ApprovedCopies> | undefined;
    gate.loadApprovedCopies = () => (loaded ??= readApprovedCopies(source));
  }
  return gate;
}

export interface ConsentedPluginSkill {
  parsed: ParsedSkillMarkdown;
  /** The live skill directory, or the plugin root plus the copy's recorded directory. */
  skillDir: string;
}

/**
 * The skill to serve: the live parse when it passes the consent gate, else the approved copy when
 * it verifies, else null (the skill does not load). Every reader of a plugin skill calls it.
 */
export async function consentedPluginSkill(
  gate: PluginSkillConsentGate | undefined,
  skillDir: string,
  parsed: ParsedSkillMarkdown
): Promise<ConsentedPluginSkill | null> {
  if (
    gate === undefined ||
    isPluginSkillConsented(gate, skillDir, skillConsentFrontmatter(parsed), parsed.body)
  ) {
    return { parsed, skillDir };
  }
  const name = parsed.frontmatter.name;
  const copy = getOwn((await gate.loadApprovedCopies?.())?.skills ?? {}, name);
  const verified = copy === undefined ? null : verifySkillCopy(gate, name, copy);
  if (verified !== null) log.debug("Serving the approved copy of a changed plugin skill", { name });
  return verified;
}

/** The copy's parse when the current build's predicate passes on it; null otherwise. */
function verifySkillCopy(
  gate: PluginSkillConsentGate,
  name: string,
  copy: ApprovedSkillCopy
): ConsentedPluginSkill | null {
  const directoryName = SkillNameSchema.safeParse(name);
  if (!directoryName.success) return null;
  let parsed: ParsedSkillMarkdown;
  try {
    parsed = parseSkillMarkdown({
      content: copy.content,
      byteSize: Buffer.byteLength(copy.content, "utf8"),
      directoryName: directoryName.data,
      allowDisplayName: true,
    });
  } catch (error) {
    log.debug("Approved plugin skill copy does not parse; not serving it", { name, error });
    return null;
  }
  const skillDir = path.join(gate.pluginRoot, copy.relativeDir);
  return isPluginSkillConsented(gate, skillDir, skillConsentFrontmatter(parsed), parsed.body)
    ? { parsed, skillDir }
    : null;
}

/** A managed plugin's workflow consent and copies (AgentPluginInfo or a resolved plugin skill). */
interface WorkflowConsentSource {
  componentConsent?: ComponentConsent;
  approvedCopies?: ApprovedCopiesSource;
}

/**
 * The workflow source to run: the live source when it passes the consent gate, else the approved
 * copy's source when it verifies, else undefined (the caller refuses the script).
 */
export async function consentedPluginWorkflowSource(
  plugin: WorkflowConsentSource,
  input: { file: string; source: string }
): Promise<string | undefined> {
  if (isPluginWorkflowConsented(plugin.componentConsent, input)) return input.source;
  // Review and the sweep skip an empty script as absent (installService collectWorkflowScripts),
  // so it gets no review row and loses its copy: it stays refused like a removed file.
  if (plugin.approvedCopies === undefined || input.source.length === 0) return undefined;
  const copy = getOwn((await readApprovedCopies(plugin.approvedCopies)).workflows, input.file);
  if (copy === undefined || !isWorkflowCopyVerified(plugin.componentConsent, input.file, copy)) {
    return undefined;
  }
  log.debug("Running the approved copy of a changed plugin workflow", { file: input.file });
  return copy.source;
}

function isWorkflowCopyVerified(
  consent: ComponentConsent | undefined,
  file: string,
  copy: ApprovedWorkflowCopy
): boolean {
  // isPluginWorkflowConsented passes without records (unmanaged); a copy never does.
  return consent !== undefined && isPluginWorkflowConsented(consent, { file, source: copy.source });
}

export interface VerifiedApprovedCopies {
  skills: ReadonlySet<string>;
  workflows: ReadonlySet<string>;
}

/**
 * The names whose copy verifies against `consent` (the review marks them: the approved version
 * stays in use until the user approves the new one).
 */
export function verifiedApprovedCopies(
  copies: ApprovedCopies,
  consent: ComponentConsent | undefined,
  pluginRoot: string
): VerifiedApprovedCopies {
  const gate = pluginSkillConsentGate({ rootPath: pluginRoot, componentConsent: consent });
  const skills = Object.entries(copies.skills).filter(
    ([name, copy]) => gate !== undefined && verifySkillCopy(gate, name, copy) !== null
  );
  const workflows = Object.entries(copies.workflows).filter(([file, copy]) =>
    isWorkflowCopyVerified(consent, file, copy)
  );
  return {
    skills: new Set(skills.map(([name]) => name)),
    workflows: new Set(workflows.map(([file]) => file)),
  };
}
