import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  TaskCheckoutPreparationSchema,
  type TaskCheckoutPreparation,
} from "@/common/schemas/project";
import type { Workspace } from "@/common/types/project";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Config } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { getErrorMessage } from "@/common/utils/errors";
import assert from "@/common/utils/assert";

/**
 * Preparation proof of a DEDICATED host-local agent-task checkout.
 *
 * A dedicated task checkout is forked and strictly sanitized (stale `plugin:` enables pruned)
 * BEFORE its row is first published; the same config write carries this proof. The proof binds
 * the row to the physical directory that was sanitized — root and git-admin device/inode, the
 * `.git` pointer and a producer nonce inside the git admin dir — plus the canonical runtime and
 * the published path. It is immutable: admissions never rotate it and nothing rebinds it. Every
 * execution/MCP consumer authorizes only a `ready` derivation; everything else refuses without
 * deleting or pruning anything (files stay inspectable; recovery is an ordinary fresh task).
 *
 * Shared tasks (isolation "none", or LocalRuntime conversation forks that share the project
 * directory) carry NO proof of their own: their authority is derived, on every authorization,
 * from live same-directory ancestry up to the nearest dedicated task (which must itself be
 * `ready`) or ordinary root workspace. Intermediates matter: an archived, missing or
 * directory-divergent hop breaks the context. Ordinary roots and off-host task rows are outside
 * the protocol.
 *
 * Limits (by design): in-place edits inside a validated directory are not detected (later
 * legitimate consent is allowed); a local writer with access to `.git` can forge the nonce — this
 * is an integrity check against accidental and older-build replacement, not a security boundary;
 * inode reuse alone is not relied upon (the nonce and the admin dir identity must match too, and
 * the nonce is claimed BEFORE the sanitizing prune for that reason). Concurrent access by builds
 * that do not implement this protocol is unsupported.
 */
export type { TaskCheckoutPreparation };

/** Nonce file inside the worktree's git admin dir (`<gitdir>/xum-preparation`): the materializationId. */
export const TASK_CHECKOUT_PREPARATION_NONCE_FILE = "xum-preparation";
const GIT_POINTER_MAX_BYTES = 4096;
const NONCE_MAX_BYTES = 64;
const MAX_SHARED_ANCESTRY_HOPS = 32;

export type TaskCheckoutKind = "root" | "offhost" | "shared" | "dedicated";

export type TaskCheckoutMismatchDimension =
  | "path"
  | "realpath"
  | "not-directory"
  | "root"
  | "git-special-file"
  | "gitdir-pointer"
  | "gitdir"
  | "nonce";

export type TaskCheckoutPreparationState =
  | { kind: "excluded-root" }
  | { kind: "excluded-offhost" }
  | { kind: "legacy" }
  | { kind: "unsupported"; detail: string }
  | { kind: "runtime-mismatch"; detail: string }
  | { kind: "missing" }
  | { kind: "mismatch"; dimension: TaskCheckoutMismatchDimension }
  | { kind: "unreadable"; detail: string }
  | { kind: "shared-broken"; detail: string }
  | { kind: "ready"; authority: TaskCheckoutAuthority };

/**
 * What a `ready` derivation authorized against. Plain JSON data: consumers thread it from the
 * asynchronous validation to the synchronous admission fence, which re-derives and compares.
 */
export interface TaskCheckoutAuthority {
  workspaceId: string;
  kind: "dedicated" | "shared";
  /** The anchor's proof identity ("" for an ordinary-root anchor). Convenience; also signed. */
  materializationId: string;
  authorizationRevision: string;
  /** Dedicated: the row itself. Shared: the dedicated task or ordinary root the context comes from. */
  anchorWorkspaceId: string;
  /** Dedicated: the proof's path. Shared: the execution directory shared with the anchor. */
  anchorPath: string;
  /** Shared: every intermediate shared row walked (child → parent order); dedicated: empty. */
  ancestry: readonly string[];
  /**
   * Canonical JSON of EVERY config input the derivation authorized against: the row's own
   * classification inputs (parent, path, canonical runtime, isolation, the raw proof value) and
   * the same inputs of every ancestry hop and of the anchor. `assertCurrentTaskCheckoutAuthority`
   * re-derives this from the current rows and compares it byte for byte, so a proof field, path,
   * runtime, isolation or parent that changed under an unchanged revision refuses. Attempt ids,
   * task status and consent content (override documents) are deliberately NOT part of it.
   */
  signature: string;
}

