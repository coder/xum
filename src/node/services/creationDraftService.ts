import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { Config } from "@/node/config";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { log } from "@/node/services/log";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import {
  CREATION_DRAFT_NAME_MAX_CHARS,
  DRAFT_ID_PATTERN,
  MAX_DRAFT_JSON_BYTES,
} from "@/constants/drafts";
import {
  CreationDraftSchema,
  type CreationDraft,
  type CreationDraftImportLegacyInput,
  type CreationDraftList,
  type CreationDraftSummary,
  type CreationDraftUpdateInput,
  type DraftAttachment,
} from "@/common/orpc/schemas/drafts";
import {
  draftTooLargeMessage,
  sanitizeDraft,
  stripStagedDraftAttachments,
  summarizeCreationDraft,
} from "@/common/utils/drafts";

/**
 * Creation drafts ("new workspace" composer): one record per draft,
 * `<xumRoot>/creation-drafts/<draftId>.json`. The project is a field, so changing it is an ordinary
 * update of the same record. The dir is outside the old `drafts/` root on purpose: an older build's
 * startup GC deletes unknown dirs there, and must never see these records after a downgrade.
 *
 * Deliberately absent (one active editor per draft is the contract): no revisions, live sync,
 * tombstones or conditional deletes. Concurrent saves of one field: last write wins; a late save
 * can recreate a deleted draft's file only through an explicit project (a create).
 */
const RECORDS_DIR_NAME = "creation-drafts";
const RECORD_FILE_VERSION = 1;
const OLD_DRAFTS_DIR_NAME = "drafts";
const OLD_LIST_FILE_NAME = "list.json";

/** A save the client must not retry: it needs corrected choices or a reload. */
export class CreationDraftRejectedError extends Error {}

/**
 * Record id of an old creation scope. From the FULL scope: old ids were only unique per project
 * (every project had a "default" draft), so the id alone would collide.
 */
export function creationDraftImportId(projectPath: string, legacyDraftId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([projectPath, legacyDraftId]));
  return `import-${digest.digest("hex").slice(0, 32)}`;
}

function emptyRecord(id: string, projectPath: string, createdAt: number): CreationDraft {
  return {
    id,
    projectPath,
    subProjectPath: null,
    createdAt,
    text: "",
    attachments: [],
    manualName: "",
    ai: {},
    intent: {},
    auto: {},
    execution: null,
  };
}

interface ImportedContent {
  text?: string;
  attachments?: DraftAttachment[];
  manualName?: string;
}

/** What an old field adds to the record: nothing, a fill of the empty field, or null (differs). */
type ImportFill = Partial<CreationDraft> | null;

function importBody(
  current: CreationDraft,
  text: string,
  attachments: CreationDraft["attachments"]
): ImportFill {
  if (text.length === 0 && attachments.length === 0) return {};
  if (current.text.length === 0 && current.attachments.length === 0) return { text, attachments };
  return JSON.stringify([current.text, current.attachments]) === JSON.stringify([text, attachments])
    ? {}
    : null;
}

function importName(current: CreationDraft, manualName: string): ImportFill {
  if (manualName.length === 0 || current.manualName === manualName) return {};
  return current.manualName.length === 0 ? { manualName } : null;
}

/**
 * Fill the empty content of `current` from an old draft. Null when a filled field holds something
 * else: the newer record wins and the old data is kept (never merged over, never dropped).
 */
function mergeImported(current: CreationDraft, incoming: ImportedContent): CreationDraft | null {
  // Staged attachments are worktree paths (a creation draft has none).
  const attachments = stripStagedDraftAttachments(incoming.attachments ?? []);
  const body = importBody(current, incoming.text ?? "", attachments);
  const name = importName(
    current,
    incoming.manualName?.slice(0, CREATION_DRAFT_NAME_MAX_CHARS) ?? ""
  );
  if (body === null || name === null) return null;
  return Object.keys({ ...body, ...name }).length > 0 ? { ...current, ...body, ...name } : current;
}

/** The manual name an old body stored (a generated name is a preview: discarded). */
function oldManualName(nameState: unknown): string | undefined {
  const state = nameState as { autoGenerate?: unknown; manualName?: unknown } | null | undefined;
  return state?.autoGenerate === false && typeof state.manualName === "string"
    ? state.manualName
    : undefined;
}

