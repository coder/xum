import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import type { Workspace } from "@/common/types/project";
import {
  TASK_CHECKOUT_PREPARATION_NONCE_FILE,
  assertCurrentTaskCheckoutAuthority,
  bindTaskCheckoutIdentity,
  buildTaskCheckoutPreparation,
  canonicalRuntimeConfigJson,
  claimTaskCheckoutIdentity,
  classifyTaskCheckoutKind,
  newMaterializationId,
  revalidateTaskCheckoutIdentity,
  taskCheckoutNotPreparedMessage,
  validateTaskCheckoutPreparation,
} from "@/node/services/taskCheckoutPreparation";
import { taskCheckoutRefusalMessage } from "@/node/services/taskCheckoutAuthorization";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { createTestProject, saveWorkspaces } from "@/node/services/taskService.testHarness";
import { ContainerManager } from "@/node/multiProject/containerManager";

/**
 * Core preparation proof: physical identity of a dedicated host-local task checkout (real git
 * worktrees), the lock-free validator's states, the synchronous config-only authority assert,
 * and live same-path ancestry for shared tasks. No TaskService here (producers have their own
 * real-seam tests).
 */
const git = (cwd: string, args: string) => execSync(`git ${args}`, { cwd, stdio: "ignore" });
const state = async (config: Config, id: string) =>
  (await validateTaskCheckoutPreparation(config, id)).kind;