/** Physical identity of a checkout, captured (and claimed) BEFORE the prune under its locks. */
export interface CapturedTaskCheckoutIdentity {
  path: string;
  realpath: string;
  root: { dev: string; ino: string };
  gitdir: { pointer: string; dev: string; ino: string };
}

/** The claimed identity, re-verified after the prune together with the nonce it carries. */
export interface BoundTaskCheckoutIdentity extends CapturedTaskCheckoutIdentity {
  materializationId: string;
}

type ConfigReader = Pick<Config, "loadConfigOrDefault">;
type ProjectsConfig = ReturnType<Config["loadConfigOrDefault"]>;

const hex16 = () => randomBytes(8).toString("hex");
export const newMaterializationId = (): string => `mat_${hex16()}`;
const newAuthorizationRevision = (): string => `rev_${hex16()}`;

/** Sorted-key JSON (no `undefined` members): the stable serialization proofs and signatures use. */
function canonicalJson(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .filter((key) => (node as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, sort((node as Record<string, unknown>)[key])])
      );
    }
    return node;
  };
  return JSON.stringify(sort(value ?? null));
}

/** Sorted-key JSON of the row's runtime config: a full binding (type alone is not enough). */
export function canonicalRuntimeConfigJson(runtimeConfig: RuntimeConfig | undefined): string {
  return canonicalJson(runtimeConfig);
}

function isHostLocalRuntime(runtimeConfig: RuntimeConfig | undefined): boolean {
  return (
    runtimeConfig === undefined ||
    runtimeConfig.type === "local" ||
    runtimeConfig.type === "worktree"
  );
}

export function classifyTaskCheckoutKind(row: Workspace): TaskCheckoutKind {
  if (row.parentWorkspaceId == null) return "root";
  if (!isHostLocalRuntime(row.runtimeConfig)) return "offhost";
  // LocalRuntime forks never get a directory of their own (LocalRuntime.forkWorkspace shares the
  // project directory), so they are shared by construction.
  if (row.taskIsolation === "none" || row.runtimeConfig?.type === "local") return "shared";
  return "dedicated";
}

// ---------------------------------------------------------------------------------------------
// Bounded host reads
// ---------------------------------------------------------------------------------------------

/** Thrown by `readSmallRegularFile` when the path is not a small regular file. */
export class SpecialFileError extends Error {}

/**
 * Read a small REGULAR file without following symlinks. FIFO/device protection: a special file
 * at the path is refused by the lstat/fstat type checks and the O_NONBLOCK open, so a planted
 * FIFO cannot park a libuv thread on `open`/`read` (ordinary filesystem syscalls on a regular
 * file can still be slow — the callers' deadlines bound that, not this reader). Throws
 * `SpecialFileError` for a symlink/directory/FIFO/device or an oversized file, and the raw fs
 * error otherwise (ENOENT included). Shared with the structural-mutation guard's legacy `.git`
 * reader: one bounded primitive, no parallel readers.
 */