interface OldDraft {
  projectPath: string;
  draftId: string;
  subProjectPath: string | null;
  createdAt: number;
  content: ImportedContent;
  bodyFile: string | null;
  listed: boolean;
}

/** Old drafts are keyed by their full old scope: ids repeat across projects. */
function oldDraftKey(projectPath: unknown, draftId: unknown): string {
  return JSON.stringify([projectPath, draftId]);
}

/** The old list's valid rows (each also a listed draft without a body: an empty draft). */
function oldListedDrafts(listEntries: unknown[]): Map<string, OldDraft> {
  const drafts = new Map<string, OldDraft>();
  for (const entry of listEntries) {
    const row = entry as Partial<Record<string, unknown>>;
    const { projectPath, draftId } = row;
    if (typeof projectPath !== "string" || typeof draftId !== "string") continue;
    if (!DRAFT_ID_PATTERN.test(draftId)) continue;
    drafts.set(oldDraftKey(projectPath, draftId), {
      projectPath,
      draftId,
      subProjectPath: typeof row.subProjectPath === "string" ? row.subProjectPath : null,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
      content: {},
      bodyFile: null,
      listed: true,
    });
  }
  return drafts;
}

/** The old scope a body file holds; null for anything that is not a creation draft body. */
function oldBodyScope(
  body: Record<string, unknown> | null,
  fileName: string
): { projectPath: string; draftId: string } | null {
  const projectPath = body?.projectPath;
  const draftId = body?.draftId;
  if (typeof projectPath !== "string" || typeof draftId !== "string") return null;
  return `${draftId}.json` === fileName && DRAFT_ID_PATTERN.test(draftId)
    ? { projectPath, draftId }
    : null;
}

async function readOldBody(
  drafts: Map<string, OldDraft>,
  filePath: string,
  fileName: string
): Promise<void> {
  const body = (await readJsonFile(filePath)) as Record<string, unknown> | null;
  const scope = oldBodyScope(body, fileName);
  if (!scope) return;
  const key = oldDraftKey(scope.projectPath, scope.draftId);
  const draft = drafts.get(key) ?? {
    ...scope,
    subProjectPath: null,
    createdAt: (await fs.stat(filePath)).mtimeMs,
    content: {},
    bodyFile: null,
    listed: false,
  };
  const { draft: content } = sanitizeDraft(body);
  draft.content = { ...content, manualName: oldManualName(body?.nameState) };
  draft.bodyFile = filePath;
  drafts.set(key, draft);
}

export class CreationDraftService {
  private readonly root: string;
  private readonly oldRoot: string;
  private summaries: Map<string, CreationDraftSummary> | null = null;
  private loading: Promise<void> | null = null;
  private importProblems = 0;

  constructor(private readonly config: Config) {
    this.root = path.join(config.rootDir, RECORDS_DIR_NAME);
    this.oldRoot = path.join(config.rootDir, OLD_DRAFTS_DIR_NAME);
  }

  async list(): Promise<CreationDraftList> {
    const summaries = await this.ensureLoaded();
    return {
      drafts: [...summaries.values()],
      importError:
        this.importProblems > 0
          ? `${this.importProblems} older draft(s) were not imported: a newer draft differs, or the file could not be read. Their files are kept in ${this.oldRoot}.`
          : null,
    };
  }

  /** Null for a draft without a record (never saved, or deleted). */
  async get(draftId: string): Promise<CreationDraft | null> {
    await this.ensureLoaded();
    return this.readRecord(draftId);
  }

  async update(input: CreationDraftUpdateInput): Promise<CreationDraftSummary> {
    const { scope, ...patch } = input;
    const filePath = this.filePathFor(scope.draftId);
    await this.ensureLoaded();
    return withTargetMutationLock(this.config.rootDir, filePath, async () => {
      const current = await this.readRecord(scope.draftId);
      // The stored project is authoritative: only an explicit projectPath changes it (or, for a
      // missing record, creates one), so a stale window's text-only save keeps the new project.
      const base =
        current ??
        (patch.projectPath !== undefined
          ? emptyRecord(scope.draftId, patch.projectPath, Date.now())
          : null);
      if (base === null) {
        throw new CreationDraftRejectedError("This draft was deleted. Reload to start a new one.");
      }
      const next = { ...base, ...patch, id: scope.draftId };
      this.checkOwnership(current, next);
      const parsed = CreationDraftSchema.safeParse(next);
      if (!parsed.success) throw new CreationDraftRejectedError("Invalid creation draft.");
      await this.writeRecord(parsed.data);
      return summarizeCreationDraft(parsed.data);
    });
  }

