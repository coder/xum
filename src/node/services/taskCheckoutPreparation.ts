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
 * from live same-path ancestry up to the nearest dedicated task (which must itself be `ready`)
 * or ordinary root workspace. Intermediates matter: an archived, missing or path-divergent hop
 * breaks the context. Ordinary roots and off-host task rows are outside the protocol.
 *
 * Limits (by design): in-place edits inside a validated directory are not detected (later
 * legitimate consent is allowed); a local writer with access to `.git` can forge the nonce — this
 * is an integrity check against accidental and older-build replacement, not a security boundary;
 * inode reuse alone is not relied upon (the nonce and the admin dir identity must match too).
 * Concurrent access by builds that do not implement this protocol is unsupported.
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

export interface TaskCheckoutAuthority {
  workspaceId: string;
  kind: "dedicated" | "shared";
  /** The anchor's proof identity ("" for an ordinary-root anchor). */
  materializationId: string;
  authorizationRevision: string;
  /** Dedicated: the row itself. Shared: the dedicated task or ordinary root the context comes from. */
  anchorWorkspaceId: string;
  anchorPath: string;
  /** Shared: every intermediate shared row walked (child → parent order); dedicated: empty. */
  ancestry: readonly string[];
}

/** Identity captured under the checkout locks, before the proof is built. */
export interface BoundTaskCheckoutIdentity {
  materializationId: string;
  path: string;
  realpath: string;
  root: { dev: string; ino: string };
  gitdir: { pointer: string; dev: string; ino: string };
}

type ConfigReader = Pick<Config, "loadConfigOrDefault">;
type ProjectsConfig = ReturnType<Config["loadConfigOrDefault"]>;

const hex16 = () => randomBytes(8).toString("hex");
export const newMaterializationId = (): string => `mat_${hex16()}`;
const newAuthorizationRevision = (): string => `rev_${hex16()}`;

/** Sorted-key JSON of the row's runtime config: a full binding (type alone is not enough). */
export function canonicalRuntimeConfigJson(runtimeConfig: RuntimeConfig | undefined): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, sort((value as Record<string, unknown>)[key])])
      );
    }
    return value;
  };
  return JSON.stringify(sort(runtimeConfig ?? null));
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

class SpecialFileError extends Error {}

/**
 * Read a small REGULAR file without following symlinks and without ever blocking a libuv thread:
 * a FIFO/device at the path is refused by the lstat/fstat type checks and the O_NONBLOCK open.
 */