describe("taskCheckoutPreparation", () => {
  let rootDir: string;
  let config: Config;
  let projectPath: string;
  /** The second repository of multi-project tasks, created on first use (prepareMultiProject). */
  let secondaryProjectPath: string | undefined;
  const worktree: { type: "worktree"; srcBaseDir: string } = { type: "worktree", srcBaseDir: "" };

  beforeEach(async () => {
    secondaryProjectPath = undefined;
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-prep-core-"));
    config = new Config(rootDir);
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    worktree.srcBaseDir = config.srcDir;
    projectPath = await createTestProject(rootDir, "repo");
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  /** A real dedicated worktree at the name-derived path, its bound proof and its published row. */
  async function prepareDedicated(id: string, extra: Partial<Workspace> = {}) {
    const checkout = path.join(config.srcDir, "repo", `agent_explore_${id}`);
    git(projectPath, `worktree add -q -b ${id} "${checkout}" main`);
    const materializationId = newMaterializationId();
    const claimed = await claimTaskCheckoutIdentity({ workspacePath: checkout }, materializationId);
    if (claimed instanceof Error) throw claimed;
    const identity = await bindTaskCheckoutIdentity(
      { workspacePath: checkout },
      materializationId,
      claimed
    );
    if (identity instanceof Error) throw identity;
    const proof = buildTaskCheckoutPreparation(identity, worktree);
    return {
      checkout,
      proof,
      row: taskRow(id, checkout, { taskCheckoutPreparation: proof, ...extra }),
    };
  }
  /**
   * A real multi-project dedicated task: the primary worktree of `repo` at the row's path and the
   * secondary worktree of `repo2` at its name-derived path, claimed and bound TOGETHER (proof v2).
   */
  async function prepareMultiProject(id: string, extra: Partial<Workspace> = {}) {
    secondaryProjectPath ??= await createTestProject(rootDir, "repo2");
    const name = `agent_explore_${id}`;
    const checkout = path.join(config.srcDir, "repo", name);
    const secondaryCheckout = path.join(config.srcDir, "repo2", name);
    git(projectPath, `worktree add -q -b ${id} "${checkout}" main`);
    git(secondaryProjectPath, `worktree add -q -b ${id} "${secondaryCheckout}" main`);
    const projects = [
      { projectPath, projectName: "repo" },
      { projectPath: secondaryProjectPath, projectName: "repo2" },
    ];
    const target = {
      workspacePath: checkout,
      secondaries: [{ projectPath: secondaryProjectPath, workspacePath: secondaryCheckout }],
      projects,
    };
    const materializationId = newMaterializationId();
    const claimed = await claimTaskCheckoutIdentity(target, materializationId);
    if (claimed instanceof Error) throw claimed;
    const identity = await bindTaskCheckoutIdentity(target, materializationId, claimed);
    if (identity instanceof Error) throw identity;
    const proof = buildTaskCheckoutPreparation(identity, worktree);
    // The execution container the fork creates (one symlink per project).
    const container = await new ContainerManager(config.srcDir).createContainer(name, [
      { projectName: "repo", workspacePath: checkout },
      { projectName: "repo2", workspacePath: secondaryCheckout },
    ]);
    return {
      checkout,
      secondaryCheckout,
      secondaryProjectPath,
      container,
      proof,
      projects,
      row: taskRow(id, checkout, { projects, taskCheckoutPreparation: proof, ...extra }),
    };
  }
  const readNonce = async (adminDir: string) =>
    (
      await fsPromises.readFile(path.join(adminDir, TASK_CHECKOUT_PREPARATION_NONCE_FILE), "utf-8")
    ).trim();
  const taskRow = (id: string, checkout: string, extra: Partial<Workspace> = {}): Workspace => ({
    id,
    name: `agent_explore_${id}`,
    path: checkout,
    createdAt: new Date().toISOString(),
    runtimeConfig: worktree,
    parentWorkspaceId: "root1",
    agentId: "explore",
    agentType: "explore",
    taskStatus: "interrupted",
    ...extra,
  });
  const rootRow = (id: string, checkout: string, extra: Partial<Workspace> = {}): Workspace => ({
    id,
    name: id,
    path: checkout,
    createdAt: new Date().toISOString(),
    runtimeConfig: worktree,
    ...extra,
  });
  async function publish(rows: Workspace[]) {
    await saveWorkspaces(config, projectPath, rows);
  }

  test("classification: root / offhost / shared (isolation none, local runtime) / dedicated", () => {
    expect(classifyTaskCheckoutKind(rootRow("r", projectPath))).toBe("root");
    expect(
      classifyTaskCheckoutKind(
        taskRow("o", "/x", { runtimeConfig: { type: "ssh", host: "h", srcBaseDir: "/s" } })
      )
    ).toBe("offhost");
    expect(classifyTaskCheckoutKind(taskRow("s", "/x", { taskIsolation: "none" }))).toBe("shared");
    expect(classifyTaskCheckoutKind(taskRow("l", "/x", { runtimeConfig: { type: "local" } }))).toBe(
      "shared"
    );
    expect(classifyTaskCheckoutKind(taskRow("d", "/x"))).toBe("dedicated");
    expect(classifyTaskCheckoutKind(taskRow("u", "/x", { runtimeConfig: undefined }))).toBe(
      "dedicated"
    );
    expect(canonicalRuntimeConfigJson({ type: "worktree", srcBaseDir: "/b" })).toBe(
      canonicalRuntimeConfigJson({ srcBaseDir: "/b", type: "worktree" } as never)
    );
  });

  test("legacy worktree rows (`local` + srcBaseDir, an empty string included) are DEDICATED exactly as runtimeFactory dispatches them: unproven refuses as legacy, a real proof validates, a shared child anchors on the persisted path; project-dir `local` stays shared", async () => {
    const legacy = { type: "local" as const, srcBaseDir: config.srcDir };
    const legacyEmpty = { type: "local" as const, srcBaseDir: "" };
    expect(classifyTaskCheckoutKind(taskRow("lw", "/x", { runtimeConfig: legacy }))).toBe(
      "dedicated"
    );
    expect(classifyTaskCheckoutKind(taskRow("lwe", "/x", { runtimeConfig: legacyEmpty }))).toBe(
      "dedicated"
    );
    expect(classifyTaskCheckoutKind(taskRow("l", "/x", { runtimeConfig: { type: "local" } }))).toBe(
      "shared"
    );
    // Unproven legacy-worktree row: refused as legacy — never anchored on the ordinary root by
    // project directory (it executes in its own worktree, not in the project directory).
    const checkout = path.join(config.srcDir, "repo", "agent_explore_lw05");
    git(projectPath, `worktree add -q -b lw05 "${checkout}" main`);
    for (const runtimeConfig of [legacy, legacyEmpty]) {
      await publish([rootRow("root1", projectPath), taskRow("lw05", checkout, { runtimeConfig })]);
      expect(await state(config, "lw05")).toBe("legacy");
    }
    // A real proof bound to the legacy runtime validates as a dedicated authority.
    const materializationId = newMaterializationId();
    const claimed = await claimTaskCheckoutIdentity({ workspacePath: checkout }, materializationId);
    if (claimed instanceof Error) throw claimed;
    const bound = await bindTaskCheckoutIdentity(
      { workspacePath: checkout },
      materializationId,
      claimed
    );
    if (bound instanceof Error) throw bound;
    const proven = taskRow("lw05", checkout, {
      runtimeConfig: legacy,
      taskCheckoutPreparation: buildTaskCheckoutPreparation(bound, legacy),
    });
    await publish([rootRow("root1", projectPath), proven]);
    expect(await validateTaskCheckoutPreparation(config, "lw05")).toMatchObject({
      kind: "ready",
      authority: { kind: "dedicated", anchorPath: checkout },
    });
    // Its shared child executes where its persisted path says (WorktreeRuntime): same-path
    // ancestry to the proven row, not the project directory.
    const child = taskRow("lwc05", checkout, {
      runtimeConfig: legacy,
      parentWorkspaceId: "lw05",
      taskIsolation: "none",
    });
    await publish([rootRow("root1", projectPath), proven, child]);
    expect(await validateTaskCheckoutPreparation(config, "lwc05")).toMatchObject({
      kind: "ready",
      authority: { kind: "shared", anchorWorkspaceId: "lw05", anchorPath: checkout },
    });
    // A shared child persisted at another path (as a pre-#4387 build could leave it) is
    // re-derived by Config normalization (#4387) to its live owner's checkout: authorization and
    // execution then both use that checkout, and the earlier authority stays current.
    const captured = await validateTaskCheckoutPreparation(config, "lwc05");
    if (captured.kind !== "ready") throw new Error("unreachable");
    await publish([rootRow("root1", projectPath), proven, { ...child, path: projectPath }]);
    expect(config.findWorkspace("lwc05")?.workspacePath).toBe(checkout);
    expect(await validateTaskCheckoutPreparation(config, "lwc05")).toMatchObject({
      kind: "ready",
      authority: { kind: "shared", anchorWorkspaceId: "lw05", anchorPath: checkout },
    });
    expect(assertCurrentTaskCheckoutAuthority(config, captured.authority)).toEqual({
      current: true,
    });
  });

  test("scratch rows execute in their OWN path (their metadata projectPath is the row's path, not the `_scratch` bucket): a scratch child anchors on its scratch root", async () => {
    const scratchPath = path.join(rootDir, "scratch", "scr01");
    await fsPromises.mkdir(scratchPath, { recursive: true });
    const scratch = (id: string, extra: Partial<Workspace> = {}): Workspace => ({
      kind: "scratch",
      id,
      name: id,
      path: scratchPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      ...extra,
    });
    await saveWorkspaces(config, SCRATCH_PROJECT_CONFIG_KEY, [
      scratch("scr01"),
      scratch("scrchild01", {
        parentWorkspaceId: "scr01",
        agentId: "explore",
        agentType: "explore",
      }),
    ]);
    expect(await validateTaskCheckoutPreparation(config, "scrchild01")).toMatchObject({
      kind: "ready",
      authority: { kind: "shared", anchorWorkspaceId: "scr01", anchorPath: scratchPath },
    });
  });

  test("bind on a real worktree: proof binds root+admin dev/ino, .git pointer and nonce; validates ready; sync assert agrees", async () => {
    const { checkout, proof, row } = await prepareDedicated("ded01");
    expect(proof.path).toBe(checkout);
    expect(proof.root.ino).toMatch(/^\d+$/);
    expect(proof.gitdir.pointer).toBe(
      await fsPromises.realpath(path.join(projectPath, ".git", "worktrees", `agent_explore_ded01`))
    );
    expect(
      (
        await fsPromises.readFile(
          path.join(proof.gitdir.pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
          "utf-8"
        )
      ).trim()
    ).toBe(proof.materializationId);
    // A second claim/bind must never bless or reuse an existing generation.
    expect(
      await claimTaskCheckoutIdentity({ workspacePath: checkout }, newMaterializationId())
    ).toBeInstanceOf(Error);
    expect(
      await bindTaskCheckoutIdentity({ workspacePath: checkout }, newMaterializationId(), {
        path: checkout,
        realpath: proof.realpath,
        root: proof.root,
        gitdir: proof.gitdir,
      })
    ).toBeInstanceOf(Error);
    await publish([rootRow("root1", projectPath), row]);
    const result = await validateTaskCheckoutPreparation(config, "ded01");
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");
    expect(result.authority).toMatchObject({
      kind: "dedicated",
      materializationId: proof.materializationId,
      authorizationRevision: proof.authorizationRevision,
      anchorWorkspaceId: "ded01",
      anchorPath: checkout,
      ancestry: [],
    });
    expect(assertCurrentTaskCheckoutAuthority(config, result.authority)).toEqual({ current: true });
    // The authority signs EVERY input, not just id/revision: an unchanged revision with a changed
    // proof field, runtime, path or parent is not current; attempt/status changes are irrelevant.
    const republish = (extra: Partial<Workspace>) =>
      publish([rootRow("root1", projectPath), { ...row, ...extra }]);
    await republish({ taskAttemptId: "att_0123456789abcdef", taskStatus: "running" });
    expect(assertCurrentTaskCheckoutAuthority(config, result.authority)).toEqual({ current: true });
    await republish({ taskCheckoutPreparation: { ...proof, realpath: proof.realpath + "-x" } });
    expect(assertCurrentTaskCheckoutAuthority(config, result.authority)).toMatchObject({
      current: false,
    });
    await republish({ runtimeConfig: { type: "worktree", srcBaseDir: "/elsewhere" } });
    expect(assertCurrentTaskCheckoutAuthority(config, result.authority)).toMatchObject({
      current: false,
    });
    await republish({ parentWorkspaceId: undefined });
    expect(assertCurrentTaskCheckoutAuthority(config, result.authority)).toMatchObject({
      current: false,
    });
    await republish({});
    expect(assertCurrentTaskCheckoutAuthority(config, result.authority)).toEqual({ current: true });
    // Later legitimate consent (an override document edit) is NOT part of the identity.
    await fsPromises.mkdir(path.join(checkout, ".xum"), { recursive: true });
    await fsPromises.writeFile(
      path.join(checkout, ".xum", "mcp.local.jsonc"),
      '{"enabledServers":["plugin:0123456789abcdef:x"]}'
    );
    expect(await state(config, "ded01")).toBe("ready");
  });

  test("refusal states: legacy, unsupported (malformed retained), runtime flip, runtime json drift, path drift", async () => {
    const { checkout, proof } = await prepareDedicated("ded02");
    const rows = (extra: Partial<Workspace>) => [
      rootRow("root1", projectPath),
      taskRow("ded02", checkout, extra),
    ];
    await publish(rows({}));
    expect(await state(config, "ded02")).toBe("legacy");
    await publish(rows({ taskCheckoutPreparation: { v: 2, garbage: true } }));
    expect(await state(config, "ded02")).toBe("unsupported");
    await publish(
      rows({
        taskCheckoutPreparation: proof,
        runtimeConfig: { type: "ssh", host: "h", srcBaseDir: "/s" },
      })
    );
    expect(await state(config, "ded02")).toBe("runtime-mismatch");
    await publish(
      rows({
        taskCheckoutPreparation: proof,
        runtimeConfig: { type: "worktree", srcBaseDir: "/elsewhere" },
      })
    );
    expect(await state(config, "ded02")).toBe("runtime-mismatch");
    await publish(rows({ taskCheckoutPreparation: proof, path: checkout + "-moved" }));
    expect((await validateTaskCheckoutPreparation(config, "ded02")) as unknown).toMatchObject({
      kind: "mismatch",
      dimension: "path",
    });
    // Shared rows carry no proof; one present is unsupported, never authorizing.
    await publish(rows({ taskCheckoutPreparation: proof, taskIsolation: "none" }));
    expect(await state(config, "ded02")).toBe("unsupported");
    // Off-host rows are excluded, but a proof on one must mismatch (no escape by flipping the type).
    await publish(rows({ runtimeConfig: { type: "ssh", host: "h", srcBaseDir: "/s" } }));
    expect(await state(config, "ded02")).toBe("excluded-offhost");
    await publish([rootRow("root1", projectPath)]);
    expect(await state(config, "root1")).toBe("excluded-root");
    // A PRESENT proof is inspected before any exemption: a proof-bearing row that lost its
    // parent is unsupported, not an exempt root; a missing row is refused, never exempt.
    await publish([rootRow("root1", projectPath, { taskCheckoutPreparation: proof })]);
    expect(await state(config, "root1")).toBe("unsupported");
    expect(await state(config, "nosuchrow")).toBe("unreadable");
  });

  test("claim before the prune, bind after: a same-path replacement (even with reused inodes) is never bound", async () => {
    const checkout = path.join(config.srcDir, "repo", "agent_explore_swap01");
    git(projectPath, `worktree add -q -b swap01 "${checkout}" main`);
    const id = newMaterializationId();
    const claimed = await claimTaskCheckoutIdentity({ workspacePath: checkout }, id);
    if (claimed instanceof Error) throw claimed;
    const admin = await fsPromises.realpath(
      path.join(projectPath, ".git", "worktrees", "agent_explore_swap01")
    );
    const nonce = path.join(admin, TASK_CHECKOUT_PREPARATION_NONCE_FILE);
    expect((await fsPromises.readFile(nonce, "utf-8")).trim()).toBe(id);
    // Same path, new directory (the older-build cleanup + re-fork shape) between claim and bind.
    // Linux hands the re-created directories the same inodes back often enough that dev/ino
    // identity alone would accept it; the missing nonce is what refuses.
    git(projectPath, `worktree remove --force "${checkout}"`);
    git(projectPath, `worktree add -q -b swap01b "${checkout}" main`);
    expect(await bindTaskCheckoutIdentity({ workspacePath: checkout }, id, claimed)).toBeInstanceOf(
      Error
    );
    expect(
      await fsPromises
        .lstat(nonce)
        .then(() => "present")
        .catch((error: unknown) => (error as { code?: string }).code)
    ).toBe("ENOENT");
    // A checkout claimed under another id never binds under this one; the intact claim binds.
    const other = newMaterializationId();
    const reclaimed = await claimTaskCheckoutIdentity({ workspacePath: checkout }, other);
    if (reclaimed instanceof Error) throw reclaimed;
    expect(
      await bindTaskCheckoutIdentity({ workspacePath: checkout }, id, reclaimed)
    ).toBeInstanceOf(Error);
    expect(await bindTaskCheckoutIdentity({ workspacePath: checkout }, other, reclaimed)).toEqual({
      ...reclaimed,
      materializationId: other,
    });
  }, 20_000);

  test("physical identity: same-path re-add, nonce edit, missing, special .git file, .git directory all refuse", async () => {
    const { checkout, proof, row } = await prepareDedicated("ded03");
    await publish([rootRow("root1", projectPath), row]);
    expect(await state(config, "ded03")).toBe("ready");
    // Nonce edited: mismatch(nonce).
    const nonce = path.join(proof.gitdir.pointer, TASK_CHECKOUT_PREPARATION_NONCE_FILE);
    await fsPromises.writeFile(nonce, "mat_ffffffffffffffff\n");
    expect(await validateTaskCheckoutPreparation(config, "ded03")).toMatchObject({
      kind: "mismatch",
      dimension: "nonce",
    });
    await fsPromises.writeFile(nonce, `${proof.materializationId}\n`);
    expect(await state(config, "ded03")).toBe("ready");
    // Replace the directory at the same path through git (the older-build cleanup + re-fork shape).
    git(projectPath, `worktree remove --force "${checkout}"`);
    expect(await state(config, "ded03")).toBe("missing");
    git(projectPath, `worktree add -q -b ded03b "${checkout}" main`);
    const swapped = await validateTaskCheckoutPreparation(config, "ded03");
    expect(swapped.kind).toBe("mismatch"); // root/admin inode or nonce: never ready
    expect(await revalidateTaskCheckoutIdentity(proof)).toMatchObject({ ok: false });
    // `.git` replaced by a FIFO: refused without blocking; `.git` as a directory: refused.
    git(projectPath, `worktree remove --force "${checkout}"`);
    await fsPromises.mkdir(checkout, { recursive: true });
    execSync(`mkfifo "${path.join(checkout, ".git")}"`);
    expect(await validateTaskCheckoutPreparation(config, "ded03")).toMatchObject({
      kind: "mismatch",
    });
    await fsPromises.rm(path.join(checkout, ".git"));
    await fsPromises.mkdir(path.join(checkout, ".git"));
    expect(await validateTaskCheckoutPreparation(config, "ded03")).toMatchObject({
      kind: "mismatch",
    });
  }, 20_000);

  test("a stalled checkout filesystem cannot hang the validator: the physical checks are bounded and fail closed (dedicated and root-anchored shared)", async () => {
    const { checkout, row } = await prepareDedicated("ded09");
    const localRoot = rootRow("root1", projectPath, { runtimeConfig: { type: "local" } });
    const shared = taskRow("loc09", projectPath, { runtimeConfig: { type: "local" } });
    await publish([localRoot, row, shared]);
    expect(await state(config, "ded09")).toBe("ready");
    expect(await state(config, "loc09")).toBe("ready");
    // A stalled FUSE/NFS mount: stats of either execution directory never answer.
    const stat = fsPromises.stat;
    const stalled = new Set([checkout, projectPath]);
    const probe = spyOn(fsPromises, "stat").mockImplementation(((
      ...args: Parameters<typeof fsPromises.stat>
    ) =>
      stalled.has(String(args[0]))
        ? new Promise(() => undefined)
        : stat(...args)) as typeof fsPromises.stat);
    try {
      for (const id of ["ded09", "loc09"]) {
        const refused = await validateTaskCheckoutPreparation(config, id, { timeoutMs: 50 });
        expect(refused.kind).toBe("unreadable");
        expect("detail" in refused && refused.detail).toContain("timed out");
      }
      expect(probe).toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
    expect(await state(config, "ded09")).toBe("ready");
  }, 10_000);

  test("the direct identity revalidation (the producer's final pre-publication check) is bounded too and fails closed", async () => {
    const { checkout, proof } = await prepareDedicated("ded10");
    expect(await revalidateTaskCheckoutIdentity(proof)).toEqual({ ok: true });
    const stat = fsPromises.stat;
    const probe = spyOn(fsPromises, "stat").mockImplementation(((
      ...args: Parameters<typeof fsPromises.stat>
    ) =>
      String(args[0]) === checkout
        ? new Promise(() => undefined)
        : stat(...args)) as typeof fsPromises.stat);
    try {
      const refused = await revalidateTaskCheckoutIdentity(proof, { timeoutMs: 50 });
      expect(refused).toMatchObject({ ok: false, state: { kind: "unreadable" } });
      expect(JSON.stringify(refused)).toContain("timed out");
    } finally {
      probe.mockRestore();
    }
  }, 10_000);

  test("a project-dir local task of a multi-project parent anchors on the directory Config resolves for the parent (its primary project), not the `_multi` bucket key", async () => {
    const multiRoot = rootRow("multi1", projectPath, {
      runtimeConfig: { type: "local" },
      projects: [{ projectPath, projectName: "repo" }],
    });
    const child = taskRow("mloc1", projectPath, {
      parentWorkspaceId: "multi1",
      runtimeConfig: { type: "local" },
      projects: [{ projectPath, projectName: "repo" }],
    });
    await saveWorkspaces(config, projectPath, [child], {
      extraProjects: [[MULTI_PROJECT_CONFIG_KEY, { workspaces: [multiRoot] }]],
    });
    const ready = await validateTaskCheckoutPreparation(config, "mloc1");
    expect(ready).toMatchObject({
      kind: "ready",
      authority: { kind: "shared", anchorWorkspaceId: "multi1", anchorPath: projectPath },
    });
    if (ready.kind !== "ready") throw new Error("unreachable");
    // The parent's primary project is an input of the derivation, so the synchronous fence
    // must notice when it changes.
    const elsewhere = path.join(rootDir, "elsewhere");
    await saveWorkspaces(config, projectPath, [child], {
      extraProjects: [
        [
          MULTI_PROJECT_CONFIG_KEY,
          {
            workspaces: [
              { ...multiRoot, projects: [{ projectPath: elsewhere, projectName: "x" }] },
            ],
          },
        ],
      ],
    });
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toMatchObject({
      current: false,
    });
    expect(await state(config, "mloc1")).toBe("shared-broken");
  });

  test("shared ancestry: intermediates matter; anchor must be a ready dedicated task or a live ordinary root", async () => {
    const { checkout, row: dedicated } = await prepareDedicated("ded04");
    const mid = taskRow("mid04", checkout, { parentWorkspaceId: "ded04", taskIsolation: "none" });
    const leaf = taskRow("leaf04", checkout, { parentWorkspaceId: "mid04", taskIsolation: "none" });
    await publish([rootRow("root1", projectPath), dedicated, mid, leaf]);
    const ready = await validateTaskCheckoutPreparation(config, "leaf04");
    expect(ready).toMatchObject({
      kind: "ready",
      authority: {
        kind: "shared",
        anchorWorkspaceId: "ded04",
        anchorPath: checkout,
        ancestry: ["mid04"],
      },
    });
    if (ready.kind !== "ready") throw new Error("unreachable");
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toEqual({ current: true });
    // Archived intermediate → broken; missing anchor → broken.
    await publish([
      rootRow("root1", projectPath),
      dedicated,
      { ...mid, archivedAt: new Date().toISOString() },
      leaf,
    ]);
    expect(await state(config, "leaf04")).toBe("shared-broken");
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toMatchObject({
      current: false,
    });
    // A path-divergent intermediate cannot persist: Config normalization (#4387) re-derives it
    // to the live owner's checkout, so the chain authorizes and executes in that checkout again
    // (the validator's divergence branch stays as the defense for rows normalization skips).
    await publish([
      rootRow("root1", projectPath),
      dedicated,
      { ...mid, path: checkout + "-other" },
      leaf,
    ]);
    expect(config.findWorkspace("mid04")?.workspacePath).toBe(checkout);
    expect(config.findWorkspace("leaf04")?.workspacePath).toBe(checkout);
    expect(await validateTaskCheckoutPreparation(config, "leaf04")).toMatchObject({
      kind: "ready",
      authority: {
        kind: "shared",
        anchorWorkspaceId: "ded04",
        anchorPath: checkout,
        ancestry: ["mid04"],
      },
    });
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toEqual({ current: true });
    await publish([rootRow("root1", projectPath), mid, leaf]);
    expect(await state(config, "leaf04")).toBe("shared-broken");
    // Anchor dedicated but legacy (no proof) → broken; anchor ordinary root → ready with empty revision.
    await publish([rootRow("root1", projectPath), taskRow("ded04", checkout), mid, leaf]);
    expect(await state(config, "leaf04")).toBe("shared-broken");
    // LocalRuntime rows execute in the PROJECT directory whatever their persisted path says
    // (LocalRuntime.getWorkspacePath), so a local child anchors on its local root by project.
    const local = taskRow("loc04", projectPath, { runtimeConfig: { type: "local" } });
    await publish([
      rootRow("root1", path.join(projectPath, "root"), { runtimeConfig: { type: "local" } }),
      local,
    ]);
    expect(await validateTaskCheckoutPreparation(config, "loc04")).toMatchObject({
      kind: "ready",
      authority: {
        kind: "shared",
        anchorWorkspaceId: "root1",
        anchorPath: projectPath,
        authorizationRevision: "",
        ancestry: [],
      },
    });
    // Archived root anchor → broken.
    await publish([
      rootRow("root1", projectPath, {
        runtimeConfig: { type: "local" },
        archivedAt: "2026-01-01T00:00:00Z",
      }),
      local,
    ]);
    expect(await state(config, "loc04")).toBe("shared-broken");
  });

  test("multi-project dedicated task (proof v2): every checkout is claimed and bound with the generation's nonce; ready; a shared child anchored on it derives; secondary fields are signed", async () => {
    const { checkout, secondaryCheckout, proof, projects, row } = await prepareMultiProject("mp01");
    const repo2 = secondaryProjectPath!;
    expect(proof).toMatchObject({
      v: 2,
      path: checkout,
      secondaries: [{ projectPath: repo2, path: secondaryCheckout }],
    });
    if (proof.v !== 2) throw new Error("unreachable");
    const [secondary] = proof.secondaries;
    expect(secondary.gitdir.pointer).toBe(
      await fsPromises.realpath(path.join(repo2, ".git", "worktrees", "agent_explore_mp01"))
    );
    expect(await readNonce(proof.gitdir.pointer)).toBe(proof.materializationId);
    expect(await readNonce(secondary.gitdir.pointer)).toBe(proof.materializationId);
    const shared = taskRow("mp01s", checkout, {
      parentWorkspaceId: "mp01",
      taskIsolation: "none",
      projects,
    });
    await publish([rootRow("root1", projectPath), row, shared]);
    const ready = await validateTaskCheckoutPreparation(config, "mp01");
    expect(ready).toMatchObject({
      kind: "ready",
      authority: { kind: "dedicated", anchorPath: checkout },
    });
    if (ready.kind !== "ready") throw new Error("unreachable");
    expect(await validateTaskCheckoutPreparation(config, "mp01s")).toMatchObject({
      kind: "ready",
      authority: { kind: "shared", anchorWorkspaceId: "mp01", anchorPath: checkout },
    });
    // A secondary identity is part of the signed proof: a changed secondary field under the same
    // revision is not current, and it no longer validates.
    const drifted = {
      ...proof,
      secondaries: [{ ...secondary, realpath: `${secondary.realpath}-x` }],
    };
    await publish([rootRow("root1", projectPath), { ...row, taskCheckoutPreparation: drifted }]);
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toMatchObject({
      current: false,
    });
    expect(await validateTaskCheckoutPreparation(config, "mp01")).toEqual({
      kind: "mismatch",
      dimension: "realpath",
      checkout: secondaryCheckout,
    });
  }, 20_000);

  test("a replaced or missing secondary checkout refuses, naming that checkout (validator and the producer's revalidation); a proof that does not cover the row's projects mismatches", async () => {
    const { secondaryCheckout, proof, projects, row } = await prepareMultiProject("mp02");
    const repo2 = secondaryProjectPath!;
    if (proof.v !== 2) throw new Error("unreachable");
    await publish([rootRow("root1", projectPath), row]);
    expect(await state(config, "mp02")).toBe("ready");
    expect(await revalidateTaskCheckoutIdentity(proof)).toEqual({ ok: true });
    // Nonce edited in the SECONDARY admin dir only.
    const secondaryNonce = path.join(
      proof.secondaries[0].gitdir.pointer,
      TASK_CHECKOUT_PREPARATION_NONCE_FILE
    );
    await fsPromises.writeFile(secondaryNonce, "mat_ffffffffffffffff\n");
    expect(await validateTaskCheckoutPreparation(config, "mp02")).toEqual({
      kind: "mismatch",
      dimension: "nonce",
      checkout: secondaryCheckout,
    });
    await fsPromises.writeFile(secondaryNonce, `${proof.materializationId}\n`);
    expect(await state(config, "mp02")).toBe("ready");
    // Missing: the secondary checkout AND its admin dir are gone (the primary is intact).
    git(repo2, `worktree remove --force "${secondaryCheckout}"`);
    const missing = await validateTaskCheckoutPreparation(config, "mp02");
    expect(missing).toEqual({
      kind: "mismatch",
      dimension: "missing",
      checkout: secondaryCheckout,
    });
    expect(await revalidateTaskCheckoutIdentity(proof)).toEqual({ ok: false, state: missing });
    if (missing.kind !== "mismatch") throw new Error("unreachable");
    expect(taskCheckoutNotPreparedMessage(missing)).toContain(secondaryCheckout);
    expect(taskCheckoutRefusalMessage("mp02", missing)).toContain(secondaryCheckout);
    // Replaced: same path, a new worktree (root/admin inode or nonce: never ready).
    git(repo2, `worktree add -q -b mp02b "${secondaryCheckout}" main`);
    expect(await validateTaskCheckoutPreparation(config, "mp02")).toMatchObject({
      kind: "mismatch",
      checkout: secondaryCheckout,
    });
    expect(await revalidateTaskCheckoutIdentity(proof)).toMatchObject({
      ok: false,
      state: { kind: "mismatch", checkout: secondaryCheckout },
    });
    // Config-only: the row lists a project the proof does not bind, or a different order.
    const extraProject = { projectPath: path.join(rootDir, "repo3"), projectName: "repo3" };
    await publish([
      rootRow("root1", projectPath),
      { ...row, projects: [...projects, extraProject] },
    ]);
    expect(await validateTaskCheckoutPreparation(config, "mp02")).toEqual({
      kind: "mismatch",
      dimension: "projects",
    });
    await publish([rootRow("root1", projectPath), { ...row, projects: [...projects].reverse() }]);
    expect(await validateTaskCheckoutPreparation(config, "mp02")).toEqual({
      kind: "mismatch",
      dimension: "projects",
    });
  }, 20_000);

  test("a v2 proof binds the full project list the runtime consumes: a changed primary project or project name refuses (mismatch projects); the unchanged list is ready", async () => {
    const { proof, projects, row } = await prepareMultiProject("mp07");
    if (proof.v !== 2) throw new Error("unreachable");
    // The proof carries exactly the row's list (paths AND names, primary first), and it
    // survives a JSON round trip unchanged (the producer's persistence check compares so).
    expect(proof.projects).toEqual(projects);
    expect(JSON.parse(JSON.stringify(proof))).toEqual(proof);
    const [primary, secondary] = projects;
    const variants: Array<[string, Workspace["projects"]]> = [
      [
        "another primary repository",
        [{ ...primary, projectPath: path.join(rootDir, "other") }, secondary],
      ],
      ["a renamed primary project", [{ ...primary, projectName: "renamed" }, secondary]],
      ["a renamed secondary project", [primary, { ...secondary, projectName: "renamed" }]],
    ];
    for (const [label, changed] of variants) {
      await publish([rootRow("root1", projectPath), { ...row, projects: changed }]);
      expect({ label, state: await validateTaskCheckoutPreparation(config, "mp07") }).toEqual({
        label,
        state: { kind: "mismatch", dimension: "projects" },
      });
    }
    // A proof whose secondaries disagree with its own project list is refused too, and a v2
    // value without the list (an earlier development shape) is unsupported.
    await publish([
      rootRow("root1", projectPath),
      {
        ...row,
        taskCheckoutPreparation: {
          ...proof,
          projects: [primary, { ...secondary, projectPath: path.join(rootDir, "other") }],
        },
        projects: [primary, { ...secondary, projectPath: path.join(rootDir, "other") }],
      },
    ]);
    expect(await validateTaskCheckoutPreparation(config, "mp07")).toEqual({
      kind: "mismatch",
      dimension: "projects",
    });
    const { projects: _dropped, ...withoutList } = proof;
    await publish([
      rootRow("root1", projectPath),
      { ...row, taskCheckoutPreparation: withoutList },
    ]);
    expect(await state(config, "mp07")).toBe("unsupported");
    await publish([rootRow("root1", projectPath), row]);
    expect(await state(config, "mp07")).toBe("ready");
  }, 20_000);

  test("every v2 identity must be its project's name-derived checkout, and no two may be one directory: a copied-identity secondary, an aliased project and a renamed row refuse; the rename invalidates the authority", async () => {
    const { proof, projects, row } = await prepareMultiProject("mp08");
    if (proof.v !== 2) throw new Error("unreachable");
    const root = rootRow("root1", projectPath);
    await publish([root, row]);
    const ready = await validateTaskCheckoutPreparation(config, "mp08");
    if (ready.kind !== "ready") throw new Error(`expected ready, got ${ready.kind}`);
    const primaryIdentity = {
      path: proof.path,
      realpath: proof.realpath,
      root: proof.root,
      gitdir: proof.gitdir,
    };
    const [secondary] = proof.secondaries;
    // Every checkout shares the generation nonce, so a secondary entry copying the primary's
    // identity passes the physical checks; the project's own derived checkout goes unproven.
    await publish([
      root,
      {
        ...row,
        taskCheckoutPreparation: {
          ...proof,
          secondaries: [{ projectPath: secondary.projectPath, ...primaryIdentity }],
        },
      },
    ]);
    expect(await validateTaskCheckoutPreparation(config, "mp08")).toEqual({
      kind: "mismatch",
      dimension: "path",
      checkout: secondary.path,
    });
    // Two projects whose checkouts derive to one directory (same basename) cannot share an
    // identity either: each project needs a checkout of its own.
    const aliasProject = {
      projectPath: path.join(rootDir, "other", "repo"),
      projectName: "repo-2",
    };
    await publish([
      root,
      {
        ...row,
        projects: [projects[0], aliasProject],
        taskCheckoutPreparation: {
          ...proof,
          projects: [projects[0], aliasProject],
          secondaries: [{ projectPath: aliasProject.projectPath, ...primaryIdentity }],
        },
      },
    ]);
    expect(await validateTaskCheckoutPreparation(config, "mp08")).toEqual({
      kind: "mismatch",
      dimension: "duplicate",
    });
    // Execution derives every checkout (and the container) from the row's name.
    await publish([root, { ...row, name: "agent_explore_renamed" }]);
    expect(await validateTaskCheckoutPreparation(config, "mp08")).toMatchObject({
      kind: "mismatch",
      dimension: "path",
    });
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toMatchObject({
      current: false,
    });
    await publish([root, row]);
    expect(assertCurrentTaskCheckoutAuthority(config, ready.authority)).toEqual({ current: true });
  }, 20_000);

  test("the multi-project container must map every project to its proven checkout (validated, never rebuilt): a deleted, repointed or replaced link and a container that is a symlink or missing refuse; extra entries are ignored; intact is ready", async () => {
    const { checkout, secondaryCheckout, container, projects, row } =
      await prepareMultiProject("mp09");
    const root = rootRow("root1", projectPath);
    const shared = taskRow("mp09s", checkout, {
      parentWorkspaceId: "mp09",
      taskIsolation: "none",
      projects,
    });
    await publish([root, row, shared]);
    expect(await state(config, "mp09")).toBe("ready");
    // An entry that maps no project does not change what execution reaches through the
    // project entries (like an in-place edit inside a validated checkout).
    await fsPromises.symlink(os.tmpdir(), path.join(container, "extra"));
    expect(await state(config, "mp09")).toBe("ready");
    const link = path.join(container, "repo2");
    const linkRefusal = { kind: "mismatch", dimension: "container-link", checkout: link } as const;
    await fsPromises.rm(link);
    expect(await validateTaskCheckoutPreparation(config, "mp09")).toEqual(linkRefusal);
    await fsPromises.symlink(checkout, link);
    expect(await validateTaskCheckoutPreparation(config, "mp09")).toEqual(linkRefusal);
    await fsPromises.rm(link);
    await fsPromises.mkdir(link);
    expect(await validateTaskCheckoutPreparation(config, "mp09")).toEqual(linkRefusal);
    // The anchor is not ready, so a shared child anchored on it is not either.
    expect(await state(config, "mp09s")).toBe("shared-broken");
    await fsPromises.rm(link, { recursive: true });
    await fsPromises.symlink(secondaryCheckout, link);
    expect(await state(config, "mp09")).toBe("ready");
    expect(await state(config, "mp09s")).toBe("ready");
    // The container itself must be a real directory: a symlink to an identical tree refuses.
    const moved = `${container}-moved`;
    await fsPromises.rename(container, moved);
    await fsPromises.symlink(moved, container);
    const containerRefusal = {
      kind: "mismatch",
      dimension: "container",
      checkout: container,
    } as const;
    expect(await validateTaskCheckoutPreparation(config, "mp09")).toEqual(containerRefusal);
    await fsPromises.rm(container);
    expect(await validateTaskCheckoutPreparation(config, "mp09")).toEqual(containerRefusal);
    await fsPromises.rename(moved, container);
    expect(await state(config, "mp09")).toBe("ready");
  }, 20_000);

  test("a v1 proof cannot prove a multi-project task's secondary checkouts (unsupported); single-project v1 stays ready; a v2 proof on a single-project row and unknown or malformed versions refuse", async () => {
    const { proof, row } = await prepareDedicated("mp03");
    expect(proof.v).toBe(1);
    await publish([rootRow("root1", projectPath), row]);
    expect(await state(config, "mp03")).toBe("ready");
    // A row listing only its primary project is single-project: v1 is complete for it.
    await publish([
      rootRow("root1", projectPath),
      { ...row, projects: [{ projectPath, projectName: "repo" }] },
    ]);
    expect(await state(config, "mp03")).toBe("ready");
    const multi = await prepareMultiProject("mp04");
    await publish([rootRow("root1", projectPath), { ...row, projects: multi.projects }]);
    expect(await validateTaskCheckoutPreparation(config, "mp03")).toMatchObject({
      kind: "unsupported",
    });
    await publish([rootRow("root1", projectPath), { ...multi.row, projects: undefined }]);
    expect(await validateTaskCheckoutPreparation(config, "mp04")).toEqual({
      kind: "mismatch",
      dimension: "projects",
    });
    for (const malformed of [
      { ...multi.proof, v: 3 },
      { ...multi.proof, secondaries: [] },
      { ...multi.proof, v: 1 },
    ]) {
      await publish([
        rootRow("root1", projectPath),
        { ...multi.row, taskCheckoutPreparation: malformed },
      ]);
      // A v1-shaped value with extra fields on a multi-project row is still v1: unsupported.
      expect(await state(config, "mp04")).toBe("unsupported");
    }
    await publish([rootRow("root1", projectPath), multi.row]);
    expect(await state(config, "mp04")).toBe("ready");
  }, 20_000);

  test("the claim/bind protocol covers every secondary: an already-claimed secondary refuses the whole claim, and a secondary replaced between claim and bind is never bound", async () => {
    secondaryProjectPath ??= await createTestProject(rootDir, "repo2");
    const repo2 = secondaryProjectPath;
    const setUp = (id: string) => {
      const checkout = path.join(config.srcDir, "repo", `agent_explore_${id}`);
      const secondaryCheckout = path.join(config.srcDir, "repo2", `agent_explore_${id}`);
      git(projectPath, `worktree add -q -b ${id} "${checkout}" main`);
      git(repo2, `worktree add -q -b ${id} "${secondaryCheckout}" main`);
      return {
        secondaryCheckout,
        secondaryAdmin: path.join(repo2, ".git", "worktrees", `agent_explore_${id}`),
        target: {
          workspacePath: checkout,
          secondaries: [{ projectPath: repo2, workspacePath: secondaryCheckout }],
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: repo2, projectName: "repo2" },
          ],
        },
      };
    };
    const planted = setUp("mp05");
    await fsPromises.writeFile(
      path.join(planted.secondaryAdmin, TASK_CHECKOUT_PREPARATION_NONCE_FILE),
      "mat_0123456789abcdef\n"
    );
    const refusedClaim = await claimTaskCheckoutIdentity(planted.target, newMaterializationId());
    if (!(refusedClaim instanceof Error)) throw new Error("the claim must refuse");
    expect(refusedClaim.message).toContain(planted.secondaryCheckout);

    const swapped = setUp("mp06");
    const id = newMaterializationId();
    const claimed = await claimTaskCheckoutIdentity(swapped.target, id);
    if (claimed instanceof Error) throw claimed;
    expect(await readNonce(await fsPromises.realpath(swapped.secondaryAdmin))).toBe(id);
    git(repo2, `worktree remove --force "${swapped.secondaryCheckout}"`);
    git(repo2, `worktree add -q -b mp06b "${swapped.secondaryCheckout}" main`);
    const refusedBind = await bindTaskCheckoutIdentity(swapped.target, id, claimed);
    if (!(refusedBind instanceof Error)) throw new Error("the bind must refuse");
    expect(refusedBind.message).toContain(swapped.secondaryCheckout);
  }, 20_000);
});