  /** Both the stored and the target project must be registered, and own the execution choices. */
  private checkOwnership(current: CreationDraft | null, next: CreationDraft): void {
    if (current && !this.isOwned(current.projectPath)) {
      throw new CreationDraftRejectedError(`Project ${current.projectPath} was removed.`);
    }
    if (!this.isOwned(next.projectPath)) {
      throw new CreationDraftRejectedError(`Project ${next.projectPath} is not registered.`);
    }
    if (next.execution !== null && next.execution.projectPath !== next.projectPath) {
      throw new CreationDraftRejectedError(
        "These workspace choices were made for another project. Reload the draft."
      );
    }
  }

  async delete(draftId: string): Promise<void> {
    const filePath = this.filePathFor(draftId);
    await this.ensureLoaded();
    await withTargetMutationLock(this.config.rootDir, filePath, async () => {
      await fs.rm(filePath, { force: true });
      this.summaries?.delete(draftId);
    });
  }

  /** Delete the records of a removed project (by their project field). Returns their ids. */
  async deleteProjectDrafts(projectPath: string): Promise<string[]> {
    const summaries = await this.ensureLoaded();
    const ids = [...summaries.values()]
      .filter((summary) => summary.projectPath === projectPath)
      .map((summary) => summary.draftId);
    for (const id of ids) await this.delete(id);
    return ids;
  }

  /** One-way import of a renderer's pre-record draft text or typed name (localStorage). */
  async importLegacy(
    input: CreationDraftImportLegacyInput
  ): Promise<{ result: "imported" | "conflict" | "orphaned" }> {
    await this.ensureLoaded();
    if (!this.isOwned(input.projectPath)) return { result: "orphaned" };
    const id = creationDraftImportId(input.projectPath, input.legacyDraftId);
    return withTargetMutationLock(this.config.rootDir, this.filePathFor(id), async () => {
      const current = await this.readRecord(id);
      const merged = mergeImported(
        current ?? emptyRecord(id, input.projectPath, Date.now()),
        input
      );
      if (merged === null) return { result: "conflict" };
      if (current === null || merged !== current) await this.writeRecord(merged);
      return { result: "imported" };
    });
  }

  private ensureLoaded(): Promise<Map<string, CreationDraftSummary>> {
    this.loading ??= this.load().catch((error: unknown) => {
      // Retried by the next call instead of caching the failure.
      this.loading = null;
      throw error;
    });
    return this.loading.then(() => {
      if (this.summaries === null) throw new Error("Creation drafts failed to load");
      return this.summaries;
    });
  }

