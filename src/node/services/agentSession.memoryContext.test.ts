import { describe, expect, test, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import type { MemorySessionContext } from "./memoryService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { MEMORY_CONTEXT_FILE_NAME } from "./memoryContextPersistence";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Err } from "@/common/types/result";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Behavior under test: the memory session context (index snapshot) is
 * computed once per model in a context window and
 * recomputed only at window boundaries (compaction, rollover, reset), never
 * after a memory write or a server restart, so the injected bytes stay
 * prompt-cache-stable (#5248) and replayed Anthropic thinking stays valid.
 */

const WORKSPACE_ID = "workspace-memory-context-test";

/** A context whose index names `label`, so assertions can tell builds apart. */
function contextNamed(label: string): MemorySessionContext {
  return { indexEntries: [{ path: `/memories/global/${label}.md`, description: "note" }] };
}

function nameOf(context: MemorySessionContext | undefined): string | undefined {
  return context?.indexEntries[0]?.path;
}

async function createSession(args: {
  historyService: HistoryService;
  config: Config;
  buildMemorySessionContext: AIService["buildMemorySessionContext"];
  isExperimentEnabled?: AIService["isExperimentEnabled"];
  aiEmitter?: EventEmitter;
}): Promise<AgentSession> {
  const { session } = await createAgentSessionHarness({
    workspaceId: WORKSPACE_ID,
    config: args.config,
    historyService: args.historyService,
    aiEmitter: args.aiEmitter,
    aiServiceOverrides: {
      getWorkspaceMetadata: mock(() => Promise.resolve(Err("metadata unavailable"))),
      buildMemorySessionContext: args.buildMemorySessionContext,
      isExperimentEnabled: args.isExperimentEnabled ?? (() => false),
    },
  });
  return session;
}

interface PrivateSessionAccess {
  resolveMemoryContext: (
    modelString: string,
    cache?: Map<string, unknown>,
    persistence?: { windowKey: string | undefined }
  ) => Promise<MemorySessionContext | undefined>;
  consumePendingPostCompactionState: () => Promise<void>;
  clearPostCompactionState: () => Promise<void>;
  applyContextResetSideEffects: () => Promise<void>;
}

/** Resolve as a stream of the context window whose first history row is `windowKey`. */
function resolveInWindow(
  session: AgentSession,
  modelString: string,
  windowKey = "window-1"
): Promise<MemorySessionContext | undefined> {
  return (session as unknown as PrivateSessionAccess).resolveMemoryContext(modelString, undefined, {
    windowKey,
  });
}

async function writePendingPostCompactionState(sessionDir: string): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "post-compaction.json"),
    JSON.stringify({ version: 1, createdAt: Date.now(), diffs: [], loadedSkills: [] })
  );
}