async function readSmallRegularFile(filePath: string, maxBytes: number): Promise<string> {
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
// Producer side: bind under the held checkout locks, revalidate before publication
// ---------------------------------------------------------------------------------------------

/**
 * Capture the physical identity of a freshly sanitized dedicated checkout and write the nonce.
 * MUST run inside the prune's held checkout locks (after the prune's writes settled). Refuses a
 * pre-existing nonce: a cooperating materializer never blesses or reuses another generation.
 */
export async function bindTaskCheckoutIdentity(
  target: { workspacePath: string },
  materializationId: string
): Promise<BoundTaskCheckoutIdentity | Error> {
  assert(target.workspacePath.length > 0, "bindTaskCheckoutIdentity: workspacePath required");
  assert(/^mat_[0-9a-f]{16}$/.test(materializationId), "bindTaskCheckoutIdentity: bad id");
  try {
    const realpath = await fsPromises.realpath(target.workspacePath);
    const rootBefore = await statIds(target.workspacePath);
    if (!rootBefore.isDirectory) return new Error(`${target.workspacePath} is not a directory`);
    const pointer = await readGitAdminDir(target.workspacePath);
    const adminBefore = await statIds(pointer);
    if (!adminBefore.isDirectory) return new Error(`${pointer} is not a directory`);
    const nonceFile = path.join(pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE);
    try {
      await fsPromises.lstat(nonceFile);
      return new Error(`${nonceFile} already exists: this checkout carries another preparation`);
    } catch (error) {
      if (!isEnoent(error)) throw error;
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
    const dir = await fsPromises.open(pointer, fsConstants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    // The directory must not have changed identity while the nonce landed.
    const rootAfter = await statIds(target.workspacePath);
    const adminAfter = await statIds(pointer);
    if (
      rootAfter.dev !== rootBefore.dev ||
      rootAfter.ino !== rootBefore.ino ||
      adminAfter.dev !== adminBefore.dev ||
      adminAfter.ino !== adminBefore.ino
    ) {
      return new Error(`${target.workspacePath} changed identity while binding its preparation`);
    }
    return {
      materializationId,
      path: target.workspacePath,
      realpath,
      root: { dev: rootBefore.dev, ino: rootBefore.ino },
      gitdir: { pointer, dev: adminBefore.dev, ino: adminBefore.ino },
    };
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
 * Pure (config-only) live same-path ancestry walk of a shared row: child → parent while each hop
 * is a live shared row at the same path, ending at the nearest dedicated task or ordinary root.
 */
function walkSharedAncestry(
  snapshot: ProjectsConfig,
  row: Workspace
):
  | { ok: true; anchor: Workspace; anchorKind: "dedicated" | "root"; ancestry: string[] }
  | { ok: false; detail: string } {
  const ancestry: string[] = [];
  const visited = new Set<string>([row.id ?? ""]);
  let current = row;
  for (let hop = 0; hop < MAX_SHARED_ANCESTRY_HOPS; hop++) {
    const parentId = current.parentWorkspaceId;
    if (parentId == null) return { ok: false, detail: `${current.id} has no parent` };
    if (visited.has(parentId)) return { ok: false, detail: `ancestry cycle at ${parentId}` };
    visited.add(parentId);
    const parent = findWorkspaceEntry(snapshot, parentId)?.workspace;
    if (!parent) return { ok: false, detail: `ancestor ${parentId} not found` };
    if (isWorkspaceArchived(parent.archivedAt, parent.unarchivedAt)) {
      return { ok: false, detail: `ancestor ${parentId} is archived` };
    }
    if (parent.path !== row.path)
      return { ok: false, detail: `ancestor ${parentId} has a different path` };
    if (!isHostLocalRuntime(parent.runtimeConfig)) {
      return { ok: false, detail: `ancestor ${parentId} is not host-local` };
    }
    const kind = classifyTaskCheckoutKind(parent);
    if (kind === "root") return { ok: true, anchor: parent, anchorKind: "root", ancestry };
    if (kind === "dedicated")
      return { ok: true, anchor: parent, anchorKind: "dedicated", ancestry };
    if (kind !== "shared") return { ok: false, detail: `ancestor ${parentId} is ${kind}` };
    ancestry.push(parentId);
    current = parent;
  }
  return { ok: false, detail: "ancestry exceeds the supported depth" };
}

/**
 * Derive the preparation state of a task row from a strict config snapshot and the host
 * filesystem. Lock-free (stats and bounded reads only): safe to call inside lifecycle mutexes and
 * inside the pruner's locked callbacks. Never throws; every failure is a refusing state.
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
  const row = findWorkspaceEntry(snapshot, workspaceId)?.workspace;
  if (!row) return { kind: "unreadable", detail: `workspace ${workspaceId} not found` };
  const kind = classifyTaskCheckoutKind(row);
  if (kind === "root") return { kind: "excluded-root" };
  if (kind === "offhost") {
    // A proof cannot be carried onto a non-host-local runtime to escape the protocol.
    return row.taskCheckoutPreparation === undefined
      ? { kind: "excluded-offhost" }
      : { kind: "runtime-mismatch", detail: "proof present on a non-host-local runtime" };
  }
  if (kind === "dedicated") {
    const derived = deriveDedicatedRow(row);
    if (derived.kind !== "proof") return derived;
    const physical = await revalidateTaskCheckoutIdentity(derived.proof);
    if (!physical.ok) return physical.state;
    return {
      kind: "ready",
      authority: {
        workspaceId,
        kind: "dedicated",
        materializationId: derived.proof.materializationId,
        authorizationRevision: derived.proof.authorizationRevision,
        anchorWorkspaceId: workspaceId,
        anchorPath: derived.proof.path,
        ancestry: [],
      },
    };
  }
  // shared
  if (row.taskCheckoutPreparation !== undefined) {
    return { kind: "unsupported", detail: "shared task rows carry no preparation proof" };
  }
  const walk = walkSharedAncestry(snapshot, row);
  if (!walk.ok) return { kind: "shared-broken", detail: walk.detail };
  let materializationId = "";
  let authorizationRevision = "";
  if (walk.anchorKind === "dedicated") {
    const derived = deriveDedicatedRow(walk.anchor);
    if (derived.kind !== "proof") {
      return { kind: "shared-broken", detail: `anchor ${walk.anchor.id} is ${derived.kind}` };
    }
    const physical = await revalidateTaskCheckoutIdentity(derived.proof);
    if (!physical.ok) {
      return {
        kind: "shared-broken",
        detail: `anchor ${walk.anchor.id} is ${physical.state.kind}`,
      };
    }
    materializationId = derived.proof.materializationId;
    authorizationRevision = derived.proof.authorizationRevision;
  }
  // The shared directory itself must exist and be the anchor's directory.
  try {
    const own = await fsPromises.realpath(row.path);
    const anchor = await fsPromises.realpath(walk.anchor.path);
    if (own !== anchor)
      return { kind: "shared-broken", detail: "shared path diverges from its anchor" };
    if (!(await fsPromises.stat(own)).isDirectory()) {
      return { kind: "shared-broken", detail: "shared path is not a directory" };
    }
  } catch (error) {
    return {
      kind: "shared-broken",
      detail: `shared checkout unreadable: ${getErrorMessage(error)}`,
    };
  }
  return {
    kind: "ready",
    authority: {
      workspaceId,
      kind: "shared",
      materializationId,
      authorizationRevision,
      anchorWorkspaceId: walk.anchor.id ?? "",
      anchorPath: walk.anchor.path,
      ancestry: walk.ancestry,
    },
  };
}

/**
 * Synchronous, config-only re-comparison of a previously derived authority against the CURRENT
 * rows: proof identity/revision and published path for the anchor, and the same live same-path
 * ancestry for shared rows. For the send-admission fence, which runs synchronously after the
 * asynchronous validation. No filesystem access.
 */
export function assertCurrentTaskCheckoutAuthority(
  config: ConfigReader,
  expected: TaskCheckoutAuthority
): { current: true } | { current: false; reason: string } {
  let snapshot: ProjectsConfig;
  try {
    snapshot = config.loadConfigOrDefault({ throwOnError: true });
  } catch (error) {
    return { current: false, reason: `task registry unreadable: ${getErrorMessage(error)}` };
  }
  const row = findWorkspaceEntry(snapshot, expected.workspaceId)?.workspace;
  if (!row) return { current: false, reason: "workspace row missing" };
  const kind = classifyTaskCheckoutKind(row);
  if (kind !== expected.kind) return { current: false, reason: `row is now ${kind}` };
  const checkAnchorProof = (
    anchor: Workspace
  ): { current: true } | { current: false; reason: string } => {
    const derived = deriveDedicatedRow(anchor);
    if (derived.kind !== "proof") return { current: false, reason: `anchor is ${derived.kind}` };
    if (
      derived.proof.materializationId !== expected.materializationId ||
      derived.proof.authorizationRevision !== expected.authorizationRevision ||
      derived.proof.path !== expected.anchorPath
    ) {
      return { current: false, reason: "anchor proof differs from the validated one" };
    }
    return { current: true };
  };
  if (kind === "dedicated") return checkAnchorProof(row);
  if (row.taskCheckoutPreparation !== undefined) {
    return { current: false, reason: "shared row now carries a proof" };
  }
  const walk = walkSharedAncestry(snapshot, row);
  if (!walk.ok) return { current: false, reason: walk.detail };
  if (
    walk.anchor.id !== expected.anchorWorkspaceId ||
    walk.anchor.path !== expected.anchorPath ||
    walk.ancestry.length !== expected.ancestry.length ||
    walk.ancestry.some((id, index) => id !== expected.ancestry[index])
  ) {
    return { current: false, reason: "shared ancestry differs from the validated one" };
  }
  if (walk.anchorKind === "dedicated") return checkAnchorProof(walk.anchor);
  return expected.materializationId === "" && expected.authorizationRevision === ""
    ? { current: true }
    : { current: false, reason: "root anchor carries no proof" };
}