  private async load(): Promise<void> {
    this.importProblems = 0;
    try {
      await this.importOldDrafts();
    } catch (error) {
      // Old files go only after their record is saved, so they all stay; the records still load.
      this.importProblems++;
      log.warn("Could not import the old creation drafts", { error });
    }
    const summaries = new Map<string, CreationDraftSummary>();
    for (const name of await readDirNames(this.root)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const record = await this.readRecord(id);
        if (record) summaries.set(id, summarizeCreationDraft(record));
      } catch (error) {
        // One unreadable file must not hide the others; opening it fails the same way.
        log.warn(`Skipping unreadable creation draft ${name}`, { error });
      }
    }
    this.summaries = summaries;
  }

  private filePathFor(draftId: string): string {
    if (!DRAFT_ID_PATTERN.test(draftId)) {
      throw new CreationDraftRejectedError(`Invalid creation draft id ${JSON.stringify(draftId)}`);
    }
    return path.join(this.root, `${draftId}.json`);
  }

  private isOwned(projectPath: string): boolean {
    if (projectPath === SCRATCH_PROJECT_CONFIG_KEY) return true;
    // Strict: an unreadable config must never be mistaken for "not registered".
    return this.config.loadConfigOrDefault({ throwOnError: true }).projects.has(projectPath);
  }

  /**
   * Missing: null. Unparseable or malformed: self-heal (malformed attachments dropped, an
   * invalid record ignored, with a warning). Other read failures throw, so a save never replaces
   * a record it could not read.
   */
  private async readRecord(draftId: string): Promise<CreationDraft | null> {
    const filePath = this.filePathFor(draftId);
    const raw = await readJsonFile(filePath);
    if (raw === null) return null;
    const { attachments } = sanitizeDraft(raw).draft;
    const parsed = CreationDraftSchema.safeParse({
      ...(raw as object),
      attachments: stripStagedDraftAttachments(attachments),
    });
    if (!parsed.success || parsed.data.id !== draftId) {
      log.warn(`Ignoring malformed creation draft ${filePath}`);
      return null;
    }
    return parsed.data;
  }

  /** Atomic replace: a failed write leaves the last complete file. */
  private async writeRecord(record: CreationDraft): Promise<void> {
    const json = JSON.stringify({ version: RECORD_FILE_VERSION, ...record });
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > MAX_DRAFT_JSON_BYTES) throw new Error(draftTooLargeMessage(bytes));
    await fs.mkdir(this.root, { recursive: true });
    await writeFileAtomic(this.filePathFor(record.id), json);
    this.summaries?.set(record.id, summarizeCreationDraft(record));
  }

  /**
   * One-way import of the old project-keyed drafts (`drafts/<projectHash>/<draftId>.json` bodies,
   * `drafts/list.json` rows): listed, default, body-only and empty listed drafts. Each becomes a
   * record (creationDraftImportId) before its old files are removed; a newer record that differs
   * keeps the old files (reported by `list`). No dual writes: an older build no longer sees them.
   */
  private async importOldDrafts(): Promise<void> {
    const listFile = path.join(this.oldRoot, OLD_LIST_FILE_NAME);
    const listRaw = (await readJsonFile(listFile)) as { entries?: unknown } | null;
    const listEntries = Array.isArray(listRaw?.entries) ? (listRaw.entries as unknown[]) : [];
    const drafts = oldListedDrafts(listEntries);
    await this.readOldBodies(drafts);
    const imported = await this.saveOldDraftsAsRecords(drafts);
    const remaining = listEntries.filter((entry) => {
      const row = entry as { projectPath?: unknown; draftId?: unknown };
      return !imported.has(oldDraftKey(row.projectPath, row.draftId));
    });
    if (remaining.length !== listEntries.length) {
      await writeFileAtomic(listFile, JSON.stringify({ version: 1, entries: remaining }));
    }
  }

  /** Adds each old body file to `drafts` (a body without a list row is a body-only draft). */
  private async readOldBodies(drafts: Map<string, OldDraft>): Promise<void> {
    for (const dirName of await readDirNames(this.oldRoot)) {
      if (dirName === OLD_LIST_FILE_NAME) continue;
      const dir = path.join(this.oldRoot, dirName);
      for (const name of await readDirNames(dir)) {
        const filePath = path.join(dir, name);
        try {
          await readOldBody(drafts, filePath, name);
        } catch (error) {
          this.importProblems++;
          log.warn(`Could not read old creation draft ${filePath}`, { error });
        }
      }
    }
  }

  /** The keys of the old drafts that are now records. */
  private async saveOldDraftsAsRecords(drafts: Map<string, OldDraft>): Promise<Set<string>> {
    const imported = new Set<string>();
    for (const [key, draft] of drafts) {
      try {
        // Drafts of unregistered projects stay where they are (an older build's GC owns them).
        if (!this.isOwned(draft.projectPath)) continue;
        if (await this.importOldDraft(draft)) imported.add(key);
        else this.importProblems++;
      } catch (error) {
        this.importProblems++;
        log.warn(`Could not import old creation draft ${draft.draftId}`, { error });
      }
    }
    return imported;
  }

  /** False: a newer record differs (the old draft stays). */
  private async importOldDraft(draft: OldDraft): Promise<boolean> {
    const id = creationDraftImportId(draft.projectPath, draft.draftId);
    const current = await this.readRecord(id);
    const merged = mergeImported(
      current ?? {
        ...emptyRecord(id, draft.projectPath, draft.createdAt),
        subProjectPath: draft.subProjectPath,
      },
      draft.content
    );
    if (merged === null) return false;
    if (current === null || merged !== current) await this.writeRecord(merged);
    // Old files go only once the record is saved.
    if (draft.bodyFile) await fs.rm(draft.bodyFile, { force: true });
    return true;
  }
}

/** Parsed JSON; null when missing or unparseable (with a warning). Other errors throw. */
async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    log.warn(`Ignoring unparseable draft file ${filePath}`, { error });
    return null;
  }
}

/** Entry names of a directory; empty when it does not exist. */
async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return [];
    throw error;
  }
}
