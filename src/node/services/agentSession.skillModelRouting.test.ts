import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import type { ResolvedAgentSkill } from "@/node/services/agentSkills/agentSkillsService";
import type { AIService, StreamMessageOptions } from "@/node/services/aiService";

import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";

const USER_MODEL = "anthropic:claude-fable-5";

describe("AgentSession.sendMessage (per-skill model routing)", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  const tempDirs: string[] = [];
  const sessions: Array<{ dispose: () => void }> = [];
  afterEach(async () => {
    // Safety net: a failed assertion above a test's own dispose() must not
    // leak a live session into the rest of the file, and temp skill trees
    // must not accumulate in the OS temp dir.
    for (const session of sessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        // Already disposed by the test body.
      }
    }
    await historyCleanup?.();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function createWorkspaceWithSkill(args: { skillName: string; metadataYaml?: string }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-skill-routing-"));
    tempDirs.push(tmp);
    const skillDir = path.join(tmp, ".mux", "skills", args.skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const skillMarkdown = `---\nname: ${args.skillName}\ndescription: Test skill\n${args.metadataYaml ?? ""}---\n\nDo the thing.\n`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown, "utf-8");
    return tmp;
  }

  async function createRoutingHarness(args: {
    workspacePath: string;
    /** Default true: routing fixtures exercise trusted-project behavior. */
    projectTrusted?: boolean;
    /** Workspace kind for the metadata (scratch workdirs never route project skills). */
    workspaceKind?: string;
    configValues?: {
      modelClasses?: Record<string, string>;
      skillModelClasses?: Record<string, string>;
      routePriority?: string[];
    };
    /** When provided, getProvidersConfigSafe sees this map (enables the availability check). */
    providersConfig?: Record<string, { isConfigured: boolean; isEnabled?: boolean }>;
  }) {
    const workspaceId = "ws-skill-routing";
    const workspaceMeta = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: args.workspacePath,
      namedWorkspacePath: args.workspacePath,
      runtimeConfig: { type: "local" },
      ...(args.workspaceKind != null ? { kind: args.workspaceKind } : {}),
    } as unknown as FrontendWorkspaceMetadata;

    const streamed: StreamMessageOptions[] = [];
    const streamMessage = mock((opts: StreamMessageOptions) => {
      streamed.push(opts);
      return Promise.resolve(Ok(createStartedTurnHandle()));
    });

    const config = {
      srcDir: "/tmp",
      sessionsDir: "/tmp",
      getSessionDir: mock((_workspaceId: string) => "/tmp"),
      loadConfigOrDefault: mock(() => ({
        ...args.configValues,
        // Project-scope frontmatter routing requires Project Trust; these
        // fixtures write skills into the workspace's own project.
        projects: new Map(
          args.projectTrusted === false ? [] : [[args.workspacePath, { trusted: true }]]
        ),
      })),
    } as unknown as Config;

    const { session, cleanup, historyService, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      aiServiceOverrides: {
        getWorkspaceMetadata: mock((_id: string) => Promise.resolve(Ok(workspaceMeta))),
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
        ...(args.providersConfig != null
          ? { getProvidersConfig: mock(() => args.providersConfig) }
          : {}),
      } as unknown as Partial<AIService>,
      captureEvents: true,
    });
    historyCleanup = cleanup;
    sessions.push(session);
    return { session, streamed, historyService, events };
  }

  /** Force the next send onto the on-send compaction path (mirrors the autoCompaction fixtures). */
  function forceOnSendCompaction(session: object): void {
    (session as { compactionMonitor: unknown }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    };
  }

  /** Revoke Project Trust the instant routing consent is granted (before the later rechecks). */
  function revokeTrustAfterRouting(
    session: object,
    harnessArgs: Parameters<typeof createRoutingHarness>[0]
  ): void {
    const withResolve = session as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );
  }

  function skillSendOptions(overrides?: Record<string, unknown>) {
    return {
      model: USER_MODEL,
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/done",
        skillName: "done",
        scope: "project",
      },
      ...overrides,
    };
  }

  it("streams a metadata-bound skill on its class model with resolved thinking", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    // The accepted-send payload reports the routed model and thinking so the
    // frontend can attribute send telemetry to what actually streams.
    expect(result.success && result.data?.routedModel).toBe(KNOWN_MODELS.HAIKU.id);
    expect(result.success && result.data?.routedThinkingLevel).toBe("off");
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    // "+0" is model-relative: haiku's lowest allowed level is "off".
    expect(streamed[0].thinkingLevel).toBe("off");
    session.dispose();
  });

  it("ignores project-skill frontmatter bindings in untrusted projects", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // Repo-controlled frontmatter must not reroute the transcript to a
    // different configured provider without Project Trust: the send streams
    // on the workspace model as if the skill were unbound.
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });

  it("never routes scratch-workspace project skills via frontmatter, even though scratch is app-trusted", async () => {
    // Scratch workdirs hold cloned third-party repos whose .xum/skills are
    // discovered; app-level scratch trust (isWorkspaceProjectTrusted) must not
    // extend to provider-selection consent.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      workspaceKind: "scratch",
      // Even an (impossible in practice) trusted-projects entry must not help:
      // the scratch guard fires before the project-trust lookup.
      projectTrusted: true,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });

  it("rejects the routed turn when trust is revoked between routing and materialization", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    // Retained by loadConfigOrDefault's closure, so flipping projectTrusted
    // below is observed by the next trust read.
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed } = await createRoutingHarness(harnessArgs);

    // Revoke trust the instant routing consent is granted: the
    // materialization-time re-read must reject the routed turn — exempting
    // the pre-resolved package would ship the repo-controlled snapshot (and
    // keep the class route) to the alternate provider without consent.
    const withResolve = session as unknown as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("unknown");
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("rejects a revoked TABLE-bound route too (no fast path hides the invocation)", async () => {
    // The trusted table-binding path used to skip package resolution, which
    // left the routed invocation unidentifiable at recheck time — revocation
    // then merely omitted the snapshot while the conversation still streamed
    // on the class provider.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const { session, streamed } = await createRoutingHarness(harnessArgs);

    const withResolve = session as unknown as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("preserves a queued send rejected by the trust recheck", async () => {
    // A dequeued prompt's composer already cleared: the recheck rejection
    // must leave a durable transcript row (like the routing/pricing/PDF
    // gates) instead of silently dropping it while the queue moves on.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);

    const withResolve = session as unknown as {
      resolveSkillModelClassOverride: (...resolveArgs: unknown[]) => Promise<unknown>;
    };
    const originalResolve = withResolve.resolveSkillModelClassOverride.bind(session);
    spyOn(withResolve, "resolveSkillModelClassOverride").mockImplementation(
      async (...resolveArgs: unknown[]) => {
        const resolved = await originalResolve(...resolveArgs);
        harnessArgs.projectTrusted = false;
        return resolved;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions(), {
      dequeued: true,
      enqueuedAtMs: 123,
    });
    expect(result.success).toBe(false);
    expect(streamed).toHaveLength(0);

    const history = await historyService.getLastMessages("ws-skill-routing", 5);
    expect(history.success).toBe(true);
    const preserved = history.success
      ? history.data.find((msg) => msg.metadata?.preStreamRejected === true)
      : undefined;
    expect(preserved?.role).toBe("user");
    expect(preserved?.parts?.[0]).toMatchObject({ type: "text", text: "Use skill done" });
    session.dispose();
  });

  it("late revocation surfaces as an accepted pre-stream failure, not a retryable Err", async () => {
    // Trust flips AFTER materialization (its internal recheck saw consent):
    // the pre-stream consent gate must stop the dispatch — and because the
    // turn's rows are durable by then, it must NOT return a pre-acceptance
    // Err (the renderer would restore a draft that duplicates the persisted
    // row). The visible record is the emitted stream error.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);

    const withMaterialize = session as unknown as {
      materializeAgentSkillSnapshots: (...materializeArgs: unknown[]) => Promise<unknown>;
    };
    const originalMaterialize = withMaterialize.materializeAgentSkillSnapshots.bind(session);
    spyOn(withMaterialize, "materializeAgentSkillSnapshots").mockImplementation(
      async (...materializeArgs: unknown[]) => {
        const materialized = await originalMaterialize(...materializeArgs);
        harnessArgs.projectTrusted = false;
        return materialized;
      }
    );

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    // Accepted, but no provider request happened: the renderer must not
    // attribute send telemetry to the ambient model for this turn.
    expect(result.success && result.data).toEqual({ acceptedWithoutStream: true });
    expect(streamed).toHaveLength(0);

    // The turn's own row persisted exactly once — no rejected-copy duplicate.
    const history = await historyService.getLastMessages("ws-skill-routing", 10);
    expect(history.success).toBe(true);
    if (history.success) {
      const userRows = history.data.filter(
        (msg) => msg.role === "user" && !msg.metadata?.synthetic
      );
      expect(userRows).toHaveLength(1);
    }
    session.dispose();
  });

  it("does not let an untrusted project skill inherit a name-keyed table binding", async () => {
    // Shadow protection: the table entry's consent belongs to whatever skill
    // the user knew by this name (typically global/built-in), and project
    // skills win name collisions — so in an UNTRUSTED project a repo-shipped
    // shadow must not route via the table either.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });

  it("lets the config skillModelClasses table win over frontmatter metadata", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0", big: "anthropic:claude-opus-5+high" },
        skillModelClasses: { done: "big" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.OPUS.id);
    expect(streamed[0].thinkingLevel).toBe("high");
    session.dispose();
  });

  it("routes a table-bound skill that has no frontmatter metadata", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    session.dispose();
  });

  it("never re-routes sends that carry an explicit model override (skipSkillModelRouting)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ skipSkillModelRouting: true })
    );
    expect(result.success).toBe(true);
    // No routing applied — the accepted-send payload must not name a model.
    expect(result.success && result.data?.routedModel).toBeUndefined();
    expect(streamed[0].modelString).toBe(USER_MODEL);
    expect(streamed[0].thinkingLevel).toBeUndefined();
    session.dispose();
  });

  it("still routes sends that only skip settings persistence (thinking-only one-shots)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // "/+2 /done" sets skipAiSettingsPersistence (to protect preferences) with
    // no model override — class routing must still apply to the model while
    // the explicit thinking level wins over the class default.
    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({ skipAiSettingsPersistence: true, thinkingLevel: "medium" })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    expect(streamed[0].thinkingLevel).toBe("medium");
    // The payload reports the effective level even when the one-shot rode
    // through unchanged — telemetry must see what the routed stream runs at.
    expect(result.success && result.data?.routedThinkingLevel).toBe("medium");
    session.dispose();
  });

  it("re-resolves a numeric one-shot thinking index against the routed model", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku" } },
    });

    // "/+0 /done" typed on a workspace model whose lowest allowed level is
    // "medium": the frontend resolves thinkingLevel against the WORKSPACE
    // ladder and passes the raw index alongside. The routed model's ladder
    // differs (haiku's index 0 is "off"), so the re-resolved index — not the
    // pre-resolved level — must win.
    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({
        skipAiSettingsPersistence: true,
        thinkingLevel: "medium",
        oneShotThinkingIndex: 0,
      })
    );
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    expect(streamed[0].thinkingLevel).toBe("off");
    session.dispose();
  });

  it("leaves frontmatter bindings to an undefined class inert (streams the caller's model)", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: tiny\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });

    // Skills the user does not own must not fail sends just because some
    // other class is configured — an undefined frontmatter class is inert.
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });

  it("fails the send with an actionable error on a dangling table binding", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // The table is the user's own routing intent: naming a class that no
      // longer exists must error loudly, not silently unroute.
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "tiny" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    // The error must name the class so the user knows which mapping to fix.
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"tiny"');
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("honors frontmatter routing when a hand-edited table entry is blank", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // A blank table value (hand-edit meaning "no override") must not
      // suppress the frontmatter read and silently unroute the skill.
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "  " } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    session.dispose();
  });

  it("fails the send with an actionable error when the class value is invalid", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      // Hand-edited config can hold values the strict-on-write path would
      // have rejected; the send must not silently ignore them.
      configValues: { modelClasses: { small: "not-a-model" } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain('"small"');
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("fails the send when no configured route can serve the class model", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, routePriority: ["direct"] },
      providersConfig: { anthropic: { isConfigured: false } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    const raw = !result.success && result.error.type === "unknown" ? result.error.raw : "";
    expect(raw).toContain(KNOWN_MODELS.HAIKU.id);
    expect(streamed).toHaveLength(0);
    session.dispose();
  });

  it("routes normally when the class model has a configured route", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, routePriority: ["direct"] },
      providersConfig: { anthropic: { isConfigured: true, isEnabled: true } },
    });

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    session.dispose();
  });

  it("repairs an unstamped rejected turn before an accepted manual send commits its partial", async () => {
    // Startup recovery racing a manual send: the rejected turn's row stamp
    // AND its partial delete both failed before the restart, so only the
    // abandon marker still names the rejected row. Acceptance must repair
    // BEFORE it clears that marker, and the request build BEFORE it commits
    // partials — otherwise the unstamped prompt and the in-flight assistant
    // ride the very next provider request.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-rejected", "user", "refused prompt", { timestamp: 1 })
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("a-rejected", "assistant", "in-flight answer", {
        timestamp: 2,
        partial: true,
      })
    );
    (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon = { reason: "pre_stream_rejected", userMessageId: "u-rejected" };

    const result = await session.sendMessage("next prompt", { model: USER_MODEL, agentId: "exec" });
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const requestIds = streamed[0].messages.map((message) => message.id);
    expect(requestIds).not.toContain("u-rejected");
    expect(requestIds).not.toContain("a-rejected");

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    // Durably stamped (transcript-visible, provider-ineligible), partial gone.
    expect(history.data.find((m) => m.id === "u-rejected")?.metadata?.preStreamRejected).toBe(true);
    expect(history.data.some((m) => m.id === "a-rejected")).toBe(false);
    expect(await historyService.readPartial(workspaceId)).toBeNull();
    session.dispose();
  });

  /**
   * Post-compaction fixtures for the attachment-channel consent tests: a
   * project skill read BEFORE a compaction boundary survives only inside the
   * loaded-skills attachment — the request rows no longer carry its snapshot.
   */
  const pendingLoadedSkills: LoadedSkillSnapshot[] = [
    { name: "repo-conventions", scope: "project", sha256: "a".repeat(64), body: "Repo rules." },
    { name: "team-style", scope: "global", sha256: "b".repeat(64), body: "Global rules." },
  ];

  /** Route a GLOBAL skill (routable in untrusted projects) with pending post-compaction state. */
  async function sendRoutedGlobalSkillWithPendingState(
    harnessArgs: Parameters<typeof createRoutingHarness>[0]
  ) {
    const { session, streamed } = await createRoutingHarness(harnessArgs);
    // The fixture skill lives in the project tree; present it as GLOBAL so
    // the invocation itself carries no project content and routes in an
    // untrusted project — only the attachment channel is under test.
    const withReader = session as unknown as {
      buildSkillReader: (...args: unknown[]) => (skillName: string) => Promise<ResolvedAgentSkill>;
      compactionHandler: { peekPendingState: () => Promise<unknown> };
    };
    const originalBuild = withReader.buildSkillReader.bind(session);
    spyOn(withReader, "buildSkillReader").mockImplementation((...args: unknown[]) => {
      const read = originalBuild(...args);
      return async (skillName: string) => {
        const resolved = await read(skillName);
        return { ...resolved, package: { ...resolved.package, scope: "global" as const } };
      };
    });
    spyOn(withReader.compactionHandler, "peekPendingState").mockResolvedValue({
      diffs: [],
      loadedSkills: pendingLoadedSkills,
      readFiles: [],
    });

    const result = await session.sendMessage(
      "Use skill done",
      skillSendOptions({
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/done",
          skillName: "done",
          scope: "global",
        },
      })
    );
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].modelString).toBe(KNOWN_MODELS.HAIKU.id);
    const loadedSkillsAttachment = streamed[0].postCompactionAttachments?.find(
      (attachment) => attachment.type === "loaded_skills_snapshot"
    );
    return { session, streamed, loadedSkillsAttachment };
  }

  it("drops project-scope loaded skills from a routed request's attachments in an untrusted project", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, loadedSkillsAttachment } =
      await sendRoutedGlobalSkillWithPendingState({
        workspacePath,
        projectTrusted: false,
        configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
      });

    // The request rows carry no project snapshot, so only the attachment
    // could have shipped repo-controlled content to the class provider.
    expect(loadedSkillsAttachment?.skills.map((skill) => skill.name)).toEqual(["team-style"]);
    // Nothing project-scoped was kept, so the provider-boundary gate has
    // nothing to guard.
    expect(await streamed[0].preDispatchConsentGate?.()).toBeNull();
    session.dispose();
  });

  it("arms the provider-boundary gate on project-scope loaded skills kept under trust", async () => {
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" }, skillModelClasses: { done: "small" } },
    };
    const { session, streamed, loadedSkillsAttachment } =
      await sendRoutedGlobalSkillWithPendingState(harnessArgs);

    // Trusted: the project skill rides along...
    expect(loadedSkillsAttachment?.skills.map((skill) => skill.name)).toEqual([
      "repo-conventions",
      "team-style",
    ]);
    // ...and a revocation between request assembly and the provider call
    // must still reject, even though no request ROW is project-scoped.
    harnessArgs.projectTrusted = false;
    const rejection = await streamed[0].preDispatchConsentGate?.();
    expect(JSON.stringify(rejection)).toMatch(/trust was revoked/i);
    session.dispose();
  });

  it("rolls back the on-send compaction request when the pre-snapshot consent recheck refuses", async () => {
    // On-send compaction persists its request row (carrying the prompt as the
    // pending follow-up) BEFORE the consent recheck runs. A refusal that left
    // that row behind would let startup recovery resume the compaction and
    // dispatch a prompt whose send was reported failed.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, historyService } = await createRoutingHarness(harnessArgs);
    forceOnSendCompaction(session);
    revokeTrustAfterRouting(session, harnessArgs);

    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }
    expect(streamed).toHaveLength(0);

    const history = await historyService.getHistoryFromLatestBoundary("ws-skill-routing");
    if (!history.success) throw new Error(history.error);
    expect(
      history.data.some((message) => message.metadata?.muxMetadata?.type === "compaction-request")
    ).toBe(false);
    expect(history.data).toHaveLength(0);
    session.dispose();
  });

  it("fails closed when the refused compaction request cannot be rolled back", async () => {
    // deleteMessages can fail with the row still on disk. The refusal must
    // then stamp the surviving compaction request provider-ineligible and key
    // the abandon marker to it, so neither request assembly nor startup
    // replay can pick up the prompt it carries.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, historyService } = await createRoutingHarness(harnessArgs);
    forceOnSendCompaction(session);
    revokeTrustAfterRouting(session, harnessArgs);
    const deleteSpy = spyOn(historyService, "deleteMessages").mockResolvedValue(
      Err("history locked")
    );
    try {
      const result = await session.sendMessage("Use skill done", skillSendOptions());
      expect(result.success).toBe(false);
    } finally {
      deleteSpy.mockRestore();
    }

    const history = await historyService.getHistoryFromLatestBoundary("ws-skill-routing");
    if (!history.success) throw new Error(history.error);
    const compactionRequest = history.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    if (compactionRequest == null) throw new Error("expected the unremovable row to survive");
    expect(compactionRequest.metadata?.preStreamRejected).toBe(true);
    const abandon = (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon;
    expect(abandon).toEqual({ reason: "pre_stream_rejected", userMessageId: compactionRequest.id });
    session.dispose();
  });

  it("keeps a durable repair key when the acceptance-time restamp fails", async () => {
    // The accepted send legitimately clears the abandon marker; if the repair
    // it ran first could only quarantine the rows in memory, a durable key
    // must survive for the next request build (or a post-crash startup) to
    // finish the stamp.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, streamed, historyService } = await createRoutingHarness({ workspacePath });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-rejected", "user", "refused prompt", { timestamp: 1 })
    );
    const internals = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      pendingRejectedTurnRepair: { userMessageId?: string } | null;
      repairUnstampedRejectedTurn: () => Promise<boolean>;
    };
    internals.startupAutoRetryAbandon = {
      reason: "pre_stream_rejected",
      userMessageId: "u-rejected",
    };

    const stampSpy = spyOn(historyService, "markMessagesPreStreamRejected").mockResolvedValue(
      Err("disk full")
    );
    try {
      const result = await session.sendMessage("next prompt", {
        model: USER_MODEL,
        agentId: "exec",
      });
      expect(result.success).toBe(true);
    } finally {
      stampSpy.mockRestore();
    }
    // The in-memory quarantine protected THIS request...
    expect(streamed).toHaveLength(1);
    expect(streamed[0].messages.map((message) => message.id)).not.toContain("u-rejected");
    // ...the accepted send cleared the marker as it always does...
    expect(internals.startupAutoRetryAbandon).toBeNull();
    // ...but the repair key survived it.
    expect(internals.pendingRejectedTurnRepair).toEqual({ userMessageId: "u-rejected" });

    // The next repair pass completes the durable stamp and retires the record.
    expect(await internals.repairUnstampedRejectedTurn()).toBe(true);
    expect(internals.pendingRejectedTurnRepair).toBeNull();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-rejected")?.metadata?.preStreamRejected).toBe(true);
    session.dispose();
  });

  it("stamps a resumed routed turn's rows when the resume is refused for revoked trust", async () => {
    // A same-session retry or startup recovery replays the ORIGINAL accepted
    // turn; the resume path holds none of its row keys. A refusal must still
    // leave those rows provider-ineligible (and the abandon marker keyed) —
    // otherwise the next accepted manual send clears the marker and ships
    // the project content after all.
    const workspacePath = await createWorkspaceWithSkill({ skillName: "done" });
    const { session, historyService } = await createRoutingHarness({
      workspacePath,
      projectTrusted: false,
    });
    const workspaceId = "ws-skill-routing";
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snap-routed", "user", "Do the thing.", {
        timestamp: 1,
        synthetic: true,
        agentSkillSnapshot: { skillName: "done", scope: "project", sha256: "routed" },
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-routed", "user", "Use skill done", { timestamp: 2 })
    );

    const result = await session.resumeStream(
      { model: USER_MODEL, agentId: "exec" },
      { routedProjectConsent: true }
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toMatch(/trust was revoked/i);
    }

    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    expect(history.data.find((m) => m.id === "u-routed")?.metadata?.preStreamRejected).toBe(true);
    expect(history.data.find((m) => m.id === "snap-routed")?.metadata?.preStreamRejected).toBe(
      true
    );
    const abandon = (
      session as unknown as {
        startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      }
    ).startupAutoRetryAbandon;
    expect(abandon).toEqual({ reason: "pre_stream_rejected", userMessageId: "u-routed" });
    session.dispose();
  });

  it("emits a refusal once: the gate for pre-start, the stream error path for per-step", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const harnessArgs: Parameters<typeof createRoutingHarness>[0] = {
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    };
    const { session, streamed, events } = await createRoutingHarness(harnessArgs);
    const result = await session.sendMessage("Use skill done", skillSendOptions());
    expect(result.success).toBe(true);
    expect(streamed).toHaveLength(1);
    const gate = streamed[0].preDispatchConsentGate;
    if (gate == null) throw new Error("routed turn must carry the provider-boundary gate");

    harnessArgs.projectTrusted = false;
    const streamErrorCount = () => events.filter((event) => event.type === "stream-error").length;
    const before = streamErrorCount();
    // Per-step: StreamManager throws the refusal through its standard failure
    // pipeline, which emits the visible row — a second one here would leave
    // two error rows for one refusal.
    expect(JSON.stringify(await gate({ midStream: true }))).toMatch(/trust was revoked/i);
    expect(streamErrorCount()).toBe(before);
    // Pre-start: nothing else surfaces the refusal.
    expect(JSON.stringify(await gate())).toMatch(/trust was revoked/i);
    expect(streamErrorCount()).toBe(before + 1);
    session.dispose();
  });

  it("keeps the routed turn's consent gate on the active stream context for internal retries", async () => {
    // The post-compaction context_exceeded retry rebuilds the stream inside
    // AgentSession (outside StreamManager's gate-preserving recreations); it
    // must find the gate here or the rebuilt history reaches the class
    // provider unverified.
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session } = await createRoutingHarness({
      workspacePath,
      configValues: { modelClasses: { small: "haiku+0" } },
    });
    const contextOf = () =>
      (session as unknown as { activeStreamContext?: { routedConsentRejection?: unknown } })
        .activeStreamContext;

    expect((await session.sendMessage("Use skill done", skillSendOptions())).success).toBe(true);
    expect(typeof contextOf()?.routedConsentRejection).toBe("function");
    session.dispose();
  });

  it("leaves non-skill sends untouched even with routing configured", async () => {
    const workspacePath = await createWorkspaceWithSkill({
      skillName: "done",
      metadataYaml: "metadata:\n  model-class: small\n",
    });
    const { session, streamed } = await createRoutingHarness({
      workspacePath,
      configValues: {
        modelClasses: { small: "haiku+0" },
        skillModelClasses: { done: "small" },
      },
    });

    const result = await session.sendMessage("plain message", {
      model: USER_MODEL,
      agentId: "exec",
    });
    expect(result.success).toBe(true);
    expect(streamed[0].modelString).toBe(USER_MODEL);
    session.dispose();
  });
});
