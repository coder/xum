/**
 * create() with nameGeneration: a worktree workspace opens under its provisional "workspace-N"
 * name while the backend names it, and only its git branch is renamed, before the init hook.
 * Real Config, real git worktrees and init hook (an isolated GIT_CONFIG_GLOBAL); the naming model
 * is the only fake.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WORKSPACE_NAME_GENERATION_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { Err, Ok, type Result } from "@/common/types/result";
import type { NameGenerationError } from "@/common/types/errors";
import type { WorkspaceService } from "./workspaceService";
import * as workspaceTitleGenerator from "./workspaceTitleGenerator";
import {
  createDeferred,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

type IdentityResult = Result<
  workspaceTitleGenerator.GenerateWorkspaceIdentityResult,
  NameGenerationError
>;

const GENERATED: IdentityResult = Ok({
  name: "sidebar-k3m9",
  title: "Fix sidebar layout",
  modelUsed: "anthropic:claude-haiku-4-5",
});
const NAME_REQUEST = { message: "Fix the sidebar layout", candidates: [] };
// Records the branch the init hook sees and the workspace name it is given.
const INIT_HOOK =
  '#!/usr/bin/env bash\necho "$(git branch --show-current) $XUM_WORKSPACE_NAME" > .init-observed\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
  return git(repoPath, "branch", "--list", branch) !== "";
}

async function initRepo(repoPath: string): Promise<void> {
  await fs.mkdir(path.join(repoPath, ".xum"), { recursive: true });
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.email", "test@example.com");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(repoPath, ".xum", "init"), INIT_HOOK, { mode: 0o755 });
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "init");
}

// Bun implements advanceTimersByTime, but its jest typings omit it.
const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

/** Polls with setImmediate, which Bun's fake timers leave real. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("create() with nameGeneration", () => {
  let harness: WorkspaceServiceHarness;
  let service: WorkspaceService;
  let projectPath: string;
  let srcBaseDir: string;
  let gitHome: string;
  let generateIdentity: ReturnType<
    typeof spyOn<typeof workspaceTitleGenerator, "generateWorkspaceIdentity">
  >;
  const savedGitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };

  beforeEach(async () => {
    gitHome = await fs.mkdtemp(path.join(os.tmpdir(), "creation-naming-git-"));
    await fs.writeFile(path.join(gitHome, "gitconfig"), "");
    process.env.GIT_CONFIG_GLOBAL = path.join(gitHome, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    harness = await createWorkspaceServiceHarness({
      aiServiceOverrides: { isStreaming: mock(() => false) },
    });
    service = harness.service;
    projectPath = path.join(harness.rootDir, "project");
    srcBaseDir = path.join(harness.rootDir, "src");
    await initRepo(projectPath);
    await harness.config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], trusted: true });
      return cfg;
    });
    // sendMessage's recency write is not under test and would race harness cleanup.
    spyOn(harness.extensionMetadata, "updateRecency").mockImplementation((_id, recency) =>
      Promise.resolve({
        recency: recency ?? Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      })
    );
    generateIdentity = spyOn(workspaceTitleGenerator, "generateWorkspaceIdentity");
  });

  afterEach(async () => {
    mock.restore();
    await harness.cleanup();
    for (const [key, value] of Object.entries(savedGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(gitHome, { recursive: true, force: true });
  });

  /** create() as the creation composer calls it; awaitMaterialization picks the eager checkout. */
  async function createNamed(awaitMaterialization = false) {
    const result = await service.create(
      projectPath,
      undefined,
      "main",
      undefined,
      { type: "worktree", srcBaseDir },
      undefined,
      undefined,
      undefined,
      { nameGeneration: NAME_REQUEST, ...(awaitMaterialization && { awaitMaterialization }) }
    );
    if (!result.success) throw new Error(result.error);
    const { metadata } = result.data;
    return { id: metadata.id, name: metadata.name, path: metadata.namedWorkspacePath };
  }

  const entry = (id: string) =>
    harness.config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === id);
  const initLines = (id: string) =>
    harness.initStateManager.getInitState(id)?.lines.map((line) => line.line) ?? [];
  const readObserved = (workspacePath: string) =>
    fs.readFile(path.join(workspacePath, ".init-observed"), "utf8").then((text) => text.trim());
  const observedExists = (workspacePath: string) =>
    fs.access(path.join(workspacePath, ".init-observed")).then(
      () => true,
      () => false
    );
  const waitForNamingStep = (id: string) => until(() => initLines(id).includes("Naming branch..."));
  /** The abort signal create() handed the naming model. */
  const namingSignal = () => generateIdentity.mock.calls[0]?.[5];

  function sendFirstMessage(workspaceId: string) {
    const session = service.getOrCreateSession(workspaceId);
    spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
    return service.sendMessage(workspaceId, "Fix the sidebar layout", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
  }

  test.each([
    { label: "deferred checkout", awaitMaterialization: false },
    { label: "eager checkout", awaitMaterialization: true },
  ])(
    "$label: opens at once and renames only the branch before the init hook",
    async (c) => {
      const naming = createDeferred<IdentityResult>();
      generateIdentity.mockImplementation(() => naming.promise);

      const created = await createNamed(c.awaitMaterialization);
      expect(created.name).toMatch(/^workspace-\d+$/);
      expect(entry(created.id)?.pendingAutoTitle).toBe(true);
      expect(entry(created.id)?.title).toBeUndefined();

      await waitForNamingStep(created.id);
      expect(await observedExists(created.path)).toBe(false);
      // A first message sent while the backend names the workspace starts no second request.
      expect((await sendFirstMessage(created.id)).success).toBe(true);

      naming.resolve(GENERATED);
      await harness.initStateManager.waitForInit(created.id);
      expect(await readObserved(created.path)).toBe(`sidebar-k3m9 ${created.name}`);
      expect(branchExists(projectPath, created.name)).toBe(false);
      await until(() => entry(created.id)?.title === "Fix sidebar layout");
      expect(entry(created.id)?.pendingAutoTitle).toBeUndefined();
      // Only the branch moved: the workspace keeps its name and directory.
      expect(entry(created.id)?.name).toBe(created.name);
      expect(path.basename(created.path)).toBe(created.name);
      // Checked last: a second naming request would start after the send resolved.
      expect(generateIdentity).toHaveBeenCalledTimes(1);
    },
    30_000
  );

  test("a naming failure keeps the branch and leaves the title to the next message", async () => {
    generateIdentity.mockResolvedValueOnce(Err({ type: "unknown", raw: "model unavailable" }));

    const created = await createNamed();
    await harness.initStateManager.waitForInit(created.id);
    expect(await readObserved(created.path)).toBe(`${created.name} ${created.name}`);
    expect(entry(created.id)?.pendingAutoTitle).toBe(true);

    generateIdentity.mockResolvedValueOnce(GENERATED);
    expect((await sendFirstMessage(created.id)).success).toBe(true);
    await until(() => entry(created.id)?.title === "Fix sidebar layout");
    expect(generateIdentity).toHaveBeenCalledTimes(2);
    expect(branchExists(projectPath, created.name)).toBe(true);
  }, 30_000);

  test("a naming timeout stops the request and keeps the branch, and the init runs", async () => {
    generateIdentity.mockImplementation(() => new Promise<IdentityResult>(() => undefined));

    fakeTimers.useFakeTimers();
    let created: Awaited<ReturnType<typeof createNamed>>;
    try {
      created = await createNamed();
      await waitForNamingStep(created.id);
      await until(() => generateIdentity.mock.calls.length === 1);
      fakeTimers.advanceTimersByTime(WORKSPACE_NAME_GENERATION_TIMEOUT_MS);
    } finally {
      fakeTimers.useRealTimers();
    }
    await harness.initStateManager.waitForInit(created.id);

    expect(namingSignal()?.aborted).toBe(true);
    expect(await readObserved(created.path)).toBe(`${created.name} ${created.name}`);
    expect(entry(created.id)?.pendingAutoTitle).toBe(true);
  }, 30_000);

  test("a creation that fails after naming started stops the naming request", async () => {
    generateIdentity.mockImplementation(() => new Promise<IdentityResult>(() => undefined));

    const result = await service.create(
      projectPath,
      undefined,
      "no-such-trunk",
      undefined,
      { type: "worktree", srcBaseDir },
      undefined,
      undefined,
      undefined,
      { nameGeneration: NAME_REQUEST }
    );
    expect(result.success).toBe(false);
    await until(() => generateIdentity.mock.calls.length === 1);
    expect(namingSignal()?.aborted).toBe(true);
  }, 30_000);

  test("a title the user sets while naming runs is kept", async () => {
    const naming = createDeferred<IdentityResult>();
    generateIdentity.mockImplementation(() => naming.promise);

    const created = await createNamed();
    await waitForNamingStep(created.id);
    expect((await service.updateTitle(created.id, "My own title")).success).toBe(true);
    naming.resolve(GENERATED);
    await harness.initStateManager.waitForInit(created.id);

    expect(entry(created.id)?.title).toBe("My own title");
    expect(branchExists(projectPath, "sidebar-k3m9")).toBe(true);
  }, 30_000);

  test("removal during the naming wait settles without a rename and leaves no branch", async () => {
    // Never answers: removal must not wait for the naming model.
    generateIdentity.mockImplementation(() => new Promise<IdentityResult>(() => undefined));

    const created = await createNamed();
    await waitForNamingStep(created.id);
    const removeStartedAt = Date.now();
    const removed = await service.remove(created.id, true);
    expect(removed.success).toBe(true);
    // Removal awaits the init; without the abort it would wait out the naming deadline.
    expect(Date.now() - removeStartedAt).toBeLessThan(WORKSPACE_NAME_GENERATION_TIMEOUT_MS);

    expect(branchExists(projectPath, created.name)).toBe(false);
    expect(branchExists(projectPath, "sidebar-k3m9")).toBe(false);
    expect(entry(created.id)).toBeUndefined();
  }, 30_000);

  test("archive during the naming wait cancels the naming and keeps the branch", async () => {
    const naming = createDeferred<IdentityResult>();
    generateIdentity.mockImplementation(() => naming.promise);

    const created = await createNamed();
    await waitForNamingStep(created.id);
    const archived = await service.archive(created.id);
    expect(archived.success).toBe(true);
    expect(namingSignal()?.aborted).toBe(true);

    // A name arriving after the archive applies nothing; the next message titles it instead.
    naming.resolve(GENERATED);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entry(created.id)?.title).toBeUndefined();
    expect(entry(created.id)?.pendingAutoTitle).toBe(true);
    expect(branchExists(projectPath, created.name)).toBe(true);
    expect(branchExists(projectPath, "sidebar-k3m9")).toBe(false);
  }, 30_000);

  test.each([
    { label: "a branch name", branchName: "feature", title: undefined, type: "worktree" },
    { label: "a title", branchName: undefined, title: "Title", type: "worktree" },
    { label: "a non-worktree runtime", branchName: undefined, title: undefined, type: "local" },
  ] as const)("refuses nameGeneration with $label", async (c) => {
    const result = await service.create(
      projectPath,
      c.branchName,
      "main",
      c.title,
      c.type === "local" ? { type: "local" } : { type: "worktree", srcBaseDir },
      undefined,
      undefined,
      undefined,
      { nameGeneration: NAME_REQUEST }
    );
    expect(result.success).toBe(false);
    expect(generateIdentity).not.toHaveBeenCalled();
    expect(harness.config.loadConfigOrDefault().projects.get(projectPath)?.workspaces).toEqual([]);
  });
});