export async function readSmallRegularFile(filePath: string, maxBytes: number): Promise<string> {
  const before = await fsPromises.lstat(filePath);
  if (!before.isFile()) throw new SpecialFileError(`${filePath} is not a regular file`);
  if (before.size > maxBytes) throw new SpecialFileError(`${filePath} exceeds ${maxBytes} bytes`);
  const handle = await fsPromises.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new SpecialFileError(`${filePath} is not a regular file`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new SpecialFileError(`${filePath} exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

async function statIds(
  target: string
): Promise<{ dev: string; ino: string; isDirectory: boolean }> {
  const st = await fsPromises.stat(target, { bigint: true });
  return { dev: st.dev.toString(), ino: st.ino.toString(), isDirectory: st.isDirectory() };
}

/** The worktree's git admin dir from its `.git` FILE (`gitdir: <path>`), resolved absolute. */
async function readGitAdminDir(workspacePath: string): Promise<string> {
  const content = await readSmallRegularFile(
    path.join(workspacePath, ".git"),
    GIT_POINTER_MAX_BYTES
  );
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) throw new SpecialFileError(`${workspacePath}/.git does not point at a git admin dir`);
  return await fsPromises.realpath(path.resolve(workspacePath, match[1]));
}

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

// ---------------------------------------------------------------------------------------------
// Producer side: CLAIM before the prune, BIND after it (same held checkout locks), revalidate
// before publication
// ---------------------------------------------------------------------------------------------

/** Read-only capture of a checkout's identity and whether it already carries a nonce. */
async function captureIdentity(
  workspacePath: string
): Promise<{ identity: CapturedTaskCheckoutIdentity; nonce: string | null } | Error> {
  const realpath = await fsPromises.realpath(workspacePath);
  const root = await statIds(workspacePath);
  if (!root.isDirectory) return new Error(`${workspacePath} is not a directory`);
  const pointer = await readGitAdminDir(workspacePath);
  const admin = await statIds(pointer);
  if (!admin.isDirectory) return new Error(`${pointer} is not a directory`);
  let nonce: string | null = null;
  try {
    nonce = (
      await readSmallRegularFile(
        path.join(pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
        NONCE_MAX_BYTES
      )
    ).trim();
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return {
    identity: {
      path: workspacePath,
      realpath,
      root: { dev: root.dev, ino: root.ino },
      gitdir: { pointer, dev: admin.dev, ino: admin.ino },
    },
    nonce,
  };
}

function sameCheckoutIdentity(
  a: CapturedTaskCheckoutIdentity,
  b: CapturedTaskCheckoutIdentity
): boolean {
  return (
    a.path === b.path &&
    a.realpath === b.realpath &&
    a.root.dev === b.root.dev &&
    a.root.ino === b.root.ino &&
    a.gitdir.pointer === b.gitdir.pointer &&
    a.gitdir.dev === b.gitdir.dev &&
    a.gitdir.ino === b.gitdir.ino
  );
}

/**
 * Step 1 of preparation, BEFORE the prune and inside the prune's held checkout locks (its
 * `shouldPrune` callback): capture the physical identity of the fresh dedicated checkout that
 * is about to be sanitized and CLAIM it by writing the nonce (durably) into its git admin dir.
 * Refuses a checkout that already carries a nonce: a cooperating materializer never blesses or
 * reuses another generation.
 *
 * The claim is written before, not after, the prune on purpose: a directory removed and
 * re-created at the same path can get the SAME root and admin inodes back (observed on Linux),
 * so device/inode identity alone cannot tell the pruned directory from a replacement, while a
 * replacement never carries a nonce only this process knows. A claimed checkout whose
 * preparation then fails is retained unpublished and refused by every later claim.
 */
export async function claimTaskCheckoutIdentity(
  target: { workspacePath: string },
  materializationId: string
): Promise<CapturedTaskCheckoutIdentity | Error> {
  assert(target.workspacePath.length > 0, "claimTaskCheckoutIdentity: workspacePath required");
  assert(/^mat_[0-9a-f]{16}$/.test(materializationId), "claimTaskCheckoutIdentity: bad id");
  try {
    const captured = await captureIdentity(target.workspacePath);
    if (captured instanceof Error) return captured;
    const { identity, nonce } = captured;
    const nonceFile = path.join(identity.gitdir.pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE);
    if (nonce !== null) {
      return new Error(`${nonceFile} already exists: this checkout carries another preparation`);
    }
    const tmp = `${nonceFile}.tmp-${process.pid}-${hex16()}`;
    const handle = await fsPromises.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${materializationId}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsPromises.rename(tmp, nonceFile);
    // Directory fsync makes the rename durable. Windows exposes no directory handle to sync
    // (same policy as historyAppendProvenance / HistoryService: file fsync + rename only there).
    if (process.platform !== "win32") {
      const dir = await fsPromises.open(identity.gitdir.pointer, fsConstants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    return identity;
  } catch (error) {
    return error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

/**
 * Step 2, AFTER the prune's writes settled and still inside the same held checkout locks: the
 * directory must be exactly the one claimed before the prune — same path, realpath, root and
 * admin device/inode AND carrying this materialization's nonce — only then is the identity bound
 * (the proof is built from it). Anything else refuses: nothing is written here, so a replacement
 * is never stamped and never published.
 */
export async function bindTaskCheckoutIdentity(
  target: { workspacePath: string },
  materializationId: string,
  expected: CapturedTaskCheckoutIdentity
): Promise<BoundTaskCheckoutIdentity | Error> {
  assert(target.workspacePath.length > 0, "bindTaskCheckoutIdentity: workspacePath required");
  assert(/^mat_[0-9a-f]{16}$/.test(materializationId), "bindTaskCheckoutIdentity: bad id");
  assert(expected.path === target.workspacePath, "bindTaskCheckoutIdentity: expected other path");
  try {
    const captured = await captureIdentity(target.workspacePath);
    if (captured instanceof Error) return captured;
    if (!sameCheckoutIdentity(captured.identity, expected)) {
      return new Error(`${target.workspacePath} changed identity between claim and bind`);
    }
    if (captured.nonce !== materializationId) {
      return new Error(`${target.workspacePath} does not carry the claimed preparation nonce`);
    }
    return { ...expected, materializationId };
  } catch (error) {
    return error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

/** Read-only comparison of a proof (or bound identity) against the host filesystem. */
export async function revalidateTaskCheckoutIdentity(
  proof: Pick<
    TaskCheckoutPreparation,
    "path" | "realpath" | "root" | "gitdir" | "materializationId"
  >
): Promise<{ ok: true } | { ok: false; state: TaskCheckoutPreparationState }> {
  const mismatch = (dimension: TaskCheckoutMismatchDimension) =>
    ({ ok: false, state: { kind: "mismatch", dimension } }) as const;
  try {
    let root: Awaited<ReturnType<typeof statIds>>;
    try {
      root = await statIds(proof.path);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      // Root gone: `missing` only when the admin dir is gone too (a surviving admin dir means the
      // directory was moved or replaced, not merely deleted).
      try {
        await fsPromises.stat(proof.gitdir.pointer);
      } catch (adminError) {
        if (isEnoent(adminError)) return { ok: false, state: { kind: "missing" } };
        throw adminError;
      }
      return mismatch("root");
    }
    if (!root.isDirectory) return mismatch("not-directory");
    if ((await fsPromises.realpath(proof.path)) !== proof.realpath) return mismatch("realpath");
    if (root.dev !== proof.root.dev || root.ino !== proof.root.ino) return mismatch("root");
    let pointer: string;
    try {
      pointer = await readGitAdminDir(proof.path);
    } catch (error) {
      if (error instanceof SpecialFileError) return mismatch("git-special-file");
      if (isEnoent(error)) return mismatch("gitdir-pointer");
      throw error;
    }
    if (pointer !== proof.gitdir.pointer) return mismatch("gitdir-pointer");
    const admin = await statIds(pointer);
    if (!admin.isDirectory || admin.dev !== proof.gitdir.dev || admin.ino !== proof.gitdir.ino) {
      return mismatch("gitdir");
    }
    let nonce: string;
    try {
      nonce = await readSmallRegularFile(
        path.join(pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
        NONCE_MAX_BYTES
      );
    } catch (error) {
      if (error instanceof SpecialFileError || isEnoent(error)) return mismatch("nonce");
      throw error;
    }
    if (nonce.trim() !== proof.materializationId) return mismatch("nonce");
    return { ok: true };
  } catch (error) {
    return { ok: false, state: { kind: "unreadable", detail: getErrorMessage(error) } };
  }
}

export function buildTaskCheckoutPreparation(
  identity: BoundTaskCheckoutIdentity,
  runtimeConfig: RuntimeConfig | undefined
): TaskCheckoutPreparation {
  const proof: TaskCheckoutPreparation = {
    v: 1,
    materializationId: identity.materializationId,
    authorizationRevision: newAuthorizationRevision(),
    runtimeConfigJson: canonicalRuntimeConfigJson(runtimeConfig),
    path: identity.path,
    realpath: identity.realpath,
    root: identity.root,
    gitdir: identity.gitdir,
  };
  assert(TaskCheckoutPreparationSchema.safeParse(proof).success, "built proof must be well-formed");
  return proof;
}

// ---------------------------------------------------------------------------------------------
// Consumer side: lock-free derivation and the synchronous authority re-check
// ---------------------------------------------------------------------------------------------

/** The row's raw proof, classified. */
function readProof(
  row: Workspace
):
  | { kind: "absent" }
  | { kind: "unsupported"; detail: string }
  | { kind: "proof"; proof: TaskCheckoutPreparation } {
  const raw: unknown = row.taskCheckoutPreparation;
  if (raw === undefined) return { kind: "absent" };
  const parsed = TaskCheckoutPreparationSchema.safeParse(raw);
  if (!parsed.success)
    return { kind: "unsupported", detail: parsed.error.issues[0]?.message ?? "malformed" };
  return { kind: "proof", proof: parsed.data };
}

interface ConfigEntry {
  projectPath: string;
  workspace: Workspace;
}

/**
 * The directory a host-local row executes in. LocalRuntime always runs in the PROJECT directory
 * (LocalRuntime.getWorkspacePath ignores the persisted path, which is informational there); every
 * other runtime runs in the row's path.
 */
function executionDirectory(entry: ConfigEntry): string {
  return entry.workspace.runtimeConfig?.type === "local" ? entry.projectPath : entry.workspace.path;
}

/** The classification inputs of one row, as signed by an authority. */
function rowSignatureInputs(entry: ConfigEntry): Record<string, unknown> {
  const row = entry.workspace;
  return {
    id: row.id ?? null,
    projectPath: entry.projectPath,
    kind: classifyTaskCheckoutKind(row),
    parentWorkspaceId: row.parentWorkspaceId ?? null,
    path: row.path,
    runtimeConfigJson: canonicalRuntimeConfigJson(row.runtimeConfig),
    taskIsolation: row.taskIsolation ?? null,
    proof:
      row.taskCheckoutPreparation === undefined ? null : canonicalJson(row.taskCheckoutPreparation),
  };
}

/** Config-only part of the dedicated derivation (no filesystem): everything but physical identity. */
function deriveDedicatedRow(
  row: Workspace
):
  | { kind: "proof"; proof: TaskCheckoutPreparation }
  | Exclude<TaskCheckoutPreparationState, { kind: "ready" }> {
  const read = readProof(row);
  if (read.kind === "absent") return { kind: "legacy" };
  if (read.kind === "unsupported") return read;
  const { proof } = read;
  if (!isHostLocalRuntime(row.runtimeConfig)) {
    return { kind: "runtime-mismatch", detail: "proof present on a non-host-local runtime" };
  }
  if (proof.runtimeConfigJson !== canonicalRuntimeConfigJson(row.runtimeConfig)) {
    return { kind: "runtime-mismatch", detail: "row runtime config differs from the prepared one" };
  }
  if (row.path !== proof.path) return { kind: "mismatch", dimension: "path" };
  return { kind: "proof", proof };
}

/**
 * Pure (config-only) live same-directory ancestry walk of a shared row: child → parent while each
 * hop is a live shared row executing in the same directory, ending at the nearest dedicated task
 * or ordinary root.
 */
function walkSharedAncestry(
  snapshot: ProjectsConfig,
  entry: ConfigEntry
):
  | { ok: true; anchor: ConfigEntry; anchorKind: "dedicated" | "root"; hops: ConfigEntry[] }
  | { ok: false; detail: string } {
  const hops: ConfigEntry[] = [];
  const directory = executionDirectory(entry);
  const visited = new Set<string>([entry.workspace.id ?? ""]);
  let current = entry;
  for (let hop = 0; hop < MAX_SHARED_ANCESTRY_HOPS; hop++) {
    const parentId = current.workspace.parentWorkspaceId;
    if (parentId == null) {
      return { ok: false, detail: `${current.workspace.id ?? "?"} has no parent` };
    }
    if (visited.has(parentId)) return { ok: false, detail: `ancestry cycle at ${parentId}` };
    visited.add(parentId);
    const parentEntry = findWorkspaceEntry(snapshot, parentId);
    if (!parentEntry) return { ok: false, detail: `ancestor ${parentId} not found` };
    const parent = parentEntry.workspace;
    if (isWorkspaceArchived(parent.archivedAt, parent.unarchivedAt)) {
      return { ok: false, detail: `ancestor ${parentId} is archived` };
    }
    if (!isHostLocalRuntime(parent.runtimeConfig)) {
      return { ok: false, detail: `ancestor ${parentId} is not host-local` };
    }
    if (executionDirectory(parentEntry) !== directory) {
      return { ok: false, detail: `ancestor ${parentId} executes in a different directory` };
    }
    const kind = classifyTaskCheckoutKind(parent);
    if (kind === "root") {
      // A proof on an ordinary root is never an anchor (a proof-bearing row cannot become exempt
      // by losing its parent).
      if (parent.taskCheckoutPreparation !== undefined) {
        return { ok: false, detail: `root anchor ${parentId} carries a proof` };
      }
      return { ok: true, anchor: parentEntry, anchorKind: "root", hops };
    }
    if (kind === "dedicated") {
      return { ok: true, anchor: parentEntry, anchorKind: "dedicated", hops };
    }
    if (kind !== "shared") return { ok: false, detail: `ancestor ${parentId} is ${kind}` };
    if (parent.taskCheckoutPreparation !== undefined) {
      return { ok: false, detail: `shared ancestor ${parentId} carries a proof` };
    }
    hops.push(parentEntry);
    current = parentEntry;
  }
  return { ok: false, detail: "ancestry exceeds the supported depth" };
}

/**
 * The config-only derivation shared by the asynchronous validator and the synchronous authority
 * re-check: classification (a PRESENT proof is inspected before any root/off-host exemption — a
 * proof-bearing row cannot become exempt by changing its parent or runtime), the dedicated proof
 * checks that need no filesystem, the live same-path ancestry of shared rows, and the signature
 * over every input used. `anchorProof` is what the validator then revalidates physically.
 */
function deriveTaskCheckoutAuthorization(
  snapshot: ProjectsConfig,
  workspaceId: string
):
  | {
      kind: "derived";
      authority: TaskCheckoutAuthority;
      anchorProof: TaskCheckoutPreparation | null;
    }
  | Exclude<TaskCheckoutPreparationState, { kind: "ready" }> {
  const entry = findWorkspaceEntry(snapshot, workspaceId);
  // A missing row is a REFUSAL, never an exemption: only an existing parent-less row is a root.
  if (!entry) return { kind: "unreadable", detail: `workspace ${workspaceId} not found` };
  const row = entry.workspace;
  const proofPresent = row.taskCheckoutPreparation !== undefined;
  const kind = classifyTaskCheckoutKind(row);
  if (kind === "root") {
    return proofPresent
      ? { kind: "unsupported", detail: "proof present on an ordinary root row" }
      : { kind: "excluded-root" };
  }
  if (kind === "offhost") {
    return proofPresent
      ? { kind: "runtime-mismatch", detail: "proof present on a non-host-local runtime" }
      : { kind: "excluded-offhost" };
  }
  const sign = (hops: ConfigEntry[], anchor: ConfigEntry): string =>
    canonicalJson({
      v: 1,
      row: rowSignatureInputs(entry),
      ancestry: hops.map(rowSignatureInputs),
      anchor: rowSignatureInputs(anchor),
    });
  if (kind === "dedicated") {
    const derived = deriveDedicatedRow(row);
    if (derived.kind !== "proof") return derived;
    return {
      kind: "derived",
      anchorProof: derived.proof,
      authority: {
        workspaceId,
        kind: "dedicated",
        materializationId: derived.proof.materializationId,
        authorizationRevision: derived.proof.authorizationRevision,
        anchorWorkspaceId: workspaceId,
        anchorPath: derived.proof.path,
        ancestry: [],
        signature: sign([], entry),
      },
    };
  }
  // shared
  if (proofPresent) {
    return { kind: "unsupported", detail: "shared task rows carry no preparation proof" };
  }
  const walk = walkSharedAncestry(snapshot, entry);
  if (!walk.ok) return { kind: "shared-broken", detail: walk.detail };
  let anchorProof: TaskCheckoutPreparation | null = null;
  if (walk.anchorKind === "dedicated") {
    const derived = deriveDedicatedRow(walk.anchor.workspace);
    if (derived.kind !== "proof") {
      return {
        kind: "shared-broken",
        detail: `anchor ${walk.anchor.workspace.id ?? "?"} is ${derived.kind}`,
      };
    }
    anchorProof = derived.proof;
  }
  return {
    kind: "derived",
    anchorProof,
    authority: {
      workspaceId,
      kind: "shared",
      materializationId: anchorProof?.materializationId ?? "",
      authorizationRevision: anchorProof?.authorizationRevision ?? "",
      anchorWorkspaceId: walk.anchor.workspace.id ?? "",
      // The directory the shared row executes in (== the anchor's, by the walk).
      anchorPath: executionDirectory(entry),
      ancestry: walk.hops.map((hop) => hop.workspace.id ?? ""),
      signature: sign(walk.hops, walk.anchor),
    },
  };
}

/**
 * Derive the preparation state of a task row from a strict config snapshot and the host
 * filesystem. Lock-free (stats and bounded reads only): safe to call inside lifecycle mutexes and
 * inside the pruner's locked callbacks. Never throws; every failure is a refusing state. A
 * workspace id without a row is `unreadable` (refused), never an exemption.
 */
export async function validateTaskCheckoutPreparation(
  config: ConfigReader,
  workspaceId: string
): Promise<TaskCheckoutPreparationState> {
  assert(workspaceId.length > 0, "validateTaskCheckoutPreparation: workspaceId required");
  let snapshot: ProjectsConfig;
  try {
    snapshot = config.loadConfigOrDefault({ throwOnError: true });
  } catch (error) {
    return { kind: "unreadable", detail: `task registry unreadable: ${getErrorMessage(error)}` };
  }
  const derived = deriveTaskCheckoutAuthorization(snapshot, workspaceId);
  if (derived.kind !== "derived") return derived;
  if (derived.anchorProof !== null) {
    const physical = await revalidateTaskCheckoutIdentity(derived.anchorProof);
    if (!physical.ok) {
      return derived.authority.kind === "dedicated"
        ? physical.state
        : {
            kind: "shared-broken",
            detail: `anchor ${derived.authority.anchorWorkspaceId} is ${physical.state.kind}`,
          };
    }
  }
  if (derived.authority.kind === "shared") {
    // The shared execution directory (the walk proved it is the anchor's too) must exist. For a
    // dedicated anchor its proof was just revalidated there; a root anchor has no proof.
    try {
      if (!(await fsPromises.stat(derived.authority.anchorPath)).isDirectory()) {
        return { kind: "shared-broken", detail: "shared path is not a directory" };
      }
    } catch (error) {
      return {
        kind: "shared-broken",
        detail: `shared checkout unreadable: ${getErrorMessage(error)}`,
      };
    }
  }
  return { kind: "ready", authority: derived.authority };
}

/** User-facing refusal text shared by every producer/consumer gate (one wording, one place). */
export function taskCheckoutNotPreparedMessage(
  state: Exclude<TaskCheckoutPreparationState, { kind: "ready" }>
): string {
  const detail =
    "detail" in state ? `: ${state.detail}` : "dimension" in state ? ` (${state.dimension})` : "";
  return `Task checkout is not prepared (${state.kind}${detail}). The task record and its files are retained for inspection and are not modified; start a fresh task to continue.`;
}

/**
 * Synchronous, config-only re-comparison of a previously derived authority against the CURRENT
 * rows: the derivation is repeated on a strict snapshot and its signature (every classification
 * input of the row, its ancestry and its anchor, including every proof field) must be identical.
 * For the send-admission fence, which runs synchronously after the asynchronous validation. No
 * filesystem access; a derivation that no longer authorizes is not current either.
 */
export function assertCurrentTaskCheckoutAuthority(
  config: ConfigReader,
  expected: TaskCheckoutAuthority
): { current: true } | { current: false; reason: string } {
  assert(expected.signature.length > 0, "assertCurrentTaskCheckoutAuthority: unsigned authority");
  let snapshot: ProjectsConfig;
  try {
    snapshot = config.loadConfigOrDefault({ throwOnError: true });
  } catch (error) {
    return { current: false, reason: `task registry unreadable: ${getErrorMessage(error)}` };
  }
  const derived = deriveTaskCheckoutAuthorization(snapshot, expected.workspaceId);
  if (derived.kind !== "derived") {
    return {
      current: false,
      reason: `row no longer authorizes: ${derived.kind}${"detail" in derived ? ` (${derived.detail})` : ""}`,
    };
  }
  if (derived.authority.signature !== expected.signature) {
    return { current: false, reason: "authorization inputs differ from the validated ones" };
  }
  return { current: true };
}