describe("AgentSession memory context", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("keeps the window's context after a memory write", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve(contextNamed(`v${version}`));
    });
    const aiEmitter = new EventEmitter();
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
      aiEmitter,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      const first = await priv.resolveMemoryContext("test-model");
      // The agent's own successful write: before #5248 this rebuilt the index,
      // rewriting the memory tool description.
      aiEmitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId: WORKSPACE_ID,
        messageId: "assistant-1",
        toolCallId: "call-1",
        toolName: "memory",
        result: { success: true },
        timestamp: Date.now(),
      });
      await Promise.resolve();
      expect(await priv.resolveMemoryContext("test-model")).toEqual(first);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test.each(["reset", "new segment"] as const)(
    "rebuilds the context at a %s window boundary",
    async (boundary) => {
      const { historyService, config, cleanup } = await createTestHistoryService();
      historyCleanup = cleanup;

      let version = 0;
      const buildMemorySessionContext = mock(() => {
        version++;
        return Promise.resolve(contextNamed(`v${version}`));
      });
      const session = await createSession({ historyService, config, buildMemorySessionContext });
      const priv = session as unknown as PrivateSessionAccess;

      try {
        const first = await priv.resolveMemoryContext("test-model");
        // Rollover and manual reset share applyContextResetSideEffects; a full
        // history clear or destructive replace starts a new segment.
        if (boundary === "reset") await priv.applyContextResetSideEffects();
        else await priv.clearPostCompactionState();
        const next = await priv.resolveMemoryContext("test-model");
        expect(next).not.toEqual(first);
        expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
      } finally {
        await session.dispose();
      }
    }
  );

  test("caches memory context separately per model", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock((_workspaceId: string, modelString: string) =>
      Promise.resolve(contextNamed(modelString))
    );
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(nameOf(await priv.resolveMemoryContext("model-a"))).toBe(
        "/memories/global/model-a.md"
      );
      expect(nameOf(await priv.resolveMemoryContext("model-b"))).toBe(
        "/memories/global/model-b.md"
      );
      expect(nameOf(await priv.resolveMemoryContext("model-a"))).toBe(
        "/memories/global/model-a.md"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("caches the absence of memory context without re-querying per turn", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(() => Promise.resolve(null));
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test("invalidates a Memory gate change without losing model-specific caching", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    let memoryEnabled = true;
    const buildMemorySessionContext = mock<AIService["buildMemorySessionContext"]>(
      (_workspace, model) => Promise.resolve(memoryEnabled ? contextNamed(model) : null)
    );
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
      isExperimentEnabled: (id) => id === EXPERIMENT_IDS.MEMORY && memoryEnabled,
    });
    const priv = session as unknown as PrivateSessionAccess;
    try {
      expect(nameOf(await priv.resolveMemoryContext("primary"))).toBe(
        "/memories/global/primary.md"
      );
      await priv.resolveMemoryContext("primary");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
      expect(nameOf(await priv.resolveMemoryContext("fallback"))).toBe(
        "/memories/global/fallback.md"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
      memoryEnabled = false;
      expect(await priv.resolveMemoryContext("primary")).toBeUndefined();
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(3);
      memoryEnabled = true;
      expect(nameOf(await priv.resolveMemoryContext("primary"))).toBe(
        "/memories/global/primary.md"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(4);
    } finally {
      await session.dispose();
    }
  });

  // A server restart creates a new AgentSession for the same context window. Before the
  // context was saved in the session dir, the restart rebuilt it from memory files that
  // other agents had changed. Anthropic then rejected every replayed thinking block ("The
  // `system` prompt / `tools` list differs"), and the prompt cache missed.
  test("keeps the window's context across a server restart", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve(contextNamed(`v${version}`));
    });

    const before = await createSession({ historyService, config, buildMemorySessionContext });
    let first: MemorySessionContext | undefined;
    try {
      first = await resolveInWindow(before, "test-model");
    } finally {
      await before.dispose();
    }

    const after = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect(await resolveInWindow(after, "test-model")).toEqual(first);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
      // A model the old process never resolved still gets its own fresh context.
      expect(nameOf(await resolveInWindow(after, "other-model"))).toBe("/memories/global/v2.md");
    } finally {
      await after.dispose();
    }
  });

  // An upgrade from a build with the Memory Hot Set experiment: its file carries three
  // retired fields. The saved context must still be reused, or the rebuilt index can change
  // and Anthropic rejects the replayed thinking blocks.
  test.each([
    ["index-only", { includesHotMemories: false, hotMemoriesBlock: null }],
    [
      "hot block",
      { includesHotMemories: true, hotMemoriesBlock: "<hot_memories>x</hot_memories>" },
    ],
  ] as const)("reuses a context saved by a Hot Set build (%s)", async (_label, saved) => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const sessionDir = path.join(config.sessionsDir, WORKSPACE_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    const indexEntries = [{ path: "/memories/global/saved.md", description: "note" }];
    await fs.writeFile(
      path.join(sessionDir, MEMORY_CONTEXT_FILE_NAME),
      JSON.stringify({
        version: 1,
        windowKey: "window-1",
        contexts: {
          "test-model": {
            context: { indexEntries, hotMemoriesBlock: saved.hotMemoriesBlock },
            includesHotMemories: saved.includesHotMemories,
            memoryEnabled: true,
            hotSetEnabled: false,
          },
        },
      })
    );
    const buildMemorySessionContext = mock(() => Promise.resolve(contextNamed("rebuilt")));
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
      isExperimentEnabled: (id) => id === EXPERIMENT_IDS.MEMORY,
    });
    try {
      expect(await resolveInWindow(session, "test-model")).toStrictEqual({ indexEntries });
      expect(buildMemorySessionContext).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  });

  test.each(["reset", "new segment", "compaction"] as const)(
    "rebuilds after a restart when a %s boundary ended the saved window",
    async (boundary) => {
      const { historyService, config, cleanup } = await createTestHistoryService();
      historyCleanup = cleanup;

      let version = 0;
      const buildMemorySessionContext = mock(() => {
        version++;
        return Promise.resolve(contextNamed(`v${version}`));
      });

      const before = await createSession({ historyService, config, buildMemorySessionContext });
      try {
        const priv = before as unknown as PrivateSessionAccess;
        await resolveInWindow(before, "test-model");
        if (boundary === "reset") await priv.applyContextResetSideEffects();
        else if (boundary === "new segment") await priv.clearPostCompactionState();
        else {
          await writePendingPostCompactionState(path.join(config.sessionsDir, WORKSPACE_ID));
          await priv.consumePendingPostCompactionState();
        }
      } finally {
        await before.dispose();
      }

      const after = await createSession({ historyService, config, buildMemorySessionContext });
      try {
        expect(nameOf(await resolveInWindow(after, "test-model"))).toBe("/memories/global/v2.md");
      } finally {
        await after.dispose();
      }
    }
  );

  // A file can outlive its window: a failed delete, or an older build that crossed a
  // boundary without knowing the file. The next window's first row differs, so it is ignored.
  test("rebuilds after a restart when the saved file names another window", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve(contextNamed(`v${version}`));
    });
    const before = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      await resolveInWindow(before, "test-model", "window-1");
    } finally {
      await before.dispose();
    }

    const after = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect(nameOf(await resolveInWindow(after, "test-model", "window-2"))).toBe(
        "/memories/global/v2.md"
      );
    } finally {
      await after.dispose();
    }
  });

  test("retries a failed save on the next cache hit", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve(contextNamed(`v${version}`));
    });
    // A directory at the file's path makes the first write fail.
    const filePath = path.join(config.sessionsDir, WORKSPACE_ID, MEMORY_CONTEXT_FILE_NAME);
    await fs.mkdir(filePath, { recursive: true });
    const before = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      await resolveInWindow(before, "test-model");
      await fs.rm(filePath, { recursive: true });
      await resolveInWindow(before, "test-model");
    } finally {
      await before.dispose();
    }

    const after = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect(nameOf(await resolveInWindow(after, "test-model"))).toBe("/memories/global/v1.md");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await after.dispose();
    }
  });

  // History deserialization accepts an empty row id. A corrupted first row must only skip
  // persistence, not fail every send of the workspace.
  test("builds the context without saving when the window key is blank", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(() => Promise.resolve(contextNamed("v1")));
    const session = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect(nameOf(await resolveInWindow(session, "test-model", ""))).toBe(
        "/memories/global/v1.md"
      );
    } finally {
      await session.dispose();
    }
  });

  test("rebuilds the context when the saved file is malformed", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const sessionDir = path.join(config.sessionsDir, WORKSPACE_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, MEMORY_CONTEXT_FILE_NAME), "{not json");
    const buildMemorySessionContext = mock(() => Promise.resolve(contextNamed("fresh")));
    const session = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect(nameOf(await resolveInWindow(session, "test-model"))).toBe(
        "/memories/global/fresh.md"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test("recomputes the context after a compaction boundary is consumed", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 1;
    const buildMemorySessionContext = mock(() => Promise.resolve(contextNamed(`v${version}`)));
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(nameOf(await priv.resolveMemoryContext("test-model"))).toBe("/memories/global/v1.md");

      // Consume a pending compaction boundary (first stream after compaction).
      version = 2;
      await writePendingPostCompactionState(path.join(config.sessionsDir, WORKSPACE_ID));
      await priv.consumePendingPostCompactionState();

      expect(nameOf(await priv.resolveMemoryContext("test-model"))).toBe("/memories/global/v2.md");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });
});
