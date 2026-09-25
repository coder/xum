import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { execSync } from "node:child_process";
import { type WorkspaceTurnTaskHandleRecord } from "@/node/services/taskHandleStore";
import {
  createWorkspaceTurnManagerHarness,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import { Ok, Err, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { InitStateManager } from "@/node/services/initStateManager";
import assert from "node:assert";
import {
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  createWorkspaceTurnMetadata,
  makeWorkspaceTurnCreateMock,
  findWorkspaceInConfig,
  initGitRepo,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnMuxMetadata,
  workspaceTurnSnapshot,
  writeCustomAgentDefinition,
} from "@/node/services/taskService.testHarness";

/**
 * Git-prove the owner workspace's checked-out branch: owner-side agent prechecks and
 * unreachable-target vouching only apply when the effective base branch is verified
 * against the branch actually checked out in the owner.
 */
function checkoutOwnerBranch(projectPath: string, branch: string): void {
  initGitRepo(projectPath);
  execSync(`git checkout -b ${branch}`, { cwd: projectPath, stdio: "ignore" });
}

/**
 * Commit pending agent-definition files: owner-side vouching additionally requires the
 * agent-definition paths to be clean (uncommitted changes diverge from the committed
 * base a new checkout is created from).
 */
function commitOwnerAgentFiles(projectPath: string): void {
  execSync("git add -A && git commit -q -m agents", { cwd: projectPath, stdio: "ignore" });
}

function makeCreateMockReturning(result: Result<{ metadata: WorkspaceMetadata }>) {
  return mock((): Promise<Result<{ metadata: WorkspaceMetadata }>> => Promise.resolve(result));
}

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("createWorkspaceTurn creates a normal workspace and starts a correlated turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      taskId: "wst_childworkspace",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
    expect(childConfig?.tags).toMatchObject({
      "mux.taskHandleId": "wst_childworkspace",
      "mux.taskOwnerWorkspaceId": parentId,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    expect(sendMessageCall[1]).toBe("Summarize the repo");
    expect(sendMessageCall[2]).toMatchObject({ agentId: "exec" });
    expect(sendMessageCall[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: true,
      agentInitiated: true,
    });
  });

  test("createWorkspaceTurn creates delegated targets without default unrelated-messaging consent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    // Delegated targets need a default tied to this turn's lifecycle (#4453);
    // until then create() must not opt them in.
    const createCall = createWorkspace.mock.calls[0] as unknown[];
    expect(createCall[8]).toMatchObject({
      awaitMaterialization: true,
      skipDefaultUnrelatedWorkspaceConsent: true,
    });
  });

  test("createWorkspaceTurn launches a new workspace with an explicit agent id", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan a small change",
      title: "Plan dogfood",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    // Explicit overrides also arm stream-time strict resolution, pinning the validated
    // definition's provenance (scope + exact source): pre-dispatch validation races
    // init hooks/user edits, so the stream must fail loudly instead of silently
    // swapping in exec (or running a different definition for the same id) post-init.
    expect(sendMessageCall[2]).toMatchObject({
      agentId: "plan",
      strictAgentResolution: {
        expectedScope: "built-in",
        expectedSource: "built-in",
        // The full base chain is pinned too: stream-time inheritance resolution
        // reloads every base independently.
        expectedChain: [{ id: "plan", scope: "built-in", source: "built-in" }],
      },
    });
  });

  test("createWorkspaceTurn keeps prechecks advisory when the owner has uncommitted agent changes", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    // A GITIGNORED hidden shadow of the built-in plan exists only in the owner's
    // working tree (plain `git status` would not even list it): the new checkout is
    // created from committed branch state and validly resolves the built-in, so the
    // owner-side miss must stay advisory (branch equality is not checkout equality).
    await fsPromises.writeFile(path.join(projectPath, ".gitignore"), ".mux/agents/\n");
    commitOwnerAgentFiles(projectPath);
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "plan.md"),
      ["---", "name: Plan", "base: plan", "ui:", "  hidden: true", "---", "Shadow."].join("\n")
    );

    const cleanCheckout = path.join(rootDir, "clean-target-checkout");
    await fsPromises.mkdir(cleanCheckout, { recursive: true });
    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: cleanCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan from the committed base",
      title: "Dirty owner shadow",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ agentId: "plan" });
  });

  test("createWorkspaceTurn owner-side misses are always advisory (target decides)", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // No owner-side equivalence proof is sound (fetched origin commits, existing
    // branchName targets, submodules, init hooks): the created checkout is the only
    // authoritative source, so a miss defers instead of rejecting pre-create.
    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "doesnotexist",
      prompt: "Should defer to the target",
      title: "Advisory miss",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("unknown agentId");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects bad agent ids without ever dispatching a turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const attempt = (agentId: string) =>
      taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        agentId,
        prompt: "Should not run",
        title: "Bad agent",
        workspace: { mode: "new" },
      });

    // Syntactically invalid ids are checkout-independent and fail before any
    // workspace exists.
    const invalidSyntax = await attempt("Not A Valid Id!");
    expect(invalidSyntax.success).toBe(false);
    if (!invalidSyntax.success) expect(invalidSyntax.error).toContain("invalid agentId");
    expect(createWorkspace).not.toHaveBeenCalled();

    // Definition-dependent verdicts are decided by the created target checkout
    // (owner-side prechecks are advisory): unknown and internal (ui.hidden) ids
    // fail there, with the workspace retained as owned evidence and no dispatch.
    const unknown = await attempt("doesnotexist");
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error).toContain("unknown agentId");
      expect(unknown.error).toContain("no turn was dispatched");
    }

    const internal = await attempt("compact");
    expect(internal.success).toBe(false);
    if (!internal.success) {
      expect(internal.error).toContain("not selectable");
      expect(internal.error).toContain("no turn was dispatched");
    }

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects disabled agents without dispatching a turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { custom: { enabled: false } },
    });
    checkoutOwnerBranch(projectPath, "parent");
    await writeCustomAgentDefinition(projectPath);
    commitOwnerAgentFiles(projectPath);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not run",
      title: "Disabled agent",
      workspace: { mode: "new" },
    });

    // Enablement is decided at the created target checkout (owner prechecks are
    // advisory); the disabled verdict settles post-create with no dispatch.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("disabled");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn does not dispatch when the agent is unavailable in the created workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Project-local agent exists in the OWNER's checkout, but the created workspace's checkout
    // diverges (no agent definition there) — post-create re-validation must fail instead of
    // silently streaming exec. Worktree runtime: the only local runtime whose created
    // workspaces get a checkout separate from the project root.
    await writeCustomAgentDefinition(projectPath);
    const divergedCheckout = path.join(rootDir, "diverged-checkout");
    await fsPromises.mkdir(divergedCheckout, { recursive: true });

    const divergedMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: divergedCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: divergedMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not dispatch",
      title: "Diverged agent",
      workspace: { mode: "new" },
      // Background launch: on this synchronous failure the policy must NOT be persisted —
      // settleWorkspaceTurn derives the terminal wake from the persisted record, which
      // would duplicate the Err returned directly to the caller.
      attentionPolicy: "notify_on_terminal",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    // The failure settles through the handle machinery, so the created workspace stays
    // owner-owned: a mode="existing" retry must pass the ownership check (not invalid_scope).
    const turns = await (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: () => Promise<Array<{ status: string; attentionPolicy?: string }>>;
        };
      }
    ).taskHandleStore.listAllWorkspaceTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "error", createdWorkspace: true });
    expect(turns[0]?.attentionPolicy).toBeUndefined();

    const retry = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Retry without the diverged agent",
      title: "Diverged agent retry",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(retry.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("createWorkspaceTurn respects a project shadow of a built-in id at the target", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    // Shadow the built-in plan agent with a hidden project-local override: target-side
    // eligibility must consult the shadow, not just the embedded definition.
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "plan.md"),
      [
        "---",
        "name: Plan",
        "description: Hidden shadowed plan",
        "base: plan",
        "ui:",
        "  hidden: true",
        "---",
        "",
        "Shadow body.",
        "",
      ].join("\n"),
      "utf-8"
    );
    commitOwnerAgentFiles(projectPath);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not run",
      title: "Shadowed plan",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not selectable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn divergent trunkBranch defers validation to the target checkout", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Agent exists ONLY on the target branch checkout, not in the owner's checkout: an
    // owner-side miss must not fail-fast when a different base branch was requested.
    const targetBranchCheckout = path.join(rootDir, "target-branch-checkout");
    const targetAgentsDir = path.join(targetBranchCheckout, ".mux", "agents");
    await fsPromises.mkdir(targetAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(targetAgentsDir, "custom.md"),
      [
        "---",
        "name: Custom",
        "description: Target-branch-only agent",
        "base: exec",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf-8"
    );

    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: targetBranchCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Run the target-branch agent",
      title: "Target branch agent",
      workspace: { mode: "new", trunkBranch: "feature-branch" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({ agentId: "custom" });
  });

  test("createWorkspaceTurn divergent trunkBranch fails closed for unreachable targets", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    // A different base branch can shadow ANY id (even built-ins), so an unreachable
    // target created from it cannot be verified at all.
    const unreachableMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: path.join(rootDir, "not-provisioned-branch"),
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: unreachableMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Divergent unreachable",
      workspace: { mode: "new", trunkBranch: "feature-branch" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not reachable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn unreachable created checkout: built-ins launch, custom agents fail with a reachability error", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    await writeCustomAgentDefinition(projectPath);
    commitOwnerAgentFiles(projectPath);
    // Deferred-provisioning runtimes return from create before the checkout is reachable.
    const unreachableCheckout = path.join(rootDir, "not-provisioned-yet");

    const deferredMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: unreachableCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: deferredMetadata }))
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Custom agents cannot be verified in an unreachable checkout; dispatching anyway
    // would risk a silent exec fallback at stream time, so the launch must fail loudly.
    const custom = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Launch despite pending provisioning",
      title: "Deferred runtime",
      workspace: { mode: "new" },
    });
    expect(custom.success).toBe(false);
    if (!custom.success) {
      expect(custom.error).toContain("not reachable");
      expect(custom.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();

    // Built-in agents are embedded in every checkout, so the launch is provably safe.
    const builtIn = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan despite pending provisioning",
      title: "Deferred runtime plan",
      workspace: { mode: "new" },
    });
    expect(builtIn.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0];
    expect(sendMessageCall?.[2]).toMatchObject({ agentId: "plan" });
  });

  test("createWorkspaceTurn treats sanitized branch-name collisions as unproven bases", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    // Owner is checked out on feature/foo, whose workspace name sanitizes to feature-foo.
    // A request for the DISTINCT branch feature-foo collides with that name, so the owner
    // must not vouch for the unreachable target: even a built-in id fails closed (the
    // colliding branch could shadow it).
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      workspaceName: "feature-foo",
    });
    checkoutOwnerBranch(projectPath, "feature/foo");

    const unreachableMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: path.join(rootDir, "not-provisioned-collision"),
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: unreachableMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Colliding branch",
      workspace: { mode: "new", trunkBranch: "feature-foo" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not reachable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();

    // The owner's real branch, by contrast, is a proven base: the same launch succeeds.
    const sameBranch = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan from the owner's own branch",
      title: "Same branch",
      workspace: { mode: "new", trunkBranch: "feature/foo" },
    });
    expect(sameBranch.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("createWorkspaceTurn defers owner-side misses to the target when the base is unproven", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    // Owner is on feature/foo but its workspace name is feature-foo: with trunkBranch
    // omitted, the child is created from the DISTINCT feature-foo branch, which may carry
    // agents absent from the owner's branch. An owner-side miss must not fail-fast here —
    // the created target checkout is authoritative.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      workspaceName: "feature-foo",
    });
    checkoutOwnerBranch(projectPath, "feature/foo");

    const targetOnlyCheckout = path.join(rootDir, "target-only-agent");
    const targetAgentsDir = path.join(targetOnlyCheckout, ".mux", "agents");
    await fsPromises.mkdir(targetAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(targetAgentsDir, "custom.md"),
      ["---", "name: Custom", "base: exec", "---", "Target-only agent."].join("\n")
    );

    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: targetOnlyCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Run the target-only agent",
      title: "Target-only agent",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ agentId: "custom" });
  });

  test("createWorkspaceTurn unreachable cross-host target fails closed even for built-ins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    // The created target lives on a remote host (per-workspace containers, Coder-style
    // per-workspace hosts). The owner's global agent roots say nothing about that host —
    // even a built-in could be shadowed by a target-host global definition — so
    // owner-side resolution must not vouch while the checkout is unreachable.
    const remoteMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "docker", image: "node:20" },
      namedWorkspacePath: "/workspace/repo",
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: remoteMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Cross-host unreachable",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("different host");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
    // The unreachable probe drives real docker CLI calls whose internal
    // timeouts (10-30s) can exceed the 5s default on loaded CI runners.
  }, 20_000);

  test("createWorkspaceTurn does not verify agents while the created workspace is still initializing", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath);
    // Reachable checkout whose init hook is still running: the hook may still be
    // installing/rewriting agent definitions, so a strict-validation miss is not a
    // trustworthy "unknown agentId" verdict — the launch must fail with a transient
    // error instead of a definitive one (and never dispatch an unverified id).
    const initializingCheckout = path.join(rootDir, "initializing-checkout");
    await fsPromises.mkdir(initializingCheckout, { recursive: true });

    const initializingMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: initializingCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: initializingMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const initStateManager = {
      startInit: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
      appendOutput: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      getInitState: mock((workspaceId: string) =>
        workspaceId === "childworkspace" ? { status: "running" } : undefined
      ),
      readInitStatus: mock(() => Promise.resolve(null)),
    } as unknown as InitStateManager;
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
      initStateManager,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not dispatch",
      title: "Initializing target",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("still initializing");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn unreachable existing target: explicit overrides fail closed, default identity works", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "childworkspace",
      "firstturn",
      "planhandle",
      "planturn",
      "customhandle",
    ]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath);
    // Simulates a stopped-container/deferred target: entry exists, checkout unreachable.
    const unreachableCheckout = path.join(rootDir, "stopped-target");

    const createWorkspace = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: unreachableCheckout,
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
        });
        return cfg;
      });
      return Ok({
        metadata: {
          ...createWorkspaceTurnMetadata(projectPath),
          runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
        },
      });
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Initial turn",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Existing targets have unknown checkout provenance (any branch, uncommitted shadows),
    // so ALL explicit overrides fail closed while the checkout is unreachable — even
    // built-ins, whose id could be shadowed by a project definition on the target.
    for (const agentId of ["plan", "custom"]) {
      const overridden = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        agentId,
        prompt: `${agentId} follow-up`,
        title: `${agentId} follow-up`,
        workspace: { mode: "existing", workspaceId: "childworkspace" },
      });
      expect(overridden.success).toBe(false);
      if (!overridden.success) {
        expect(overridden.error).toContain("not reachable");
        expect(overridden.error).not.toContain("unknown agentId");
      }
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Omitting agentId keeps working: the default identity needs no verification.
    const withoutOverride = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Default follow-up",
      title: "Default follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(withoutOverride.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("createWorkspaceTurn rejects explicit agentId for descendant agent workspace targets", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["overridehandle", "overrideturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childWorkspaceId = "reported-child-override";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "reported-child"),
        id: childWorkspaceId,
        name: "agent_explore_reported_child",
        createdAt: "2026-06-19T00:00:00.000Z",
        parentWorkspaceId: parentId,
        agentType: "explore",
        taskStatus: "reported",
        reportedAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, { workspaceService });

    // Persistent children are pinned to their persisted identity at stream time
    // (resolveAgentForStream ignores per-send agentId when parentWorkspaceId is set),
    // so an override must be rejected instead of silently running the old agent.
    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Re-plan the follow-up",
      title: "Override turn",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: childWorkspaceId },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("descendant agent workspaces");
    }
    expect(sendMessage).not.toHaveBeenCalled();
    const childEntry = findWorkspaceInConfig(config, childWorkspaceId);
    expect(childEntry?.agentType).toBe("explore");
    expect(childEntry?.agentId).toBeUndefined();
  });

  test("createWorkspaceTurn existing-target agent override dispatches without persisting AI settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "firstturn", "followuphandle", "followupturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          // Project-dir local workspaces execute in the project root itself.
          path: projectPath,
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Initial turn",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Per-turn plan follow-up",
      title: "Override follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const followUpCall = sendMessage.mock.calls[1];
    expect(followUpCall[0]).toBe("childworkspace");
    // Override reaches the stream (normal workspaces honor the per-send agentId) but must
    // not overwrite the target's saved agent/settings.
    expect(followUpCall[2]).toMatchObject({ agentId: "plan", skipAiSettingsPersistence: true });
    // The default path keeps persisting (first send carries no override).
    expect(sendMessage.mock.calls[0]?.[2]).not.toMatchObject({ skipAiSettingsPersistence: true });
  });

  test("createWorkspaceTurn inherits pro mode from the parent's active non-exec agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Pro was toggled while a custom agent was active — no exec bucket
          // exists, so inheritance must read the active-agent bucket.
          agentId: "researcher",
          aiSettingsByAgent: {
            researcher: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ reasoningMode: "pro" });
  });

  test("createWorkspaceTurn resolves AI settings: agent defaults on create, target settings on follow-up, explicit override wins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "firsthandle",
      "firstturn",
      "secondhandle",
      "secondturn",
      "thirdhandle",
      "thirdturn",
    ]);
    // Owner persisted at opus/high (helper default); configured exec agent
    // defaults differ from both the owner's persisted and live settings.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.2", thinkingLevel: "xhigh" } },
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation: configured agent defaults outrank the owner's live runtime
    // settings (owner turned down to medium must not produce medium children).
    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({
      agentId: "exec",
      model: "openai:gpt-5.2",
      thinkingLevel: "xhigh",
    });

    // Simulate the child's own last-used settings (persist-on-send or a manual
    // flip inside the child workspace).
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "anthropic:claude-opus-4-6", thinkingLevel: "low" },
      };
      return cfg;
    });

    // Follow-up: the target continues its own settings; the owner's bump to
    // high must not drag the child along, and agent defaults no longer apply.
    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[2]).toMatchObject({
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "low",
    });

    // Explicit per-launch overrides still outrank the target's own settings.
    const third = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Third prompt",
      title: "Override",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(third.success).toBe(true);
    const thirdSend = sendMessage.mock.calls[2];
    expect(thirdSend[2]).toMatchObject({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
    });
  });

  test("createWorkspaceTurn follow-ups do not re-inject the owner's pro mode over the target's own settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation still inherits the owner's pro mode.
    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({ reasoningMode: "pro" });

    // The child was switched back to standard (absent = standard per
    // WorkspaceAISettingsSchema); follow-ups must respect that.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
      };
      return cfg;
    });

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    // The bucket's absent reasoning resolves to explicit standard; the owner's
    // pro must not leak through.
    expect((secondSend[2] as { reasoningMode?: string }).reasoningMode).not.toBe("pro");
  });

  test("createWorkspaceTurn rejects multi-project owners instead of dropping secondary repos", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary", {
      initGit: false,
    });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: secondaryProjectPath, projectName: "repo-secondary" },
          ],
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        extraProjects: [[secondaryProjectPath, { trusted: true, workspaces: [] }]],
      }
    );
    const createWorkspace = makeCreateMockReturning(Err("should not create workspace"));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize all projects",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("multi-project workspace turns are not supported");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects fork mode until workspace turns support forking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const createWorkspace = makeCreateMockReturning(Err("should not create workspace"));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize fork",
      title: "Workspace turn",
      workspace: { mode: "fork" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('workspace.mode="fork" is not supported');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "continuation failure transfers disposable cleanup after lock and notification (throws=%s)",
    async (throwNotification) => {
      const remove = mock(() => Promise.resolve(Ok(undefined)));
      const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(rootDir, {
        disposable: true,
        remove,
      });
      const jobs: Array<() => Promise<void>> = [];
      workspaceMocks.workspaceService.deferWorkspaceCleanup = (run) => {
        jobs.push(run);
      };
      if (throwNotification)
        spyOn(
          taskService as unknown as {
            deliverPersistentChildWorkspaceTurnResult(
              record: WorkspaceTurnTaskHandleRecord
            ): Promise<void>;
          },
          "deliverPersistentChildWorkspaceTurnResult"
        ).mockRejectedValueOnce(new Error("notification unavailable"));
      const outcome = await taskService
        .settleWorkspaceTurnContinuationFailure(
          "childworkspace",
          workspaceTurnMuxMetadata(parentId),
          "error",
          "preparation failed"
        )
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(outcome instanceof Error).toBe(throwNotification);
      const snapshot = await workspaceTurnSnapshot(taskService, parentId);
      expect(snapshot?.status).toBe("error");
      expect(remove).not.toHaveBeenCalled();
      expect(jobs).toHaveLength(1);
      await jobs[0]();
      expect(remove).toHaveBeenCalledWith("childworkspace", true);
    }
  );

  test("createWorkspaceTurn marks accepted pre-stream failures as handle errors", async () => {
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        const internal = args[3] as
          | { onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void }
          | undefined;
        await internal?.onAcceptedPreStreamFailure?.({
          type: "unknown",
          raw: "Runtime startup failed",
        });
        return Ok(undefined);
      }
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, { sendMessage });

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Runtime startup failed",
      workspaceId: "childworkspace",
    });
  });

  test("createWorkspaceTurn reprompts only owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const taskHandleStore = (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: (options?: { statuses?: readonly string[] }) => Promise<unknown[]>;
        };
      }
    ).taskHandleStore;
    const listAllWorkspaceTurns = spyOn(taskHandleStore, "listAllWorkspaceTurns");

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      taskId: "wst_secondhandle",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Second prompt");
    expect(secondSend[3]).toMatchObject({ requireIdle: true });
    const secondSnapshot = await workspaceTurnSnapshot(taskService, parentId, "wst_secondhandle");
    expect(secondSnapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "running",
    });
    expect(listAllWorkspaceTurns).toHaveBeenCalledTimes(1);
    listAllWorkspaceTurns.mockRestore();

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "other-parent"),
        id: "other-parent",
        name: "other-parent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const foreign = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: "other-parent",
      prompt: "Should not run",
      title: "Foreign",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(foreign.success).toBe(false);
    if (foreign.success) return;
    expect(foreign.error).toContain("invalid_scope");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("createWorkspaceTurn mode=existing refuses an independently created root", async () => {
    // A root nobody delegated to (no workspace-turn record, not a descendant) stays outside the
    // ownership graph even though it is a perfectly valid instance workspace ID.
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "foreign-root"),
        id: "foreignroot",
        name: "foreign-root",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Should not run",
      title: "Foreign root",
      workspace: { mode: "existing", workspaceId: "foreignroot" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("invalid_scope");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
