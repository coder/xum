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
  classifyTaskCheckoutKind,
  newMaterializationId,
  revalidateTaskCheckoutIdentity,
  validateTaskCheckoutPreparation,
} from "@/node/services/taskCheckoutPreparation";
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
    const identity = await bindTaskCheckoutIdentity({ workspacePath: checkout }, materializationId);
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
    // A second bind must never bless or reuse an existing generation.
    expect(
      await bindTaskCheckoutIdentity({ workspacePath: checkout }, newMaterializationId())
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
  });

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
    const local = taskRow("loc04", projectPath, { runtimeConfig: { type: "local" } });
    await publish([rootRow("root1", projectPath, { runtimeConfig: { type: "local" } }), local]);
    expect(await validateTaskCheckoutPreparation(config, "loc04")).toMatchObject({
      kind: "ready",
      authority: {
        kind: "shared",
        anchorWorkspaceId: "root1",
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
