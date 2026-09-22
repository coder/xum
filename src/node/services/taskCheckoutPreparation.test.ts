import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  validateTaskCheckoutPreparation,
} from "@/node/services/taskCheckoutPreparation";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { createTestProject, saveWorkspaces } from "@/node/services/taskService.testHarness";

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
  const worktree: { type: "worktree"; srcBaseDir: string } = { type: "worktree", srcBaseDir: "" };

  beforeEach(async () => {
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
    await publish([rootRow("root1", projectPath), proven, { ...child, path: projectPath }]);
    expect(await state(config, "lwc05")).toBe("shared-broken");
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
    // Archived intermediate → broken; path-divergent intermediate → broken; missing anchor → broken.
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
    await publish([
      rootRow("root1", projectPath),
      dedicated,
      { ...mid, path: checkout + "-other" },
      leaf,
    ]);
    expect(await state(config, "leaf04")).toBe("shared-broken");
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
});
