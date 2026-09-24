import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  TaskCheckoutPreparationSchema,
  type TaskCheckoutPreparation,
} from "@/common/schemas/project";
import type { Workspace } from "@/common/types/project";
import type { ProjectRef } from "@/common/types/workspace";
import {
  getSrcBaseDir,
  hasSrcBaseDir,
  isDevcontainerRuntime,
  type RuntimeConfig,
} from "@/common/types/runtime";
import type { Config } from "@/node/config";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { TASK_CHECKOUT_VALIDATION_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { getErrorMessage } from "@/common/utils/errors";
import assert from "@/common/utils/assert";

/**
 * Preparation proof of a DEDICATED host-local agent-task checkout.
 *
 * A dedicated task checkout is forked and strictly sanitized (stale `plugin:` enables pruned)
 * BEFORE its row is first published; the same config write carries this proof. The proof binds
 * the row to the physical directory that was sanitized — root and git-admin device/inode, the
 * `.git` pointer and a producer nonce inside the git admin dir — plus the canonical runtime and
 * the published path. A multi-project task executes in one checkout per project: its proof (v2)
 * binds every secondary project's checkout the same way, with the same nonce in each one's own
 * git admin dir, so no checkout the task runs in is unproven. It is immutable: admissions never
 * rotate it and nothing rebinds it. Every execution/MCP consumer authorizes only a `ready`
 * derivation; everything else refuses without deleting or pruning anything (files stay
 * inspectable; recovery is an ordinary fresh task).
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
  | "nonce"
  /** A secondary checkout and its admin dir are both gone (the primary reports `missing`). */
  | "missing"
  /** The proof's project list (paths, names, order) is not exactly the row's `projects`. */
  | "projects"
  /** Two identities of one proof are the same directory (each project needs its own checkout). */
  | "duplicate"
  /** A multi-project task's execution container is missing or not a real directory. */
  | "container"
  /** A container project entry is missing, not a symlink, or points elsewhere than its checkout. */
  | "container-link";

export type TaskCheckoutPreparationState =
  | { kind: "excluded-root" }
  | { kind: "excluded-offhost" }
  | { kind: "legacy" }
  | { kind: "unsupported"; detail: string }
  | { kind: "runtime-mismatch"; detail: string }
  | { kind: "missing" }
  /**
   * `checkout`: the secondary checkout or container path that mismatched (absent for the row's
   * own checkout).
   */
  | { kind: "mismatch"; dimension: TaskCheckoutMismatchDimension; checkout?: string }
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

/** Physical identity of one checkout. */
interface CheckoutIdentity {
  path: string;
  realpath: string;
  root: { dev: string; ino: string };
  gitdir: { pointer: string; dev: string; ino: string };
}

/** A secondary project's checkout of a multi-project task (the fork orchestrator created it). */
export interface TaskCheckoutSecondaryTarget {
  projectPath: string;
  workspacePath: string;
}

/** Physical identity of a checkout, captured (and claimed) BEFORE the prune under its locks. */
export interface CapturedTaskCheckoutIdentity extends CheckoutIdentity {
  /** Multi-project tasks: every secondary checkout, claimed with the primary (proof v2). */
  secondaries?: Array<CheckoutIdentity & { projectPath: string }>;
  /**
   * Multi-project tasks: the row's full project list (primary first), bound by proof v2 with the
   * secondaries — runtime reconstruction, tool paths and patch collection consume all of it.
   */
  projects?: ProjectRef[];
}

/** A multi-project claim target: its checkouts, and the project list the row will publish. */
interface TaskCheckoutClaimTarget {
  workspacePath: string;
  secondaries?: readonly TaskCheckoutSecondaryTarget[];
  projects?: readonly ProjectRef[];
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

/**
 * The runtimes preparation covers. A devcontainer checkout is a host worktree too, but plugin
 * servers are never offered there (resolveAgentPluginsMcpContext), so preparation has no consent
 * state to protect: devcontainer tasks stay exempt ("offhost") from the execution/MCP gates and
 * need no proof. Their checkouts are still structurally protected — the structural-mutation
 * guard's host set (isHostLocalRuntimeConfig) includes devcontainer.
 */
function isHostLocalRuntime(runtimeConfig: RuntimeConfig | undefined): boolean {
  return (
    runtimeConfig === undefined ||
    runtimeConfig.type === "local" ||
    runtimeConfig.type === "worktree"
  );
}

/**
 * Project-dir LocalRuntime: `type: "local"` WITHOUT `srcBaseDir` — exactly runtimeFactory's
 * dispatch (`hasSrcBaseDir` is string PRESENCE; an empty string still selects the WorktreeRuntime).
 * A `local` config WITH `srcBaseDir` is a legacy WORKTREE: its rows execute in a directory of their
 * own and are dedicated like any worktree row. Both the classification and the execution directory
 * below, and the producers' fork/prepare decisions, must agree with the factory on this, or an
 * unproven legacy-worktree row anchors on the ordinary root by project directory (bypassing the
 * legacy refusal) and a producer skips preparing a fresh legacy-worktree fork.
 */
export function isProjectDirLocalRuntime(runtimeConfig: RuntimeConfig | undefined): boolean {
  return runtimeConfig?.type === "local" && !hasSrcBaseDir(runtimeConfig);
}

/**
 * The srcBaseDir a worktree-backed runtime derives its checkouts under, or undefined for a
 * project-dir local runtime. A devcontainer runtimeConfig carries none: runtimeFactory roots
 * its WorktreeManager at `new Config().srcDir`, i.e. `<getXumHome()>/src` — exactly what the
 * default worktree config's `~/.xum/src` expands to (XUM_ROOT and dev suffixes included).
 */
export function worktreeSrcBaseDir(runtime: RuntimeConfig): string | undefined {
  if (hasSrcBaseDir(runtime)) return runtime.srcBaseDir;
  if (runtime.type !== "devcontainer") return undefined;
  assert(hasSrcBaseDir(DEFAULT_RUNTIME_CONFIG), "the default runtime is a worktree runtime");
  return DEFAULT_RUNTIME_CONFIG.srcBaseDir;
}

/**
 * Name-derived checkout path, mirroring WorktreeManager.getWorkspacePath for worktree-style
 * runtimes (`<srcBaseDir>/<projectName>/<name>`, with the srcBaseDir tilde expanded exactly as the
 * WorktreeManager constructor does) and the project directory for project-dir local runtimes. A
 * missing runtimeConfig is the default worktree runtime (Config.getAllMetadata substitutes it).
 * Multi-project rows persist only the primary path; execution derives EVERY project's checkout
 * this way, so the validator and the structural guard share this one derivation.
 */
export function deriveHostLocalCheckoutPath(
  runtimeConfig: RuntimeConfig | undefined,
  projectPath: string,
  workspaceName: string
): string {
  assert(projectPath.length > 0, "deriveHostLocalCheckoutPath: projectPath is required");
  const srcBaseDir = worktreeSrcBaseDir(runtimeConfig ?? DEFAULT_RUNTIME_CONFIG);
  if (srcBaseDir !== undefined) {
    return path.join(expandTilde(srcBaseDir), getProjectName(projectPath), workspaceName);
  }
  return projectPath;
}

/** Worktree semantics — a fork gets a directory of its own: `worktree`, or legacy `local` + `srcBaseDir`. */
export function isWorktreeSemanticsRuntime(runtimeConfig: RuntimeConfig | undefined): boolean {
  return (
    runtimeConfig?.type === "worktree" ||
    (runtimeConfig?.type === "local" && hasSrcBaseDir(runtimeConfig))
  );
}

export function classifyTaskCheckoutKind(row: Workspace): TaskCheckoutKind {
  if (row.parentWorkspaceId == null) return "root";
  if (!isHostLocalRuntime(row.runtimeConfig)) return "offhost";
  // LocalRuntime forks never get a directory of their own (LocalRuntime.forkWorkspace shares the
  // project directory), so they are shared by construction.
  if (row.taskIsolation === "none" || isProjectDirLocalRuntime(row.runtimeConfig)) return "shared";
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

function sameCheckoutIdentity(a: CheckoutIdentity, b: CheckoutIdentity): boolean {
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
 * `claimUnderLock` hook — the mutating hook the prune joins before releasing its locks, never the
 * read-only `shouldPrune` verdict a deadline may leave detached): capture the physical identity of
 * the fresh dedicated checkout that is about to be sanitized and CLAIM it by writing the nonce
 * (durably) into its git admin dir.
 * Refuses a checkout that already carries a nonce: a cooperating materializer never blesses or
 * reuses another generation.
 *
 * The claim is written before, not after, the prune on purpose: a directory removed and
 * re-created at the same path can get the SAME root and admin inodes back (observed on Linux),
 * so device/inode identity alone cannot tell the pruned directory from a replacement, while a
 * replacement never carries a nonce only this process knows. A claimed checkout whose
 * preparation then fails is retained unpublished and refused by every later claim.
 *
 * `secondaries` (multi-project tasks): every secondary checkout is claimed right after the
 * primary, with the SAME nonce in its own git admin dir. They carry no consent state (a
 * multi-project workspace loads no agent plugins and reads overrides from its container path),
 * so nothing prunes them, but the same claim-then-bind brackets prove each one bound is the
 * directory that was claimed. One nonce per generation suffices: each admin dir is a different
 * directory, and the per-checkout root/admin identities already tell the checkouts apart.
 */
export async function claimTaskCheckoutIdentity(
  target: TaskCheckoutClaimTarget,
  materializationId: string
): Promise<CapturedTaskCheckoutIdentity | Error> {
  assert(target.workspacePath.length > 0, "claimTaskCheckoutIdentity: workspacePath required");
  assert(/^mat_[0-9a-f]{16}$/.test(materializationId), "claimTaskCheckoutIdentity: bad id");
  assertClaimTarget(target);
  try {
    const identity: CapturedTaskCheckoutIdentity = await claimCheckout(
      target.workspacePath,
      materializationId
    );
    if (target.secondaries === undefined || target.secondaries.length === 0) return identity;
    // Copied field by field: the proof must carry no `undefined`-valued or foreign keys.
    identity.projects = target.projects!.map((project) => ({
      projectPath: project.projectPath,
      projectName: project.projectName,
    }));
    identity.secondaries = [];
    for (const secondary of target.secondaries) {
      const claimed = await namingSecondary(secondary.workspacePath, () =>
        claimCheckout(secondary.workspacePath, materializationId)
      );
      identity.secondaries.push({ projectPath: secondary.projectPath, ...claimed });
    }
    return identity;
  } catch (error) {
    return error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

/** One checkout's claim (see claimTaskCheckoutIdentity). Throws on refusal. */
async function claimCheckout(
  workspacePath: string,
  materializationId: string
): Promise<CheckoutIdentity> {
  const captured = await captureIdentity(workspacePath);
  if (captured instanceof Error) throw captured;
  const { identity, nonce } = captured;
  const nonceFile = path.join(identity.gitdir.pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE);
  if (nonce !== null) {
    throw new Error(`${nonceFile} already exists: this checkout carries another preparation`);
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
}

/** A secondary checkout's refusal, naming that checkout (the primary's errors name their paths). */
async function namingSecondary<T>(workspacePath: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`secondary checkout ${workspacePath}: ${getErrorMessage(error)}`);
  }
}

/**
 * A multi-project target names each checkout once (the fork orchestrator made them distinct) and
 * lists the row's projects, whose `[1..]` are exactly its secondaries' projects, in order.
 */
function assertClaimTarget(target: TaskCheckoutClaimTarget): void {
  const secondaries = target.secondaries ?? [];
  for (const secondary of secondaries) {
    assert(secondary.projectPath.length > 0, "task checkout secondary: projectPath required");
    assert(secondary.workspacePath.length > 0, "task checkout secondary: workspacePath required");
  }
  const paths = new Set([target.workspacePath, ...secondaries.map((s) => s.workspacePath)]);
  assert(paths.size === secondaries.length + 1, "task checkout targets must be distinct paths");
  if (secondaries.length === 0) return;
  assert(
    target.projects?.length === secondaries.length + 1 &&
      secondaries.every((s, index) => target.projects![index + 1].projectPath === s.projectPath),
    "task checkout target: projects[1..] must be the secondaries' projects, in order"
  );
}

/**
 * Step 2, AFTER the prune's writes settled and still inside the same held checkout locks: the
 * directory must be exactly the one claimed before the prune — same path, realpath, root and
 * admin device/inode AND carrying this materialization's nonce — only then is the identity bound
 * (the proof is built from it). Anything else refuses: nothing is written here, so a replacement
 * is never stamped and never published. Every secondary claimed with it is bound the same way.
 */
export async function bindTaskCheckoutIdentity(
  target: TaskCheckoutClaimTarget,
  materializationId: string,
  expected: CapturedTaskCheckoutIdentity
): Promise<BoundTaskCheckoutIdentity | Error> {
  assert(target.workspacePath.length > 0, "bindTaskCheckoutIdentity: workspacePath required");
  assert(/^mat_[0-9a-f]{16}$/.test(materializationId), "bindTaskCheckoutIdentity: bad id");
  assert(expected.path === target.workspacePath, "bindTaskCheckoutIdentity: expected other path");
  const secondaries = target.secondaries ?? [];
  const claimed = expected.secondaries ?? [];
  assert(
    secondaries.length === claimed.length &&
      secondaries.every(
        (secondary, index) =>
          claimed[index].path === secondary.workspacePath &&
          claimed[index].projectPath === secondary.projectPath
      ),
    "bindTaskCheckoutIdentity: expected other secondaries"
  );
  try {
    await bindCheckout(target.workspacePath, materializationId, expected);
    for (const [index, secondary] of secondaries.entries()) {
      await namingSecondary(secondary.workspacePath, () =>
        bindCheckout(secondary.workspacePath, materializationId, claimed[index])
      );
    }
    return { ...expected, materializationId };
  } catch (error) {
    return error instanceof Error ? error : new Error(getErrorMessage(error));
  }
}

/** One checkout's bind (see bindTaskCheckoutIdentity). Throws on refusal. */
async function bindCheckout(
  workspacePath: string,
  materializationId: string,
  expected: CheckoutIdentity
): Promise<void> {
  const captured = await captureIdentity(workspacePath);
  if (captured instanceof Error) throw captured;
  if (!sameCheckoutIdentity(captured.identity, expected)) {
    throw new Error(`${workspacePath} changed identity between claim and bind`);
  }
  if (captured.nonce !== materializationId) {
    throw new Error(`${workspacePath} does not carry the claimed preparation nonce`);
  }
}

type TaskCheckoutIdentityCheck = { ok: true } | { ok: false; state: TaskCheckoutPreparationState };
type TaskCheckoutIdentityInput = Pick<
  TaskCheckoutPreparation,
  "path" | "realpath" | "root" | "gitdir" | "materializationId"
> & { secondaries?: readonly CheckoutIdentity[] };

/**
 * Read-only comparison of a proof (or bound identity) against the host filesystem, with a
 * deadline that fails closed as `unreadable`. The producer's final pre-publication check runs
 * it while holding the registration lock, where a stalled FUSE/NFS mount must not hang every
 * publication; the stalled read-only calls are abandoned and their late result discarded.
 */
export async function revalidateTaskCheckoutIdentity(
  proof: TaskCheckoutIdentityInput,
  options: { timeoutMs?: number } = {}
): Promise<TaskCheckoutIdentityCheck> {
  const timeoutMs = options.timeoutMs ?? TASK_CHECKOUT_VALIDATION_TIMEOUT_MS;
  assert(timeoutMs > 0, "revalidateTaskCheckoutIdentity: timeoutMs must be positive");
  const compared = await raceWithAbortAndTimeout(compareTaskCheckoutIdentity(proof), { timeoutMs });
  return compared.kind === "ok"
    ? compared.value
    : {
        ok: false,
        state: {
          kind: "unreadable",
          detail: `checkout identity check timed out after ${timeoutMs}ms`,
        },
      };
}

/**
 * The unbounded comparison behind `revalidateTaskCheckoutIdentity`: the primary checkout, then
 * every secondary checkout of a multi-project proof (all under the caller's one deadline). A
 * secondary's refusal names that checkout; a gone secondary is a `missing` MISMATCH of the task,
 * not the task's `missing` state (its own checkout is intact). Never rejects.
 */
async function compareTaskCheckoutIdentity(
  proof: TaskCheckoutIdentityInput
): Promise<TaskCheckoutIdentityCheck> {
  const primary = await compareCheckoutIdentity(proof, proof.materializationId);
  if (!primary.ok) return primary;
  for (const secondary of proof.secondaries ?? []) {
    const check = await compareCheckoutIdentity(secondary, proof.materializationId);
    if (check.ok) continue;
    const { state } = check;
    const checkout = secondary.path;
    if (state.kind === "missing") {
      return { ok: false, state: { kind: "mismatch", dimension: "missing", checkout } };
    }
    if (state.kind === "mismatch") return { ok: false, state: { ...state, checkout } };
    assert(state.kind === "unreadable", "compareCheckoutIdentity: unexpected refusal state");
    return { ok: false, state: { kind: "unreadable", detail: `${checkout}: ${state.detail}` } };
  }
  return { ok: true };
}

/** One checkout against the filesystem. Never rejects. */
async function compareCheckoutIdentity(
  proof: CheckoutIdentity,
  materializationId: string
): Promise<TaskCheckoutIdentityCheck> {
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
    if (nonce.trim() !== materializationId) return mismatch("nonce");
    return { ok: true };
  } catch (error) {
    return { ok: false, state: { kind: "unreadable", detail: getErrorMessage(error) } };
  }
}

/**
 * A multi-project task executes with its container as cwd and reaches each project through
 * `<container>/<projectName>`, a symlink ContainerManager creates at fork time. The mapping is
 * VALIDATED, never rebuilt (no automatic restore): the container must be a real directory (lstat;
 * a symlink could redirect the whole tree) and each project entry a symlink whose target is
 * exactly the proven checkout. Other entries are ignored: they map no project, exactly like
 * in-place edits inside a validated checkout (not detected by design), and multi-project
 * workspaces are offered no plugin servers, so no consent state lives there. lstat/readlink never
 * follow a link; the caller's deadline bounds the calls. Never rejects.
 */
async function compareTaskCheckoutContainer(
  container: TaskCheckoutContainer
): Promise<TaskCheckoutIdentityCheck> {
  const mismatch = (dimension: "container" | "container-link", checkout: string) =>
    ({ ok: false, state: { kind: "mismatch", dimension, checkout } }) as const;
  try {
    try {
      if (!(await fsPromises.lstat(container.path)).isDirectory()) {
        return mismatch("container", container.path);
      }
    } catch (error) {
      if (isEnoent(error)) return mismatch("container", container.path);
      throw error;
    }
    for (const entry of container.entries) {
      try {
        if (!(await fsPromises.lstat(entry.path)).isSymbolicLink()) {
          return mismatch("container-link", entry.path);
        }
        if ((await fsPromises.readlink(entry.path)) !== entry.target) {
          return mismatch("container-link", entry.path);
        }
      } catch (error) {
        if (isEnoent(error)) return mismatch("container-link", entry.path);
        throw error;
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      state: { kind: "unreadable", detail: `${container.path}: ${getErrorMessage(error)}` },
    };
  }
}

/**
 * v1 for a single-project checkout (unchanged, so builds that only know v1 keep validating it);
 * v2 when secondary checkouts were bound (builds that only know v1 refuse it as unsupported).
 */
export function buildTaskCheckoutPreparation(
  identity: BoundTaskCheckoutIdentity,
  runtimeConfig: RuntimeConfig | undefined
): TaskCheckoutPreparation {
  const primary = {
    materializationId: identity.materializationId,
    authorizationRevision: newAuthorizationRevision(),
    runtimeConfigJson: canonicalRuntimeConfigJson(runtimeConfig),
    path: identity.path,
    realpath: identity.realpath,
    root: identity.root,
    gitdir: identity.gitdir,
  };
  const secondaries = identity.secondaries ?? [];
  assert(
    secondaries.length === 0 || identity.projects?.length === secondaries.length + 1,
    "buildTaskCheckoutPreparation: a multi-project identity carries its project list"
  );
  const proof: TaskCheckoutPreparation =
    secondaries.length === 0
      ? { v: 1, ...primary }
      : {
          v: 2,
          ...primary,
          secondaries: secondaries.map((secondary) => ({
            projectPath: secondary.projectPath,
            path: secondary.path,
            realpath: secondary.realpath,
            root: secondary.root,
            gitdir: secondary.gitdir,
          })),
          projects: identity.projects!.map((project) => ({
            projectPath: project.projectPath,
            projectName: project.projectName,
          })),
        };
  assert(TaskCheckoutPreparationSchema.safeParse(proof).success, "built proof must be well-formed");
  // The producer verifies publication by comparing the persisted (JSON round-tripped) proof with
  // this one (isDeepStrictEqual): an `undefined`-valued key would make it never verify.
  assert(
    isDeepStrictEqual(JSON.parse(JSON.stringify(proof)), proof),
    "built proof must survive a JSON round trip unchanged"
  );
  return proof;
}

/** Every checkout a proof binds: the row's own, then (v2) each secondary project's. */
export function taskCheckoutProofPaths(proof: TaskCheckoutPreparation): string[] {
  return [proof.path, ...(proof.v === 2 ? proof.secondaries.map((s) => s.path) : [])];
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
  // A scratch row's metadata projectPath IS its path (Config resolves it so; the `_scratch`
  // bucket key is not a directory), so its LocalRuntime runs in the row's own path.
  if (entry.workspace.kind === "scratch") return entry.workspace.path;
  // A project-dir LocalRuntime runs in the metadata projectPath, which Config resolves to the
  // row's primary project when it lists projects and to its bucket key otherwise
  // (Config.buildWorkspaceMetadata): a multi-project row lives in the `_multi` bucket, whose key
  // is not a directory.
  return isProjectDirLocalRuntime(entry.workspace.runtimeConfig)
    ? (entry.workspace.projects?.[0]?.projectPath ?? entry.projectPath)
    : entry.workspace.path;
}

/** The classification inputs of one row, as signed by an authority. */
function rowSignatureInputs(entry: ConfigEntry): Record<string, unknown> {
  const row = entry.workspace;
  return {
    id: row.id ?? null,
    projectPath: entry.projectPath,
    // Every input the derivation consults (a local row's primary project included), so the
    // synchronous fence notices any change to the directory a shared row anchors on.
    executionDirectory: executionDirectory(entry),
    kind: classifyTaskCheckoutKind(row),
    parentWorkspaceId: row.parentWorkspaceId ?? null,
    // Multi-project execution derives every checkout and the container from the name.
    name: row.name ?? null,
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
  | { kind: "proof"; proof: TaskCheckoutPreparation; container: TaskCheckoutContainer | null }
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
  // A multi-project task also executes in one checkout per secondary project, and runtime
  // reconstruction, tool paths and patch collection consume the row's whole `projects` list
  // (primary repository and every name included). A v1 proof predates binding any of that; a
  // v2 proof must bind exactly the row's list — paths and names, in order — and its secondaries
  // must be that list's `[1..]`. (The row's projects need not be signed separately: the only
  // lists that derive are the one the signed proof fixes.)
  const rowProjects = row.projects ?? [];
  if (proof.v === 1) {
    if (rowProjects.length > 1) {
      return {
        kind: "unsupported",
        detail: "a v1 proof binds only the primary checkout of a multi-project task",
      };
    }
  } else if (
    rowProjects.length !== proof.projects.length ||
    rowProjects.some(
      (project, index) =>
        project.projectPath !== proof.projects[index].projectPath ||
        project.projectName !== proof.projects[index].projectName
    ) ||
    proof.secondaries.length !== proof.projects.length - 1 ||
    proof.secondaries.some(
      (secondary, index) => secondary.projectPath !== proof.projects[index + 1].projectPath
    )
  ) {
    return { kind: "mismatch", dimension: "projects" };
  }
  if (proof.v === 1) return { kind: "proof", proof, container: null };
  const refusal = multiProjectIdentityRefusal(row, proof);
  if (refusal !== null) return refusal;
  return { kind: "proof", proof, container: multiProjectContainer(row, proof) };
}

/**
 * Multi-project execution builds every project's runtime from the runtime config, the project
 * path and the row's NAME (no persisted path is consulted; the primary's included), so each v2
 * identity must be exactly the checkout derived for its project. Identities must also be
 * distinct directories: every checkout carries the same generation nonce, so an entry copying
 * another's identity would pass the physical checks while its project's checkout goes unproven.
 */
function multiProjectIdentityRefusal(
  row: Workspace,
  proof: Extract<TaskCheckoutPreparation, { v: 2 }>
): Exclude<TaskCheckoutPreparationState, { kind: "ready" }> | null {
  // The producer forks multi-project checkouts only for worktree semantics (it asserts so).
  if (!isWorktreeSemanticsRuntime(row.runtimeConfig)) {
    return {
      kind: "runtime-mismatch",
      detail: "a multi-project proof requires a worktree runtime",
    };
  }
  const name = row.name ?? "";
  if (name.length === 0) return { kind: "mismatch", dimension: "path" };
  const identities = [proof, ...proof.secondaries];
  for (const [index, identity] of identities.entries()) {
    const derived = deriveHostLocalCheckoutPath(
      row.runtimeConfig,
      proof.projects[index].projectPath,
      name
    );
    if (identity.path !== derived) {
      return index === 0
        ? { kind: "mismatch", dimension: "path" }
        : { kind: "mismatch", dimension: "path", checkout: derived };
    }
  }
  const distinct = (key: (identity: (typeof identities)[number]) => string) =>
    new Set(identities.map(key)).size === identities.length;
  if (
    !distinct((identity) => identity.realpath) ||
    !distinct((identity) => `${identity.root.dev}:${identity.root.ino}`) ||
    !distinct((identity) => `${identity.gitdir.dev}:${identity.gitdir.ino}`)
  ) {
    return { kind: "mismatch", dimension: "duplicate" };
  }
  return null;
}

/**
 * A multi-project task's execution container, derived exactly as execution does (ContainerManager
 * over the runtime's raw srcBaseDir and the row's name): its path and, per project in order, the
 * entry execution reaches the project by and the proven checkout it must point at.
 */
interface TaskCheckoutContainer {
  path: string;
  entries: ReadonlyArray<{ path: string; target: string }>;
}

function multiProjectContainer(
  row: Workspace,
  proof: Extract<TaskCheckoutPreparation, { v: 2 }>
): TaskCheckoutContainer {
  const srcBaseDir = getSrcBaseDir(row.runtimeConfig);
  const name = row.name ?? "";
  // multiProjectIdentityRefusal accepted this row: worktree semantics and a name.
  assert(srcBaseDir !== undefined && name.length > 0, "multiProjectContainer: unchecked row");
  const containers = new ContainerManager(srcBaseDir);
  const identities = [proof, ...proof.secondaries];
  return {
    path: containers.getContainerPath(name),
    entries: proof.projects.map((project, index) => ({
      path: containers.getProjectEntryPath(name, project.projectName),
      target: identities[index].path,
    })),
  };
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
      anchorContainer: TaskCheckoutContainer | null;
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
      anchorContainer: derived.container,
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
  let anchorContainer: TaskCheckoutContainer | null = null;
  if (walk.anchorKind === "dedicated") {
    const derived = deriveDedicatedRow(walk.anchor.workspace);
    if (derived.kind !== "proof") {
      return {
        kind: "shared-broken",
        detail: `anchor ${walk.anchor.workspace.id ?? "?"} is ${derived.kind}`,
      };
    }
    anchorProof = derived.proof;
    anchorContainer = derived.container;
  }
  return {
    kind: "derived",
    anchorProof,
    anchorContainer,
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
 * workspace id without a row is `unreadable` (refused), never an exemption. The physical checks
 * are time-bounded and fail closed as `unreadable` on expiry.
 */
export async function validateTaskCheckoutPreparation(
  config: ConfigReader,
  workspaceId: string,
  options: { timeoutMs?: number } = {}
): Promise<TaskCheckoutPreparationState> {
  assert(workspaceId.length > 0, "validateTaskCheckoutPreparation: workspaceId required");
  const timeoutMs = options.timeoutMs ?? TASK_CHECKOUT_VALIDATION_TIMEOUT_MS;
  assert(timeoutMs > 0, "validateTaskCheckoutPreparation: timeoutMs must be positive");
  let snapshot: ProjectsConfig;
  try {
    snapshot = config.loadConfigOrDefault({ throwOnError: true });
  } catch (error) {
    return { kind: "unreadable", detail: `task registry unreadable: ${getErrorMessage(error)}` };
  }
  const derived = deriveTaskCheckoutAuthorization(snapshot, workspaceId);
  if (derived.kind !== "derived") return derived;
  // The physical checks are read-only, so on expiry the stalled operations are simply abandoned:
  // they settle (or not) on their own, never reject (validatePhysicalCheckout catches every
  // error) and their late result is discarded. Nothing is authorized from a timed-out check.
  const physical = await raceWithAbortAndTimeout(validatePhysicalCheckout(derived), {
    timeoutMs,
  });
  if (physical.kind !== "ok") {
    return { kind: "unreadable", detail: `checkout validation timed out after ${timeoutMs}ms` };
  }
  return physical.value;
}

/** The filesystem half of `validateTaskCheckoutPreparation`. Never rejects. */
async function validatePhysicalCheckout(derived: {
  authority: TaskCheckoutAuthority;
  anchorProof: TaskCheckoutPreparation | null;
  anchorContainer: TaskCheckoutContainer | null;
}): Promise<TaskCheckoutPreparationState> {
  if (derived.anchorProof !== null) {
    // Unbounded here: validateTaskCheckoutPreparation's single deadline covers this half.
    let physical = await compareTaskCheckoutIdentity(derived.anchorProof);
    if (physical.ok && derived.anchorContainer !== null) {
      physical = await compareTaskCheckoutContainer(derived.anchorContainer);
    }
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

/**
 * Config-only publication check, run inside the config edit that inserts a task row (the row
 * already in `snapshot`). Protected rows are published under the registration lock, so a
 * structural mutator that won that lock first has already renamed or removed the parent, while
 * the creator captured it before waiting. Such a row is refused (nothing is written) instead of
 * being persisted broken:
 *  - a SHARED row's live same-path ancestry must still derive;
 *  - a DEVCONTAINER task row (exempt from preparation, yet structurally protected: once
 *    published it cannot be removed) must still have its parent registered. Dedicated host-local
 *    rows need no check here: they fork inside the lock, from the parent as it is then.
 * Other kinds pass unchecked. Returns the refusal, or null to publish.
 */
export function taskRowPublicationRefusal(
  snapshot: ProjectsConfig,
  workspaceId: string
): string | null {
  const entry = findWorkspaceEntry(snapshot, workspaceId);
  assert(entry != null, "taskRowPublicationRefusal: insert the row before checking it");
  const row = entry.workspace;
  const refusal = (detail: string) =>
    `the parent workspace changed while this task was being created (${detail}); nothing was published. Retry the task.`;
  if (isDevcontainerRuntime(row.runtimeConfig) && row.parentWorkspaceId != null) {
    return findWorkspaceEntry(snapshot, row.parentWorkspaceId) == null
      ? refusal(`parent ${row.parentWorkspaceId} is no longer registered`)
      : null;
  }
  if (classifyTaskCheckoutKind(row) !== "shared") return null;
  const derived = deriveTaskCheckoutAuthorization(snapshot, workspaceId);
  if (derived.kind === "derived") return null;
  return refusal(`${derived.kind}${"detail" in derived ? `: ${derived.detail}` : ""}`);
}

/**
 * Physical check, under the registration lock, of a proof-less devcontainer checkout the task
 * depends on: the checkout must still be a directory and its Git backing must still resolve (a
 * `.git` directory, or a pointer to an existing admin dir). A devcontainer task row is
 * structurally protected once published and could then never be removed, so each publication
 * or binding that trusts such a checkout checks it first:
 *  - a queued/reserved row's fork SOURCE (the parent's checkout, `subject`) when the row is
 *    published — the structural guard protects that source only from then on;
 *  - the checkout its launch forked, right before binding it (path/runtime) to the row.
 * Deadline-bounded like every read under the lock (a stalled mount refuses). Returns the
 * refusal, or null to proceed.
 */
export async function materializedCheckoutPublicationRefusal(
  workspacePath: string,
  options: { subject?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  assert(workspacePath.length > 0, "materializedCheckoutPublicationRefusal: path is required");
  const timeoutMs = options.timeoutMs ?? TASK_CHECKOUT_VALIDATION_TIMEOUT_MS;
  assert(timeoutMs > 0, "materializedCheckoutPublicationRefusal: timeoutMs must be positive");
  const check = async (): Promise<string | null> => {
    try {
      if (!(await statIds(workspacePath)).isDirectory) return `${workspacePath} is not a directory`;
      if ((await fsPromises.lstat(path.join(workspacePath, ".git"))).isDirectory()) return null;
      const adminDir = await readGitAdminDir(workspacePath);
      return (await statIds(adminDir)).isDirectory ? null : `${adminDir} is not a directory`;
    } catch (error) {
      return getErrorMessage(error);
    }
  };
  const checked = await raceWithAbortAndTimeout(check(), { timeoutMs });
  const detail = checked.kind === "ok" ? checked.value : `timed out after ${timeoutMs}ms`;
  return detail === null
    ? null
    : `${options.subject ?? "the task's checkout"} or its Git backing changed while this task was being created (${detail}); nothing was published. Retry the task.`;
}

/** The mismatch dimension, naming the secondary checkout it concerns (if any). */
export function taskCheckoutMismatchLabel(
  state: Extract<TaskCheckoutPreparationState, { kind: "mismatch" }>
): string {
  return state.checkout === undefined ? state.dimension : `${state.dimension} of ${state.checkout}`;
}

/** User-facing refusal text shared by every producer/consumer gate (one wording, one place). */
export function taskCheckoutNotPreparedMessage(
  state: Exclude<TaskCheckoutPreparationState, { kind: "ready" }>
): string {
  const detail =
    "detail" in state
      ? `: ${state.detail}`
      : state.kind === "mismatch"
        ? ` (${taskCheckoutMismatchLabel(state)})`
        : "";
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
