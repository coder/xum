import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { Err, Ok } from "@/common/types/result";
import { parseAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import type { Config, Workspace } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspacesWithCheckouts as saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const ssh = { type: "ssh", host: "remote.example", srcBaseDir: "~/src" } as const;
const docker = { type: "docker", image: "node:22" } as const;

describe("TaskService tagged-chat messaging", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setup() {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "alpha", "alpha", {
          runtimeConfig: ssh,
          messagingTag: "research",
          agentId: "plan",
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "beta", "beta", {
          runtimeConfig: docker,
          messagingTag: "research",
          agentId: "exec",
          aiSettings: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "low" },
        }),
        projectWorkspace(projectPath, "peer3", "peer3", {
          runtimeConfig: ssh,
          messagingTag: "research",
        }),
        projectWorkspace(projectPath, "gamma", "gamma", {
          runtimeConfig: ssh,
          messagingTag: "other",
        }),
        projectWorkspace(projectPath, "delta", "delta", {
          runtimeConfig: { type: "local" },
          unrelatedWorkspaceConsent: "delta-consent",
        }),
        projectWorkspace(projectPath, "child", "child", {
          runtimeConfig: ssh,
          parentWorkspaceId: "alpha",
          messagingTag: "research",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "main", "side", {
          name: "side",
          runtimeConfig: ssh,
          sideChatParentWorkspaceId: "alpha",
          messagingTag: "research",
          taskIsolation: "none",
        }),
      ],
      testTaskSettings()
    );
    return { config, projectPath };
  }

  async function updateWorkspace(config: Config, id: string, updates: Partial<Workspace>) {
    await config.editConfig((cfg) => {
      const entry = findWorkspaceEntry(cfg, id);
      if (entry == null) throw new Error(`Missing test workspace: ${id}`);
      Object.assign(entry.workspace, updates);
      return cfg;
    });
  }

  test("delivers tagged chats both ways across runtimes with recipient settings and tagged framing", async () => {
    const { config } = await setup();
    const sendMessage = mock(async (...args: Parameters<WorkspaceHost["sendMessage"]>) => {
      await args[3]?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    for (const [sender, target, agentId, model] of [
      ["alpha", "beta", "exec", "anthropic:claude-sonnet-4-5"],
      ["beta", "alpha", "plan", "openai:gpt-5.2"],
    ] as const) {
      expect(await taskService.sendAgentTreeMessage(sender, target, `ping from ${sender}`)).toEqual(
        Ok({ delivery: "accepted", relation: "target_tagged" })
      );
      const call = sendMessage.mock.calls.at(-1)!;
      expect(call[0]).toBe(target);
      expect(call[1]).not.toContain(`ping from ${sender}`);
      expect(call[2]).toMatchObject({ agentId, model, queueDispatchMode: "tool-end" });
      const row = call[3]?.preTurnMessages?.[0];
      expect(row?.role).toBe("assistant");
      const text = row?.parts[0]?.type === "text" ? row.parts[0].text : "";
      expect(parseAgentMessageEnvelope(text)).toMatchObject({
        from: sender,
        relationship: "tagged",
        message: `ping from ${sender}`,
      });
      expect(row?.metadata?.muxMetadata).toMatchObject({
        type: "agent-peer-message",
        fromWorkspaceId: sender,
        relationship: "tagged",
      });
    }
    // Tag links are messaging addresses, not task ownership.
    expect(await taskService.isDescendantAgentTask("alpha", "beta")).toBe(false);
    expect(await taskService.isDescendantAgentTask("beta", "alpha")).toBe(false);
  });

  test("discovers only same-tag root chats, never children, side chats, or other tags", async () => {
    const { config } = await setup();
    const { taskService } = createTaskServiceHarness(config);
    expect(taskService.listTaskTreeAgents("alpha").relatedChats).toEqual([
      { workspaceId: "beta", title: "beta", relationship: "tagged" },
      { workspaceId: "peer3", title: "peer3", relationship: "tagged" },
      // Alpha's own side chat is a direct link, never a tagged one.
      { workspaceId: "side", title: "side", relationship: "side_chat" },
    ]);
    expect(taskService.listTaskTreeAgents("beta").relatedChats).toEqual([
      { workspaceId: "alpha", title: "alpha", relationship: "tagged" },
      { workspaceId: "peer3", title: "peer3", relationship: "tagged" },
    ]);
    expect(taskService.listTaskTreeAgents("gamma").relatedChats).toBeUndefined();
    expect(taskService.listTaskTreeAgents("delta").relatedChats).toBeUndefined();
    expect(taskService.listTaskTreeAgents("child").relatedChats).toBeUndefined();
    // Instance discovery is unchanged: SSH callers stay restricted and tagged
    // remote chats never leak into a local consenting caller's address book.
    expect(taskService.listInstanceWorkspaces("alpha", {})).toEqual({
      rows: [],
      totalMatching: 0,
      callerPeerMessagingRestricted: true,
    });
    expect(
      taskService.listInstanceWorkspaces("delta", {}).rows.map((row) => row.workspaceId)
    ).not.toContain("beta");
  });

  test("guessed IDs cannot bypass tag, child, or side-chat scope", async () => {
    const { config } = await setup();
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Different-tag and untagged targets stay on the unrelated path: without
    // recipient consent they are concealed as not_found; with consent, the
    // runtime gate still refuses these remote endpoints.
    for (const [sender, target] of [
      ["alpha", "gamma"],
      ["child", "beta"],
    ]) {
      expect(await taskService.sendAgentTreeMessage(sender, target, "not linked")).toEqual(
        Err({ code: "not_found" })
      );
    }
    expect(await taskService.sendAgentTreeMessage("alpha", "delta", "not linked")).toMatchObject({
      success: false,
      error: { code: "refused" },
    });
    // Side chats remain private and cannot bridge through a copied tag field.
    for (const [sender, target] of [
      ["side", "beta"],
      ["beta", "side"],
    ]) {
      expect(await taskService.sendAgentTreeMessage(sender, target, "not linked")).toEqual(
        Err({ code: "not_found" })
      );
    }
    expect(await taskService.sendAgentTreeMessage("alpha", "alpha", "self")).toEqual(
      Err({ code: "invalid_scope" })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("a malformed blank parent marker cannot promote a child entry into a tagged root", async () => {
    const { config } = await setup();
    await updateWorkspace(config, "child", { parentWorkspaceId: "" });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(taskService.listTaskTreeAgents("alpha").relatedChats ?? []).not.toContainEqual(
      expect.objectContaining({ workspaceId: "child" })
    );
    expect(await taskService.sendAgentTreeMessage("alpha", "child", "not a root")).toEqual(
      Err({ code: "not_found" })
    );
    expect(await taskService.sendAgentTreeMessage("child", "beta", "not a root")).toMatchObject({
      success: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("changing either tag fences already queued tagged dispatch", async () => {
    const { config } = await setup();
    const sendMessage = mock((...args: Parameters<WorkspaceHost["sendMessage"]>) => {
      expect(args[3]?.admissionStale?.()).toBe(false);
      return Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(await taskService.sendAgentTreeMessage("alpha", "beta", "queued")).toMatchObject({
      success: true,
      data: { delivery: "queued" },
    });
    const admissionStale = sendMessage.mock.calls[0][3]?.admissionStale;
    await updateWorkspace(config, "beta", { messagingTag: "other" });
    expect(admissionStale?.()).toBe(true);
  });

  test("restoring the same tag with a new generation does not revive queued dispatch", async () => {
    const { config } = await setup();
    const sendMessage = mock((...args: Parameters<WorkspaceHost["sendMessage"]>) => {
      expect(args[3]?.admissionStale?.()).toBe(false);
      return Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(await taskService.sendAgentTreeMessage("alpha", "beta", "queued")).toMatchObject({
      success: true,
      data: { delivery: "queued" },
    });
    const admissionStale = sendMessage.mock.calls[0][3]?.admissionStale;
    // Revoke, then restore the identical tag string: the relation resolves as
    // tagged again, but the new generation is a new link.
    await updateWorkspace(config, "beta", {
      messagingTag: "other",
      messagingTagGeneration: "gen-2",
    });
    await updateWorkspace(config, "beta", {
      messagingTag: "research",
      messagingTagGeneration: "gen-3",
    });
    expect(admissionStale?.()).toBe(true);
  });

  test("a generation change during send preparation refuses even with the same tag", async () => {
    const { config } = await setup();
    const sendMessage = mock(async (...args: Parameters<WorkspaceHost["sendMessage"]>) => {
      expect(args[3]?.admissionStale?.()).toBe(false);
      await updateWorkspace(config, "beta", { messagingTagGeneration: "gen-2" });
      expect(args[3]?.admissionStale?.()).toBe(true);
      return Err("admission canceled");
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(await taskService.sendAgentTreeMessage("alpha", "beta", "do not deliver")).toEqual(
      Err({ code: "invalid_scope" })
    );
  });

  test("removing a tag during send preparation refuses the tagged message", async () => {
    const { config } = await setup();
    const sendMessage = mock(async (...args: Parameters<WorkspaceHost["sendMessage"]>) => {
      expect(args[3]?.admissionStale?.()).toBe(false);
      await updateWorkspace(config, "alpha", { messagingTag: undefined });
      expect(args[3]?.admissionStale?.()).toBe(true);
      return Err("admission canceled");
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(await taskService.sendAgentTreeMessage("alpha", "beta", "do not deliver")).toEqual(
      Err({ code: "invalid_scope" })
    );
  });

  test("tagged checkout failures stay opaque to the untrusted sender", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const srcBaseDir = path.join(rootDir, "src");
    const worktree = { type: "worktree", srcBaseDir } as const;
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "wt-a", "wt-a", {
          runtimeConfig: worktree,
          messagingTag: "research",
        }),
        projectWorkspace(projectPath, "wt-b", "wt-b", {
          runtimeConfig: worktree,
          messagingTag: "research",
          projects: [
            { projectPath: path.join(rootDir, "repo-a"), projectName: "repo-a" },
            { projectPath: path.join(rootDir, "repo-b"), projectName: "repo-b" },
          ],
        }),
      ],
      testTaskSettings()
    );
    // Only one of the target's two constituent checkouts exists.
    await fsPromises.mkdir(path.join(srcBaseDir, "repo-a", "wt-b", ".git"), { recursive: true });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const result = await taskService.sendAgentTreeMessage("wt-a", "wt-b", "are you there?");
    // Cross-tree senders never learn the target's local checkout path.
    expect(result).toEqual(
      Err({
        code: "refused",
        reason: "The target workspace's checkout is unavailable, so it cannot receive messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("archived tagged chats disappear from discovery and refuse delivery", async () => {
    const { config } = await setup();
    await updateWorkspace(config, "beta", { archivedAt: new Date().toISOString() });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    expect(taskService.listTaskTreeAgents("alpha").relatedChats).toEqual([
      { workspaceId: "peer3", title: "peer3", relationship: "tagged" },
      { workspaceId: "side", title: "side", relationship: "side_chat" },
    ]);
    expect(await taskService.sendAgentTreeMessage("alpha", "beta", "wake")).toMatchObject({
      success: false,
      error: { code: "not_active" },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
